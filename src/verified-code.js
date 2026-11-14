import { randomUUID } from "node:crypto";

import { extractCode, runJavaScriptTests } from "../benchmarks/suite.mjs";
import { AppError } from "./errors.js";

/**
 * Verified code: ask for code, run the caller's tests on the reply in the
 * `node --permission` sandbox, and retry until an answer passes. Measured on
 * Qwen2.5 Coder 1.5B (134 code items): one answer solved 60.4%, four
 * test-checked answers 70.9%, five 73.1%. Telling the model why it failed added nothing
 * over asking again, so a retry is the same question in a new conversation
 * with a new seed.
 */

/** Caps on what a caller may ask the machine to generate and run. */
export const VERIFY_LIMITS = Object.freeze({
  attempts: 8,
  cases: 50,
  messages: 40,
  promptChars: 64_000,
  setupChars: 64_000,
  minTokens: 16,
  maxTokens: 8192,
});

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function invalid(why) {
  return new AppError("The verify request is invalid", {
    code: "verify_invalid",
    status: 400,
    why,
    fix: "Send { prompt | messages, tests: { entry, cases: [{ args: [...], expect }], setup? }, attempts? }.",
  });
}

function numberIn(value, name, min, max, fallback, { whole = false } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (whole && !Number.isInteger(number))) {
    throw invalid(`${name} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`);
  }
  return number;
}

/** Retries at temperature 0 would repeat the first answer, so the retry temperature is above 0. */
function retryTemperature(value) {
  const temperature = numberIn(value, "retry_temperature", 0, 2, 0.7);
  if (temperature <= 0) throw invalid("retry_temperature must be above 0 and at most 2; at 0 every retry repeats the first answer.");
  return temperature;
}

function parseMessages(body) {
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return { messages: [{ role: "user", content: body.prompt }], systemPrompt: null };
  }
  if (!Array.isArray(body.messages) || !body.messages.length) throw invalid("Send a prompt or messages.");
  if (body.messages.length > VERIFY_LIMITS.messages) throw invalid(`Send at most ${VERIFY_LIMITS.messages} messages.`);
  const system = [];
  const messages = [];
  for (const message of body.messages) {
    if (!["system", "user", "assistant"].includes(message?.role)) throw invalid(`A message role must be system, user or assistant, not "${message?.role}".`);
    if (typeof message.content !== "string") throw invalid("Every message content must be a string.");
    if (message.role === "system") system.push(message.content);
    else messages.push({ role: message.role, content: message.content });
  }
  if (messages.at(-1)?.role !== "user") throw invalid("The last message must be from the user.");
  return { messages, systemPrompt: system.length ? system.join("\n\n") : null };
}

function parseTests(tests) {
  if (!tests || typeof tests !== "object") throw invalid("Send tests: { entry, cases }.");
  if ("harness" in tests) throw invalid("tests.harness is not accepted; call the function through its cases.");
  if (typeof tests.entry !== "string" || !IDENTIFIER.test(tests.entry)) throw invalid("tests.entry must be one function name, such as \"parseCsv\".");
  if (!Array.isArray(tests.cases) || tests.cases.length < 1 || tests.cases.length > VERIFY_LIMITS.cases) {
    throw invalid(`tests.cases must hold 1 to ${VERIFY_LIMITS.cases} cases.`);
  }
  const cases = tests.cases.map((testCase, index) => {
    if (!Array.isArray(testCase?.args)) throw invalid(`tests.cases[${index}].args must be an array of arguments.`);
    if (!("expect" in testCase)) throw invalid(`tests.cases[${index}].expect is missing.`);
    return { args: testCase.args, expect: testCase.expect };
  });
  const setup = tests.setup ?? "";
  if (typeof setup !== "string" || setup.length > VERIFY_LIMITS.setupChars) throw invalid(`tests.setup must be code of at most ${VERIFY_LIMITS.setupChars} characters.`);
  return { entry: tests.entry, cases, setup };
}

