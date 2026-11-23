import assert from "node:assert/strict";
import test from "node:test";

import { score, zeroedMapBuildCount } from "../benchmarks/tune-measure.mjs";

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
