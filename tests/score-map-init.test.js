import assert from "node:assert/strict";
import test from "node:test";

import { medianEqualClassComputations, medianQuickComputations, medianUpperScanComputations, score, scoreConversionComputations, stdevLoopComputations, zeroedMapBuildCount } from "../benchmarks/tune-measure.mjs";

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

test("even-length medians scan the right partition for the upper rank", async () => {
  const ids = ["i0", "i1", "i2", "i3"];
  const even = {
    measure: async () => ({
      prompts: ids.map((id, index) => ({
        id, passed: 1, total: 1, digest: id,
        ms: 10 * (index + 1), outputTokens: index + 5, tokensPerSecond: 2 * (index + 1),
        promptTokens: index + 8, firstTokenMs: index + 1,
      })),
      memoryBytes: 100,
    }),
  };
  const before = medianUpperScanComputations();
  const result = await score(even, { temperature: 0 }, ids, [42]);
  assert.equal(medianUpperScanComputations(), before + 6, "all six medians used the fused upper scan");
  assert.equal(result.latencyMs, 25);
  assert.equal(result.outputTokens, 6.5);
  assert.equal(result.tokensPerSecond, 5);
  assert.equal(result.promptTokens, 9.5);
});

test("repeated scores stop selection on the equal class", async () => {
  const ids = ["i0", "i1", "i2", "i3"];
  const repeated = {
    measure: async () => ({
      prompts: ids.map((id, index) => ({
        id, passed: 1, total: 1, digest: id,
        ms: [10, 20, 20, 40][index], outputTokens: [5, 7, 7, 9][index],
        tokensPerSecond: 2, promptTokens: 8, firstTokenMs: 1,
      })),
      memoryBytes: 100,
    }),
  };
  const before = medianEqualClassComputations();
  const result = await score(repeated, { temperature: 0 }, ids, [42]);
  assert.ok(medianEqualClassComputations() > before, "duplicate values ended a partition on the equal class");
  assert.equal(result.latencyMs, 20, "the median is unchanged by three-way partition");
  assert.equal(result.outputTokens, 7);
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

test("score computes latency spread with the loop stdev", async () => {
  const before = stdevLoopComputations();
  const result = await score(measurements, { temperature: 0 }, ["i0"], [42]);
  assert.equal(stdevLoopComputations(), before + 1);
  assert.equal(result.latencySd, 0);
});
