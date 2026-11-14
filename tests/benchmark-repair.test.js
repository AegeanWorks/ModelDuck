import assert from "node:assert/strict";
import test from "node:test";

import { feedbackFor, repairEligible, runRepair, summarizeRepair } from "../benchmarks/repair-evaluate.mjs";
import { PROMPTS, evaluateResponse } from "../benchmarks/suite.mjs";
import { taskPrompts } from "../benchmarks/tasks.mjs";

const ITEM = {
  id: "toy-double",
  category: "code",
  prompt: "Write `double(n)` that returns n * 2.",
  maxTokens: 128,
  checks: [{ type: "jsTests", entry: "double", cases: [{ args: [1], expect: 2 }, { args: [5], expect: 10 }, { args: [-3], expect: -6 }] }],
};
const fence = (code) => `\`\`\`js\n${code}\n\`\`\``;
const WRONG = fence("function double(n) { return n + 2; }");
const RIGHT = fence("function double(n) { return n * 2; }");
const ONLY_FIRST = fence("function double(n) { return n === 5 ? 10 : n + 2; }");

/** An engine double that replies from a script and records each request. */
function scriptedEngine(replies) {
  const engine = { requests: [], dropped: [] };
  engine.chat = async (request) => {
    const { onToken: _onToken, signal: _signal, ...data } = request;
    engine.requests.push(structuredClone(data));
    const reply = replies[engine.requests.length - 1];
    if (reply instanceof Error) throw reply;
    return { text: reply ?? "", stats: { ms: 4, outputTokens: 9, stopReason: "eogToken" } };
  };
  engine.dropSession = (id) => engine.dropped.push(id);
  return engine;
}

test("only items scored by one executable test check can be repaired", () => {
  assert.equal(repairEligible(ITEM), true);
  assert.equal(repairEligible({ ...ITEM, checks: [{ type: "exact", value: "1" }] }), false);
  assert.equal(repairEligible({ ...ITEM, checks: [...ITEM.checks, ...ITEM.checks] }), false);
  const code = taskPrompts("code");
  assert.ok(code.filter(repairEligible).length >= 130, "nearly every code item qualifies");
  assert.ok(PROMPTS.length > code.length);
});

test("feedback names one failing call, what it should return and what it did", async () => {
  const evaluation = await evaluateResponse(ITEM, WRONG);
  const text = feedbackFor(ITEM, evaluation);
  assert.match(text, /double\(1\)/);
  assert.match(text, /should return 2/);
  assert.match(text, /returned 3/);
  assert.doesNotMatch(text, /double\(5\)/, "only one failing case is shown, so hardcoding it cannot pass the rest");
  assert.match(text, /1 of 3 tests? pass|passes 0 of 3|0 of 3/);
  assert.match(text, /whole corrected/i);
  const none = await evaluateResponse(ITEM, RIGHT);
  assert.equal(feedbackFor(ITEM, none), null, "a passing answer needs no feedback");
});

test("feedback says plainly when the code did not run or no function was found", async () => {
  const crashed = feedbackFor(ITEM, await evaluateResponse(ITEM, fence("function double(n) { return n *; }")));
  assert.match(crashed, /did not run/);
  const missing = feedbackFor(ITEM, await evaluateResponse(ITEM, "I cannot help with that."));
  assert.match(missing, /could not find a function named `double`/);
});

test("a wrong first answer is repaired from the feedback, in one conversation", async () => {
  const engine = scriptedEngine([WRONG, RIGHT]);
  const result = await runRepair({ engine, prompt: ITEM, rounds: 2, seed: 7 });
  assert.deepEqual(result.rounds.map((round) => `${round.passed}/${round.total}`), ["0/3", "3/3"]);
  assert.equal(result.firstSolved, false);
  assert.equal(result.solvedAt, 1);
  assert.equal(engine.requests.length, 2, "it stops once every test passes");
  const second = engine.requests[1];
  assert.equal(new Set(engine.requests.map((request) => request.conversationId)).size, 1);
  assert.deepEqual(second.messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(second.messages[1].content, WRONG, "the model sees its own answer");
  assert.match(second.messages[2].content, /should return 2/);
  assert.equal(second.settings.temperature, 0, "greedy by default");
  assert.equal(second.settings.seed, 7);
  assert.deepEqual(engine.dropped, [`repair-${ITEM.id}-7`]);
});

test("a correct first answer asks nothing more; an unfixable one uses every round", async () => {
  const solved = await runRepair({ engine: scriptedEngine([RIGHT]), prompt: ITEM, rounds: 2 });
  assert.equal(solved.firstSolved, true);
  assert.equal(solved.solvedAt, 0);
  assert.equal(solved.rounds.length, 1);
  const stuck = scriptedEngine([WRONG, ONLY_FIRST, WRONG]);
  const failed = await runRepair({ engine: stuck, prompt: ITEM, rounds: 2 });
  assert.equal(failed.solvedAt, null);
  assert.equal(failed.rounds.length, 3, "the first answer and two repairs");
  assert.equal(failed.rounds[1].passed, 1, "hardcoding the shown case passes it and nothing else");
  assert.equal(failed.rounds[1].failure, "wrong");
});

test("an engine error ends the item with what it had", async () => {
  const result = await runRepair({ engine: scriptedEngine([WRONG, new Error("context full")]), prompt: ITEM, rounds: 3 });
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[1].error, "context full");
  assert.equal(result.solvedAt, null);
});

