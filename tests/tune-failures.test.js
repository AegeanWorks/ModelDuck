import assert from "node:assert/strict";
import test from "node:test";

import { FAILURE_CLASSES, failureClass, formatFailures, summarizeFailures } from "../benchmarks/tune-failures.mjs";
import { createEvaluator } from "../benchmarks/tune-evaluate.mjs";

const check = (passed, detail) => ({ type: "jsTests", passed, unreadable: false, detail });
const evaluation = (checks, unreadable = false) => ({ passed: checks.filter((c) => c.passed).length, total: checks.length, unreadable, checks });

test("a fully passing answer has no failure class", () => {
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: evaluation([check(true, "f(1): ok")]) }), null);
});

test("each way an answer fails gets one class, the cause before the symptom", () => {
  const wrong = evaluation([check(true, "f(1): ok"), check(false, "f(2): got 3")]);
  assert.equal(failureClass({ text: "x", stopReason: "maxTokens", evaluation: wrong }), "truncated", "cut off by the token budget");
  assert.equal(failureClass({ text: "  ", stopReason: "eogToken", evaluation: evaluation([check(false, "f(1): no results")]) }), "empty");
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: evaluation([check(false, "f(1): function not found")], true) }), "unreadable");
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: evaluation([check(false, "f(1): timed out")]) }), "timeout");
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: evaluation([check(false, "f(1): did not run (syntax or runtime error)")]) }), "crash");
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: evaluation([check(false, "f(1): threw boom")]) }), "threw");
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: wrong }), "wrong");
  assert.equal(failureClass({ text: "x", stopReason: "eogToken", evaluation: evaluation([{ type: "exact", passed: false }]) }), "wrong", "a failed text check is a wrong answer");
  assert.equal(failureClass({ error: "load failed" }), "error");
  for (const name of ["truncated", "empty", "unreadable", "timeout", "crash", "threw", "wrong", "error"]) assert.ok(FAILURE_CLASSES.includes(name));
});

test("the summary counts failing answers per task and class, and says how many passed", () => {
  const rows = [
    { task: "code", failure: "wrong" }, { task: "code", failure: "wrong" }, { task: "code", failure: "truncated" },
    { task: "code", failure: null }, { task: "recall", failure: "wrong" }, { task: "code", failure: undefined },
  ];
  const summary = summarizeFailures(rows);
  assert.deepEqual(summary.code, { answers: 4, failing: 3, classes: { wrong: 2, truncated: 1 } }, "rows without a class (cached answers) are not counted");
  assert.deepEqual(summary.recall, { answers: 1, failing: 1, classes: { wrong: 1 } });
});

test("the report line names the share of each class, largest first, and a hint for the levers that exist", () => {
  const line = formatFailures({ code: { answers: 50, failing: 20, classes: { wrong: 15, truncated: 4, crash: 1 } } });
  assert.match(line, /^Why code answers failed \(20 of 50\): wrong 75% · truncated 20% · crash 5%/);
  assert.match(line, /maxTokens/, "a truncation share points at the token budget");
  assert.equal(formatFailures({}), "");
  const logic = formatFailures({ code: { answers: 10, failing: 5, classes: { wrong: 5 } } });
  assert.match(logic, /settings cannot fix wrong logic/i);
});

test("the evaluator reports the failure class with every answer", async () => {
  const engine = {
    async load() {}, async reconfigure() {}, async status() { return { memory: null }; },
    async chat() { return { text: "```js\nfunction sumTo(n) { return 0; }\n```", stats: { ms: 5, stopReason: "eogToken" } }; },
    dropSession() {},
  };
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  const out = await evaluate({ contextSize: 4096, threads: 4, batchSize: 512, kvCache: "f16", temperature: 0, maxTokens: 64 }, ["read-sumTo-1"], 1);
  assert.ok(FAILURE_CLASSES.includes(out.prompts[0].failure) || out.prompts[0].failure === null);
  assert.equal("failure" in out.prompts[0], true);
});
