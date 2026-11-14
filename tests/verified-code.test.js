import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_LIMITS, parseVerifyRequest, runVerified } from "../src/verified-code.js";

const TESTS = { entry: "double", cases: [{ args: [1], expect: 2 }, { args: [5], expect: 10 }] };
const fence = (code) => `\`\`\`js\n${code}\n\`\`\``;
const WRONG = fence("function double(n) { return n + 2; }");
const RIGHT = fence("function double(n) { return n * 2; }");

const refused = (body, pattern) => assert.throws(() => parseVerifyRequest(body), (error) => error.code === "verify_invalid" && error.status === 400 && pattern.test(error.why));

test("a request takes a prompt or chat messages, the tests, and sensible defaults", () => {
  const simple = parseVerifyRequest({ prompt: "Write double(n).", tests: TESTS });
  assert.deepEqual(simple.messages, [{ role: "user", content: "Write double(n)." }]);
  assert.equal(simple.systemPrompt, null);
  assert.equal(simple.attempts, 4, "four tries: the measured sweet spot");
  assert.equal(simple.retryTemperature, 0.7);
  assert.deepEqual(simple.tests, { entry: "double", cases: TESTS.cases, setup: "" });
  const chat = parseVerifyRequest({
    messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Write double(n)." }],
    tests: { ...TESTS, setup: "const helper = 1;" },
    attempts: 2, retry_temperature: 0.4, max_tokens: 300, seed: 9,
  });
  assert.equal(chat.systemPrompt, "Be brief.");
  assert.deepEqual(chat.messages.map((message) => message.role), ["user"]);
  assert.deepEqual([chat.attempts, chat.retryTemperature, chat.maxTokens, chat.seed], [2, 0.4, 300, 9]);
  assert.equal(chat.tests.setup, "const helper = 1;");
});

test("anything that could escape the harness or exhaust the machine is refused", () => {
  refused({ tests: TESTS }, /prompt or messages/);
  refused({ prompt: "x" }, /tests/);
  refused({ prompt: "x", tests: { ...TESTS, entry: "process.exit" } }, /entry/);
  refused({ prompt: "x", tests: { ...TESTS, entry: "a;b" } }, /entry/);
  refused({ prompt: "x", tests: { ...TESTS, cases: [] } }, /cases/);
  refused({ prompt: "x", tests: { ...TESTS, cases: Array.from({ length: VERIFY_LIMITS.cases + 1 }, () => ({ args: [], expect: 0 })) } }, /cases/);
  refused({ prompt: "x", tests: { ...TESTS, cases: [{ args: 1, expect: 2 }] } }, /args/);
  refused({ prompt: "x", tests: { ...TESTS, cases: [{ args: [1] }] } }, /expect/);
  refused({ prompt: "x", tests: { ...TESTS, harness: "anything" } }, /harness/);
  refused({ prompt: "x", tests: { ...TESTS, setup: "x".repeat(VERIFY_LIMITS.setupChars + 1) } }, /setup/);
  refused({ prompt: "x", tests: TESTS, attempts: VERIFY_LIMITS.attempts + 1 }, /attempts/);
  refused({ prompt: "x", tests: TESTS, attempts: 0 }, /attempts/);
  refused({ prompt: "x", tests: TESTS, retry_temperature: 3 }, /retry_temperature/);
  refused({ messages: [{ role: "assistant", content: "hi" }], tests: TESTS }, /last message/);
  refused({ messages: [{ role: "tool", content: "hi" }, { role: "user", content: "x" }], tests: TESTS }, /role/);
  refused({ prompt: "x".repeat(VERIFY_LIMITS.promptChars + 1), tests: TESTS }, /long/);
});

/** An engine double and a test runner that passes a reply containing "n * 2". */
function harness(replies) {
  const engine = { requests: [], dropped: [] };
  engine.chat = async (request) => {
    const { onToken: _onToken, signal: _signal, ...data } = request;
    engine.requests.push(structuredClone(data));
    const reply = replies[engine.requests.length - 1];
    if (reply instanceof Error) throw reply;
    return { text: reply, stats: { outputTokens: 12, ms: 30 } };
  };
  engine.dropSession = (id) => engine.dropped.push(id);
  const runs = [];
  const runTests = async (text, check) => {
    runs.push(check);
    const good = text.includes("n * 2");
    return check.cases.map((testCase) => ({ passed: good, unreadable: false, detail: good ? "ok" : "got wrong" }));
  };
  return { engine, runTests, runs };
}

const SETTINGS = { temperature: 0, topP: 0.9, maxTokens: 512, systemPrompt: "default system" };

test("the first answer is greedy; retries sample anew; the first passing answer wins and stops the loop", async () => {
  const { engine, runTests, runs } = harness([WRONG, WRONG, RIGHT, RIGHT]);
  const request = parseVerifyRequest({ prompt: "Write double(n).", tests: TESTS, seed: 5 });
  const out = await runVerified({ engine, request, settings: SETTINGS, runTests });
  assert.equal(out.passed, true);
  assert.equal(out.attempt, 3);
  assert.equal(out.text, RIGHT);
  assert.equal(out.code, "function double(n) { return n * 2; }");
  assert.deepEqual(out.attempts.map((attempt) => `${attempt.passed}/${attempt.total}`), ["0/2", "0/2", "2/2"]);
  assert.equal(engine.requests.length, 3, "nothing is asked after a pass");
  assert.deepEqual(engine.requests.map((request) => request.settings.temperature), [0, 0.7, 0.7]);
  assert.deepEqual(engine.requests.map((request) => request.settings.seed), [5, 6, 7], "a new seed per try");
  assert.equal(new Set(engine.requests.map((request) => request.conversationId)).size, 3, "each try is a new conversation");
  assert.deepEqual(engine.requests[2].messages, [{ role: "user", content: "Write double(n)." }], "no feedback: retrying measured as well as feedback");
  assert.equal(engine.requests[0].systemPrompt, "default system");
  assert.equal(engine.dropped.length, 3);
  assert.deepEqual(runs[0], { type: "jsTests", entry: "double", cases: TESTS.cases, setup: "" });
  assert.deepEqual(out.usage, { outputTokens: 36, ms: 90 });
});

