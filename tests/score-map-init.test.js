import assert from "node:assert/strict";
import test from "node:test";

import { medianQuickComputations, score, scoreConversionComputations, zeroedMapBuildCount } from "../benchmarks/tune-measure.mjs";

// Minimal measurements stub: one seed, one item, all checks pass.
const measurements = {
  measure: async () => ({
    prompts: [{ id: "i0", passed: 1, total: 1, ms: 10, outputTokens: 5, digest: "abc", tokensPerSecond: 2 }],
    memoryBytes: 100,
    gpuVram: null,
  }),
};

test("score initializes its two zeroed maps directly", async () => {
  const before = zeroedMapBuildCount();
  const result = await score(measurements, { temperature: 0 }, ["i0"], [42]);
  assert.equal(zeroedMapBuildCount(), before + 2);
  assert.equal(result.solved, 1);
  assert.equal(result.fractions.i0, 1);
  assert.deepEqual([...result.itemLatency], [["i0", 10]], "the other per-item maps stay empty until measured");
});

test("score selects its six medians in place without changing the stats", async () => {
  const allFields = {
    measure: async () => ({
      prompts: [{ id: "i0", passed: 1, total: 1, ms: 10, outputTokens: 5, promptTokens: 8, firstTokenMs: 2, digest: "abc", tokensPerSecond: 2 }],
      memoryBytes: 100,
      gpuVram: null,
    }),
  };
  const before = medianQuickComputations();
  const result = await score(allFields, { temperature: 0 }, ["i0"], [42]);
  assert.equal(medianQuickComputations(), before + 6);
  assert.equal(result.latencyMs, 10);
  assert.equal(result.outputTokens, 5);
  assert.equal(result.tokensPerSecond, 2);
  assert.equal(result.promptTokens, 8);
  assert.equal(result.prefillTps, 4000);
});

test("score derives its outcome maps in one pass", async () => {
  const before = scoreConversionComputations();
  const result = await score(measurements, { temperature: 0 }, ["i0"], [42]);
  assert.equal(scoreConversionComputations(), before + 1);
  assert.deepEqual(result.outcomes, { i0: 1 });
  assert.deepEqual(result.fractions, { i0: 1 });
  assert.deepEqual(result.credit, { i0: 1 });
  assert.deepEqual([...result.majority], [["i0", true]]);
});
