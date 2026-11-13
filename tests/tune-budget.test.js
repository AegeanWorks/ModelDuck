import assert from "node:assert/strict";
import test from "node:test";

import { Measurements } from "../benchmarks/tune-measure.mjs";
import { tune } from "../benchmarks/tune.mjs";
import { budgetDeadline, parseBudget } from "../benchmarks/tune-budget.mjs";

const ids = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);

/** A clock the evaluator advances: every answer costs `msPerAnswer`. */
function timedEvaluator(msPerAnswer = 1000) {
  let now = 0;
  const clock = () => now;
  const evaluate = async (settings, itemIds) => {
    now += itemIds.length * msPerAnswer;
    return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: msPerAnswer, outputTokens: 10, digest: id })) };
  };
  return { evaluate, clock };
}

test("the flag takes whole or decimal minutes and refuses the rest", () => {
  assert.equal(parseBudget("5"), 5);
  assert.equal(parseBudget("0.5"), 0.5);
  assert.equal(parseBudget(undefined), null);
  for (const bad of ["0", "-1", "abc", "1441"]) {
    assert.throws(() => parseBudget(bad), (error) => error.code === "tune_budget_invalid", `refuses ${bad}`);
  }
});

test("the deadline is the start plus the budget, and no budget means none", () => {
  assert.equal(budgetDeadline(5, { now: 1000 }), 1000 + 5 * 60_000);
  assert.equal(budgetDeadline(null, { now: 1000 }), Infinity);
});

test("measurements stop at the deadline, answer budget untouched", async () => {
  const { evaluate, clock } = timedEvaluator(1000);
  const measurements = new Measurements(evaluate, 100000, () => {}, { deadline: 2500, clock });
  assert.equal(measurements.exhausted, false);
  await measurements.measure({ kind: "a" }, ids("x", 2), 42);
  assert.equal(measurements.deadlinePassed, false, "2 s of 2.5 s");
  await measurements.measure({ kind: "b" }, ids("y", 2), 42);
  assert.equal(measurements.deadlinePassed, true);
  assert.equal(measurements.exhausted, true);
  assert.equal(await measurements.measure({ kind: "c" }, ids("z", 2), 42), null, "nothing more is asked");
  assert.equal(measurements.runs, 4);
});

test("a large rung stops a few answers past the deadline, not a whole rung past it", async () => {
  const { evaluate, clock } = timedEvaluator(1000);
  const calls = [];
  const counting = async (settings, itemIds, seed) => { calls.push(itemIds.length); return evaluate(settings, itemIds, seed); };
  const measurements = new Measurements(counting, 100000, () => {}, { deadline: 2500, clock });
  const out = await measurements.measure({ kind: "a" }, ids("x", 48), 42);
  assert.equal(out, null, "an unfinished rung is not scored");
  assert.equal(measurements.runs, 4, "one chunk of four, then the deadline stops it");
  assert.deepEqual(calls, [4]);
  // What was answered stays cached, so a later continue does not ask it again.
  const resumed = new Measurements(counting, 100000, () => {}, {});
  resumed.slots = measurements.slots;
  await resumed.measure({ kind: "a" }, ids("x", 48), 42);
  assert.equal(resumed.runs, 44);
});

test("without a deadline a rung is asked in one call, as before", async () => {
  const { evaluate } = timedEvaluator(1);
  const calls = [];
  const counting = async (settings, itemIds, seed) => { calls.push(itemIds.length); return evaluate(settings, itemIds, seed); };
  await new Measurements(counting, 100000).measure({ kind: "a" }, ids("x", 48), 42);
  assert.deepEqual(calls, [48]);
});

test("a tune with a time budget stops early, says so and keeps what it found", async () => {
  const { evaluate, clock } = timedEvaluator(1000);
  const done = await tune({
    evaluate,
    base: { contextSize: 4096, kvCache: "f16", threads: 8, temperature: 0, maxTokens: 256 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { load: [ids("mix", 8)], speed: [ids("speed", 6)], math: [ids("math", 12)] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [
      { name: "temperature", patches: [{ temperature: 0 }, { temperature: 0.6 }] },
      { name: "maxTokens", patches: [{ maxTokens: 128 }, { maxTokens: 256 }] },
    ],
    options: { seeds: [42], passes: 2, changeAlpha: Infinity, deadline: 20_000, clock },
  });
  assert.equal(done.timeExhausted, true);
  assert.equal(done.budgetExhausted, true, "a resume continues it like an answer budget");
  assert.ok(done.runs <= 20 + 12, `runs ${done.runs} stop within one rung of the deadline`);
  assert.ok(done.runs >= 12, "the first rung is measured");
});

test("without a time budget nothing changes", async () => {
  const { evaluate } = timedEvaluator(1000);
  const done = await tune({
    evaluate,
    base: { contextSize: 4096, kvCache: "f16", threads: 8, temperature: 0, maxTokens: 256 },
    tasks: [],
    stages: [],
    rungs: { load: [ids("mix", 4)] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    options: { seeds: [42], passes: 1 },
  });
  assert.equal(done.timeExhausted ?? false, false);
});
