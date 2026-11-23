import assert from "node:assert/strict";
import test from "node:test";

import { SUMMARIZE_CHAINS_MODE, summarizeChains } from "../benchmarks/multistep-evaluate.mjs";

test("chain summaries are aggregated in one pass", () => {
  assert.equal(SUMMARIZE_CHAINS_MODE, "single-pass");
});

test("single-pass aggregation matches the rescan result on irregular chains", () => {
  const step = (passed, total, error = null) => ({ passed, total, error });
  const results = [
    { passed: 2, total: 5, allSteps: false, prefix: 2, steps: [step(1, 2), step(1, 2, "late"), step(0, 1)] },
    { passed: 1, total: 2, allSteps: false, prefix: 1, steps: [step(1, 1), step(0, 1)] },
    { passed: 8, total: 10, allSteps: false, prefix: 4, steps: [step(2, 2), step(2, 2), step(2, 2), step(2, 2), step(0, 2)] },
  ];
  const summary = summarizeChains(results);
  assert.equal(summary.runs, 3);
  assert.equal(summary.passed, 11);
  assert.equal(summary.total, 17);
  assert.equal(summary.rate, 64.7);
  assert.equal(summary.allSteps, 0);
  assert.equal(summary.allStepsRate, 0);
  assert.equal(summary.meanPrefix, 2.33);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.byStep, [
    { step: 1, passed: 4, total: 5, rate: 80 },
    { step: 2, passed: 3, total: 5, rate: 60 },
    { step: 3, passed: 2, total: 3, rate: 66.7 },
    { step: 4, passed: 2, total: 2, rate: 100 },
    { step: 5, passed: 0, total: 2, rate: 0 },
  ]);
  assert.deepEqual(summarizeChains([]).byStep, []);
});