test("the summary gives the solved rate after each round, what feedback rescued and what it cost", () => {
  const result = (id, category, solvedAt, rounds) => ({ id, category, solvedAt, firstSolved: solvedAt === 0, rounds: Array.from({ length: rounds }, () => ({ outputTokens: 10, ms: 5 })) });
  const summary = summarizeRepair([
    result("a", "code", 0, 1),
    result("b", "code", 1, 2),
    result("c", "bugfix", 2, 3),
    result("d", "bugfix", null, 3),
  ], 2);
  assert.deepEqual(summary.byRound.map((round) => round.rate), [25, 50, 75]);
  assert.equal(summary.rescued, 2);
  assert.equal(summary.answers, 9);
  assert.equal(summary.items, 4);
  assert.deepEqual(summary.byCategory.bugfix, { items: 2, first: 0, final: 1 });
});

test("the CLI report says the rate after each round, what was rescued and per type", async () => {
  const { repairReport } = await import("../benchmarks/repair-run.mjs");
  const summary = summarizeRepair([
    { id: "a", category: "code", solvedAt: 0, firstSolved: true, rounds: [{}] },
    { id: "b", category: "bugfix", solvedAt: 1, firstSolved: false, rounds: [{}, {}] },
  ], 1);
  assert.equal(repairReport(summary), [
    "Repair: first answer 1/2 (50%) · after repair 1 2/2 (100%)",
    "Feedback rescued 1 items for 1 extra answers",
    "By type (first → final): code 1→1/1 · bugfix 0→1/1",
  ].join("\n"));
  const retry = summarizeRepair([{ id: "a", category: "code", mode: "retry", solvedAt: 1, firstSolved: false, rounds: [{}, {}] }], 1);
  assert.match(repairReport(retry), /^Retries rescued 1 items/m, "the control is not called feedback");
});

test("a repair that resends the previous answer word for word is marked as resent", async () => {
  const result = await runRepair({ engine: scriptedEngine([WRONG, WRONG, RIGHT]), prompt: ITEM, rounds: 2 });
  assert.deepEqual(result.rounds.map((round) => round.resent), [false, true, false]);
  assert.equal(result.solvedAt, 2);
  const summary = summarizeRepair([result], 2);
  assert.equal(summary.resent, 1);
});

test("repair rounds can sample at their own temperature; the first answer keeps its own", async () => {
  const engine = scriptedEngine([WRONG, RIGHT]);
  await runRepair({ engine, prompt: ITEM, rounds: 1, settings: { temperature: 0 }, repairTemperature: 0.7 });
  assert.equal(engine.requests[0].settings.temperature, 0);
  assert.equal(engine.requests[1].settings.temperature, 0.7);
  const unchanged = scriptedEngine([WRONG, RIGHT]);
  await runRepair({ engine: unchanged, prompt: ITEM, rounds: 1, settings: { temperature: 0.2 } });
  assert.equal(unchanged.requests[1].settings.temperature, 0.2, "without a repair temperature the answer's own is used");
});

test("feedback can show several failing calls, never more than asked", async () => {
  const evaluation = await evaluateResponse(ITEM, WRONG);
  const text = feedbackFor(ITEM, evaluation, { show: 2 });
  assert.match(text, /double\(1\)/);
  assert.match(text, /double\(5\)/);
  assert.doesNotMatch(text, /double\(-3\)/);
  assert.match(text, /failing tests/);
});

test("fresh mode asks each repair in a new conversation with the failed code quoted, not as the model's own turn", async () => {
  const engine = scriptedEngine([WRONG, RIGHT]);
  const result = await runRepair({ engine, prompt: ITEM, rounds: 1, mode: "fresh", seed: 3 });
  assert.equal(result.solvedAt, 1);
  const [first, second] = engine.requests;
  assert.notEqual(first.conversationId, second.conversationId, "a new conversation");
  assert.deepEqual(second.messages.map((message) => message.role), ["user"], "no assistant turn to repeat");
  const ask = second.messages[0].content;
  assert.ok(ask.startsWith(ITEM.prompt), "the task comes first");
  assert.ok(ask.includes("return n + 2"), "the failed code is quoted");
  assert.match(ask, /should return 2/);
  assert.match(ask, /do not send it back unchanged/i);
  assert.deepEqual(engine.dropped.sort(), [`repair-${ITEM.id}-3`, `repair-${ITEM.id}-3-r1`].sort());
  assert.throws(() => runRepair({ engine, prompt: ITEM, mode: "other" }), /mode/);
});

test("retry mode is the control: the same question again in a new conversation, no feedback, a new seed", async () => {
  const engine = scriptedEngine([WRONG, RIGHT]);
  const result = await runRepair({ engine, prompt: ITEM, rounds: 1, mode: "retry", seed: 3, repairTemperature: 0.7 });
  assert.equal(result.solvedAt, 1);
  const [first, second] = engine.requests;
  assert.notEqual(first.conversationId, second.conversationId);
  assert.deepEqual(second.messages, [{ role: "user", content: ITEM.prompt }], "nothing about the failure is said");
  assert.equal(second.settings.seed, 4, "a new seed, or a seeded sample would repeat itself");
  assert.equal(second.settings.temperature, 0.7);
});
