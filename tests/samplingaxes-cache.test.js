import assert from "node:assert/strict";
import test from "node:test";

import { samplingAxes, samplingAxesComputations, resetSamplingAxesCache, DEFAULT_STEPS } from "../benchmarks/tune-grid.mjs";

test("samplingAxes is derived once per task and steps", () => {
  resetSamplingAxesCache();
  const steps = DEFAULT_STEPS.sampling;
  const code = samplingAxes("code", steps);
  const before = samplingAxesComputations();
  assert.equal(samplingAxes("code", steps), code, "same inputs return the same frozen axes");
  assert.equal(samplingAxesComputations(), before, "no rebuild");
  assert.notEqual(samplingAxes("recall", steps), code, "another task gets its own axes");
  assert.deepEqual(code.map((axis) => axis.name), ["sampler", "maxTokens", "repeatPenalty", "dry", "penalizeNewLine", "topK"]);
  assert.ok(Object.isFrozen(code));
});

test("estimates reuse sampling axes across tasks", () => {
  resetSamplingAxesCache();
  const steps = DEFAULT_STEPS.sampling;
  for (const task of ["code", "comprehension", "recall"]) samplingAxes(task, steps);
  const before = samplingAxesComputations();
  for (const task of ["code", "comprehension", "recall"]) samplingAxes(task, steps);
  assert.equal(samplingAxesComputations(), before, "repeat passes reuse the cache");
});
