import assert from "node:assert/strict";
import test from "node:test";

import { tuneRungs, tuneRungsComputations, resetTuneRungsCache } from "../benchmarks/tasks.mjs";
import { expectedAnswers, estimateTune } from "../benchmarks/tune-grid.mjs";
import { DEFAULT_STEPS } from "../benchmarks/tune-grid.mjs";

test("repeated rung builds for the same task list reuse one frozen result", () => {
  resetTuneRungsCache();
  const first = tuneRungs(["code"]);
  const before = tuneRungsComputations();
  const second = tuneRungs(["code"]);
  assert.equal(second, first, "same task list returns the same result object");
  assert.equal(tuneRungsComputations(), before, "no rebuild");
  assert.notEqual(tuneRungs(["recall"]), first, "a different task list gets its own rungs");
});

test("answers and seconds estimates share one rung build", () => {
  resetTuneRungsCache();
  const tasks = ["code", "comprehension", "recall"];
  const answers = expectedAnswers(DEFAULT_STEPS, { tasks });
  const estimate = estimateTune(DEFAULT_STEPS, { tasks });
  assert.equal(tuneRungsComputations(), 1, "both estimates built the frozen rungs once");
  assert.equal(answers, expectedAnswers(DEFAULT_STEPS, { tasks }));
  assert.equal(estimate.onePassSeconds, estimateTune(DEFAULT_STEPS, { tasks }).onePassSeconds);
  assert.equal(tuneRungsComputations(), 1, "repeat estimates still reuse the cache");
});
