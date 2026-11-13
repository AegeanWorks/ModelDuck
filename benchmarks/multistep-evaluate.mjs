import { createHash } from "node:crypto";

import { SYSTEM_PROMPT, allCode, evaluateResponse } from "./suite.mjs";

/** Greedy decoding by default, so a chain is repeatable; a tuned code preset can replace it. */
export const MULTISTEP_SAMPLING = Object.freeze({
  temperature: 0,
  topP: 1,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1,
  penalizeNewLine: false,
  reasoning: "off",
  promptRepeat: 1,
});

const digestOf = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

/**
 * Top-level `const x =` / `let x =` become `var x =`. Earlier replies are
 * loaded before the new one, and a model that writes `const median = ...`
 * twice would otherwise fail on a redeclaration rather than on its answer.
 * Only unindented declarations change, so loop and block scoping inside
 * functions stays exactly as written.
 */
export function relaxTopLevel(text) {
  return String(text ?? "").replace(/^(?:const|let)(\s+[A-Za-z_$][\w$]*\s*=)/gm, "var$1");
}

/** Score one step's reply with the code of the earlier steps loaded first. */
export async function scoreStep(step, reply, carried = "") {
  const check = { ...step.check, setup: [relaxTopLevel(carried), step.check.setup ?? ""].filter(Boolean).join("\n;\n") };
  return evaluateResponse({ checks: [check] }, relaxTopLevel(reply));
}

/** The code a chain carries after a reply: what it carried, then every block of the reply. */
export function carryAfter(carried, reply) {
  const code = reply ? allCode(reply) : "";
  return [carried, code].filter(Boolean).join("\n;\n");
}

/**
 * Run one chain on a real engine as one conversation: every step's request
 * holds the earlier steps and the model's own earlier replies. A step that
 * fails (or errors) still feeds its actual reply forward, because carrying its
 * own mistakes is part of what a multistep task measures. Totals are fixed per
 * chain, so a chain that breaks early scores low rather than disappearing.
 */
export async function runChain({ engine, chain, settings = {}, seed = 42, systemPrompt = SYSTEM_PROMPT, timeoutMs = 120_000, onStep = () => {} }) {
  const conversationId = `multistep-${chain.id}-${seed}`;
  const messages = [];
  const steps = [];
  let carried = "";
  try {
    for (const [index, step] of chain.steps.entries()) {
      messages.push({ role: "user", content: step.prompt });
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reply = "";
      let stats = null;
      let error = null;
      try {
        const result = await engine.chat({
          conversationId,
          messages: messages.map((message) => ({ ...message })),
          systemPrompt,
          settings: { ...MULTISTEP_SAMPLING, ...settings, maxTokens: settings.maxTokens ?? step.maxTokens, seed, contextOverflow: "shift" },
          signal: controller.signal,
          onToken: () => {},
        });
        reply = String(result?.text ?? "");
        stats = result?.stats ?? null;
      } catch (caught) {
        error = caught?.message ?? String(caught);
      } finally {
        clearTimeout(timer);
      }
      // The conversation keeps the model's real reply, even an empty or wrong one.
      messages.push({ role: "assistant", content: reply });
      const scored = error ? { passed: 0, total: step.check.cases.length, unreadable: false } : await scoreStep(step, reply, carried);
      const row = {
        step: index + 1,
        passed: scored.passed,
        total: scored.total,
        unreadable: Boolean(scored.unreadable),
        error,
        ms: stats?.ms ?? Date.now() - started,
        outputTokens: stats?.outputTokens ?? null,
        digest: error ? null : digestOf(reply),
        text: reply,
      };
      steps.push(row);
      onStep({ chain: chain.id, ...row });
      carried = carryAfter(carried, reply);
    }
  } finally {
    engine.dropSession?.(conversationId);
  }
  return scoreChain(chain.id, seed, steps);
}

/** A chain's totals: checks passed, whether every step was fully solved, and how many in a row from the start. */
export function scoreChain(id, seed, steps) {
  const passed = steps.reduce((sum, step) => sum + step.passed, 0);
  const total = steps.reduce((sum, step) => sum + step.total, 0);
  const full = steps.map((step) => step.total > 0 && step.passed === step.total);
  const firstMiss = full.indexOf(false);
  return {
    id,
    seed,
    steps,
    passed,
    total,
    rate: total ? round(passed / total) : 0,
    allSteps: full.length > 0 && full.every(Boolean),
    prefix: firstMiss === -1 ? full.length : firstMiss,
  };
}

const round = (value) => Math.round(value * 1000) / 10;

/**
 * Over many chain runs: the check rate, the share of chains solved in every
 * step, and the rate at each step depth. The depth rates show what multistep
 * work adds: a model that holds step 1 but loses step 3 forgets or breaks what
 * it built, which a single-turn suite cannot see.
 */
export function summarizeChains(results) {
  const passed = results.reduce((sum, result) => sum + result.passed, 0);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  const depth = Math.max(0, ...results.map((result) => result.steps.length));
  const byStep = Array.from({ length: depth }, (_value, index) => {
    const rows = results.map((result) => result.steps[index]).filter(Boolean);
    const stepPassed = rows.reduce((sum, row) => sum + row.passed, 0);
    const stepTotal = rows.reduce((sum, row) => sum + row.total, 0);
    return { step: index + 1, passed: stepPassed, total: stepTotal, rate: stepTotal ? round(stepPassed / stepTotal) : 0 };
  });
  return {
    runs: results.length,
    passed,
    total,
    rate: total ? round(passed / total) : 0,
    allSteps: results.filter((result) => result.allSteps).length,
    allStepsRate: results.length ? round(results.filter((result) => result.allSteps).length / results.length) : 0,
    meanPrefix: results.length ? Math.round((results.reduce((sum, result) => sum + result.prefix, 0) / results.length) * 100) / 100 : 0,
    byStep,
    errors: results.reduce((sum, result) => sum + result.steps.filter((step) => step.error).length, 0),
  };
}
