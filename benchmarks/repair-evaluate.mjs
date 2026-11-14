import { SYSTEM_PROMPT, allCode, evaluateResponse } from "./suite.mjs";
import { failureClass } from "./tune-failures.mjs";
import { MULTISTEP_SAMPLING } from "./multistep-evaluate.mjs";

/**
 * Repair with test feedback: the model answers, the item's tests run, and if
 * one fails the model is told which call failed, what it should return and
 * what it did, then answers again in the same conversation. Most failing code
 * is runnable code with wrong logic (78% for Qwen2.5 Coder 1.5B), which no
 * sampling setting fixes, but a model can often fix it once it sees the case.
 *
 * Only ONE failing case is shown per round, and every round is scored on all
 * cases, so an answer that hardcodes the shown case still fails the rest.
 * Opt-in and outside the tuned suite: nothing here touches PROMPTS, TASKS,
 * a hash, a profile or the gate.
 */

/** Items scored by exactly one executable test check: their cases map one-to-one to the checks. */
export function repairEligible(prompt) {
  return Array.isArray(prompt?.checks) && prompt.checks.length === 1 && prompt.checks[0].type === "jsTests" && (prompt.checks[0].cases?.length ?? 0) > 0;
}

const callOf = (entry, args) => `${entry}(${JSON.stringify(args).slice(1, -1)})`;

/** One failing case in words: the call, what it should return, and what it did. */
function describeFailure(check, testCase, detail) {
  const call = callOf(check.entry, testCase.args);
  const outcome = detail.startsWith(`${call}: `) ? detail.slice(call.length + 2) : detail;
  const what = outcome.startsWith("got ") ? `but it ${outcome.replace(/^got /, "returned ")}`
    : outcome.startsWith("threw ") ? `but it threw: ${outcome.slice(6)}`
      : outcome === "timed out" ? "but it did not finish in 5 seconds (an endless loop?)"
        : `but the code ${outcome}`;
  return `\`${call}\` should return ${JSON.stringify(testCase.expect)}, ${what}`;
}

/**
 * The message that tells the model what failed, or null when every test passed.
 * `show` caps how many failing calls are named; the rest stay unseen, so an
 * answer that hardcodes the named ones still fails them.
 */
export function feedbackFor(prompt, evaluation, { show = 1 } = {}) {
  if (!evaluation || evaluation.passed >= evaluation.total) return null;
  const check = prompt.checks[0];
  const counts = `Your code passes ${evaluation.passed} of ${evaluation.total} tests.`;
  const ask = "Fix it. Reply with the whole corrected code in one fenced block.";
  if (evaluation.unreadable) {
    return `${counts} I could not find a function named \`${check.entry}\` in your reply. ${ask}`;
  }
  const failing = evaluation.checks
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => !result.passed)
    .slice(0, Math.max(1, show))
    .map(({ result, index }) => describeFailure(check, check.cases[index], String(result.detail ?? "")));
  if (failing.length === 1) return `${counts} A failing test: ${failing[0]}. ${ask}`;
  return `${counts} Some failing tests:\n${failing.map((line) => `- ${line}`).join("\n")}\n${ask}`;
}

/**
 * One item: an answer, then up to `rounds` repairs, each with the feedback of
 * the round before. Stops as soon as every test passes. `solvedAt` is the
 * round that solved it (0 is the first answer), or null.
 */
// "retry" is the control: the same question again with a new seed and no feedback, so
// what "fresh" adds over simply sampling again and keeping a passing answer can be measured.
export const REPAIR_MODES = Object.freeze(["chat", "fresh", "retry"]);

/**
 * A repair in a new conversation: the task, the failed code quoted as text and
 * the failing tests. Measured in chat mode, a model shown its own answer as its
 * own turn sent it back word for word in most repairs; quoting it as someone's
 * failed attempt removes that turn.
 */
export function freshRepairPrompt(prompt, reply, feedback) {
  const code = allCode(reply);
  return `${prompt.prompt}\n\nThis attempt is wrong:\n\`\`\`js\n${code}\n\`\`\`\n${feedback.replace(/ Fix it\. Reply with the whole corrected code in one fenced block\.$/, "")}\nWrite a corrected version and do not send it back unchanged. Reply with the whole corrected code in one fenced block.`;
}

/**
 * `mode` "chat" keeps one conversation; "fresh" asks every repair in a new one
 * (see freshRepairPrompt). Throws at once on an unknown mode.
 */