/** Validate a verify request; throws a 400 AppError naming the first problem. */
export function parseVerifyRequest(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("The body must be a JSON object.");
  const { messages, systemPrompt } = parseMessages(body);
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0) + (systemPrompt?.length ?? 0);
  if (chars > VERIFY_LIMITS.promptChars) throw invalid(`The conversation is too long: ${chars} characters, at most ${VERIFY_LIMITS.promptChars}.`);
  if (!body.tests) throw invalid("Send tests: { entry, cases } so answers can be checked.");
  return {
    messages,
    systemPrompt,
    tests: parseTests(body.tests),
    attempts: numberIn(body.attempts, "attempts", 1, VERIFY_LIMITS.attempts, 4, { whole: true }),
    retryTemperature: retryTemperature(body.retry_temperature),
    maxTokens: numberIn(body.max_tokens, "max_tokens", VERIFY_LIMITS.minTokens, VERIFY_LIMITS.maxTokens, null, { whole: true }),
    seed: numberIn(body.seed, "seed", 0, 2 ** 31 - 1, 42, { whole: true }),
  };
}

/**
 * Up to `request.attempts` tries: the first with the given settings (a tuned
 * code preset is greedy), later ones at the retry temperature with a new seed,
 * each in its own conversation. Returns the first answer that passes every
 * case, or the try that passed the most. An engine error before the first
 * try is thrown, never counted as a failed try.
 *
 * The loop stops early, setting `stopped`, when the caller's `signal` aborts
 * ("client_closed"; the running answer is aborted too), when no time is left
 * of `deadlineMs` for the whole request ("deadline"), or when another reply
 * takes the engine after at least one try ("engine_busy"). A stopped run
 * returns the best try so far.
 */
export async function runVerified({
  engine, request, settings, runTests = runJavaScriptTests, signal = null,
  timeoutMs = 120_000, deadlineMs = 300_000, clock = Date.now,
}) {
  const check = { type: "jsTests", entry: request.tests.entry, cases: request.tests.cases, setup: request.tests.setup };
  const base = `verify-${randomUUID()}`;
  const startedAt = clock();
  const attempts = [];
  let best = null;
  let stopped = null;
  for (let attempt = 0; attempt < request.attempts; attempt += 1) {
    if (signal?.aborted) { stopped = "client_closed"; break; }
    const left = deadlineMs - (clock() - startedAt);
    if (left <= 0) { stopped = "deadline"; break; }
    const conversationId = `${base}-${attempt}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, left));
    const abortFromCaller = () => controller.abort();
    if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
    let result;
    try {
      result = await engine.chat({
        conversationId,
        messages: request.messages.map((message) => ({ ...message })),
        systemPrompt: request.systemPrompt ?? settings.systemPrompt,
        settings: {
          ...settings,
          ...(attempt > 0 && { temperature: request.retryTemperature }),
          seed: request.seed + attempt,
          ...(request.maxTokens && { maxTokens: request.maxTokens }),
        },
        signal: controller.signal,
        onToken: () => {},
      });
    } catch (error) {
      if (signal?.aborted) { stopped = "client_closed"; break; }
      if (error?.code === "generation_in_progress" && attempts.length > 0) { stopped = "engine_busy"; break; }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      engine.dropSession?.(conversationId);
    }
    const aborted = Boolean(result?.aborted) || result?.stats?.stopReason === "abort";
    const usage = { outputTokens: result?.stats?.outputTokens ?? null, ms: result?.stats?.ms ?? null };
    if (signal?.aborted) {
      // Nobody is left to read the answer, so its tests are not run.
      attempts.push({ attempt: attempt + 1, passed: 0, total: check.cases.length, aborted: true, ...usage });
      stopped = "client_closed";
      break;
    }
    const text = String(result?.text ?? "");
    const tests = (await runTests(text, check)).map(({ passed, unreadable, detail }) => ({ passed: Boolean(passed), unreadable: Boolean(unreadable), detail: String(detail ?? "") }));
    const passed = tests.filter((test) => test.passed).length;
    attempts.push({ attempt: attempt + 1, passed, total: tests.length, aborted, ...usage });
    if (!best || passed > best.passed) best = { attempt: attempt + 1, text, tests, passed };
    if (passed === tests.length) break;
  }
  const sum = (key) => attempts.reduce((total, attempt) => total + (attempt[key] ?? 0), 0);
  return {
    passed: best ? best.passed === best.tests.length : false,
    attempt: best?.attempt ?? null,
    text: best?.text ?? "",
    code: best ? extractCode(best.text, request.tests.entry) : "",
    tests: best?.tests ?? [],
    attempts,
    ...(stopped && { stopped }),
    usage: { outputTokens: sum("outputTokens"), ms: sum("ms") },
  };
}