test("when no try passes, the best try comes back marked as failing", async () => {
  // The second answer gets the first case right and the second wrong; the first gets neither.
  const HALF = fence("function double(n) { return n === 1 ? 2 : 0; }");
  const { engine } = harness([WRONG, HALF]);
  const partial = async (text, check) => check.cases.map((testCase, index) => ({ passed: text === HALF && index === 0, unreadable: false, detail: "x" }));
  const request = parseVerifyRequest({ prompt: "x", tests: TESTS, attempts: 2 });
  const out = await runVerified({ engine, request, settings: SETTINGS, runTests: partial });
  assert.equal(out.passed, false);
  assert.equal(out.attempt, 2, "the try that passed the most tests");
  assert.equal(out.text, HALF);
  assert.equal(out.tests.filter((result) => result.passed).length, 1);
});

test("a busy or broken engine is an error, not a silent failed try", async () => {
  const { engine, runTests } = harness([new Error("The duck is already answering")]);
  const request = parseVerifyRequest({ prompt: "x", tests: TESTS, attempts: 3 });
  await assert.rejects(() => runVerified({ engine, request, settings: SETTINGS, runTests }), /already answering/);
  assert.equal(engine.dropped.length, 1, "the session is released anyway");
});

test("the caller's own system prompt and token budget win over the defaults", async () => {
  const { engine, runTests } = harness([RIGHT]);
  const request = parseVerifyRequest({ messages: [{ role: "system", content: "mine" }, { role: "user", content: "x" }], tests: TESTS, max_tokens: 99 });
  await runVerified({ engine, request, settings: SETTINGS, runTests });
  assert.equal(engine.requests[0].systemPrompt, "mine");
  assert.equal(engine.requests[0].settings.maxTokens, 99);
});

// --- robustness (review findings 9-14) ----------------------------------------------------

test("a null or non-object body is a 400, not a crash", () => {
  for (const body of [null, "text", 5, []]) {
    assert.throws(() => parseVerifyRequest(body), (error) => error.code === "verify_invalid" && error.status === 400, `refuses ${JSON.stringify(body)}`);
  }
});

test("retries at temperature 0 would repeat the first answer, so 0 is refused", () => {
  refused({ prompt: "x", tests: TESTS, retry_temperature: 0 }, /retry_temperature/);
  assert.equal(parseVerifyRequest({ prompt: "x", tests: TESTS, retry_temperature: 0.05 }).retryTemperature, 0.05);
});

test("a client that goes away stops the loop: the running answer is aborted and nothing more is asked", async () => {
  const controller = new AbortController();
  const engine = { requests: [], dropped: [] };
  engine.chat = async (request) => {
    engine.requests.push(request.conversationId);
    controller.abort();
    assert.equal(request.signal.aborted, true, "the client's abort reaches the running answer");
    return { text: WRONG, aborted: true, stats: { outputTokens: 3, ms: 5, stopReason: "abort" } };
  };
  engine.dropSession = (id) => engine.dropped.push(id);
  const { runTests } = harness([]);
  const request = parseVerifyRequest({ prompt: "x", tests: TESTS, attempts: 4 });
  const out = await runVerified({ engine, request, settings: SETTINGS, runTests, signal: controller.signal });
  assert.equal(engine.requests.length, 1);
  assert.equal(out.stopped, "client_closed");
  assert.equal(out.attempts[0].aborted, true, "a cut-off answer is flagged");
  assert.equal(engine.dropped.length, 1);
});

test("the whole request has a deadline; no new try starts after it", async () => {
  let now = 0;
  const { engine, runTests } = harness([WRONG, WRONG, WRONG, RIGHT]);
  const chat = engine.chat;
  engine.chat = async (request) => { now += 40_000; return chat(request); };
  const request = parseVerifyRequest({ prompt: "x", tests: TESTS, attempts: 4 });
  const out = await runVerified({ engine, request, settings: SETTINGS, runTests, clock: () => now, deadlineMs: 100_000 });
  assert.equal(engine.requests.length, 3, "the fourth try would start after 100 s");
  assert.equal(out.stopped, "deadline");
  assert.equal(out.passed, false);
});

test("an engine taken by another reply mid-run returns the best try so far, marked partial", async () => {
  const busy = Object.assign(new Error("The duck is already answering"), { code: "generation_in_progress", status: 409 });
  const { engine, runTests } = harness([WRONG, busy]);
  const request = parseVerifyRequest({ prompt: "x", tests: TESTS, attempts: 4 });
  const out = await runVerified({ engine, request, settings: SETTINGS, runTests });
  assert.equal(out.stopped, "engine_busy");
  assert.equal(out.attempts.length, 1);
  assert.equal(out.text, WRONG, "the earlier try is kept");
});