export function runRepair({ mode = "chat", ...options }) {
  if (!REPAIR_MODES.includes(mode)) throw new Error(`Unknown repair mode "${mode}": use ${REPAIR_MODES.join(" or ")}.`);
  return repairLoop({ mode, ...options });
}

async function repairLoop({ engine, prompt, mode, rounds = 2, settings = {}, seed = 42, systemPrompt = SYSTEM_PROMPT, timeoutMs = 120_000, repairTemperature = null, show = 1 }) {
  const baseId = `repair-${prompt.id}-${seed}`;
  let conversationId = baseId;
  const used = new Set();
  let messages = [{ role: "user", content: prompt.prompt }];
  const results = [];
  let solvedAt = null;
  let previous = null;
  try {
    for (let round = 0; round <= rounds; round += 1) {
      used.add(conversationId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      let reply;
      let stats = null;
      try {
        const out = await engine.chat({
          conversationId,
          messages: messages.map((message) => ({ ...message })),
          systemPrompt,
          // Greedy decoding tends to resend its own answer; a repair may sample instead.
          settings: { ...MULTISTEP_SAMPLING, ...settings, ...(round > 0 && repairTemperature !== null && { temperature: repairTemperature }), maxTokens: settings.maxTokens ?? prompt.maxTokens ?? 512, seed: mode === "retry" ? seed + round : seed, contextOverflow: "shift" },
          signal: controller.signal,
          onToken: () => {},
        });
        reply = String(out?.text ?? "");
        stats = out?.stats ?? null;
      } catch (error) {
        results.push({ round, passed: 0, total: prompt.checks[0].cases.length, failure: "error", error: error?.message ?? String(error), resent: false, ms: Date.now() - started, outputTokens: null });
        break;
      } finally {
        clearTimeout(timer);
      }
      const evaluation = await evaluateResponse(prompt, reply);
      results.push({
        round,
        passed: evaluation.passed,
        total: evaluation.total,
        failure: failureClass({ text: reply, stopReason: stats?.stopReason ?? null, evaluation }),
        error: null,
        // The same text as the answer before it: the feedback changed nothing.
        resent: previous !== null && reply.trim() === previous.trim(),
        ms: stats?.ms ?? Date.now() - started,
        outputTokens: stats?.outputTokens ?? null,
      });
      if (evaluation.passed === evaluation.total) {
        solvedAt = round;
        break;
      }
      if (round === rounds) break;
      previous = reply;
      const feedback = feedbackFor(prompt, evaluation, { show });
      if (mode === "fresh") {
        conversationId = `${baseId}-r${round + 1}`;
        messages = [{ role: "user", content: freshRepairPrompt(prompt, reply, feedback) }];
      } else if (mode === "retry") {
        conversationId = `${baseId}-r${round + 1}`;
        messages = [{ role: "user", content: prompt.prompt }];
      } else {
        messages.push({ role: "assistant", content: reply }, { role: "user", content: feedback });
      }
    }
  } finally {
    for (const id of used) engine.dropSession?.(id);
  }
  return { id: prompt.id, category: prompt.category, mode, solvedAt, firstSolved: solvedAt === 0, rounds: results };
}

const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

/** Solved rate after each round, items feedback rescued, and the answers it cost. */
export function summarizeRepair(results, rounds) {
  const items = results.length;
  const byRound = Array.from({ length: rounds + 1 }, (_value, round) => {
    const solved = results.filter((result) => result.solvedAt !== null && result.solvedAt <= round).length;
    return { round, solved, rate: pct(solved, items) };
  });
  const byCategory = {};
  for (const result of results) {
    const entry = (byCategory[result.category] ??= { items: 0, first: 0, final: 0 });
    entry.items += 1;
    if (result.firstSolved) entry.first += 1;
    if (result.solvedAt !== null) entry.final += 1;
  }
  return {
    items,
    rounds,
    mode: results[0]?.mode ?? "chat",
    byRound,
    rescued: results.filter((result) => result.solvedAt !== null && result.solvedAt > 0).length,
    answers: results.reduce((sum, result) => sum + result.rounds.length, 0),
    resent: results.reduce((sum, result) => sum + result.rounds.filter((round) => round.resent).length, 0),
    errors: results.reduce((sum, result) => sum + result.rounds.filter((round) => round.error).length, 0),
    byCategory,
  };
}
