import assert from "node:assert/strict";
import test from "node:test";

import { detectGpuBackends, resetGpuDetection } from "../src/gpu-info.js";

test("GPU detection is read once and reused by later polls", async () => {
  resetGpuDetection();
  const first = await detectGpuBackends();
  const second = await detectGpuBackends();
  assert.ok(Array.isArray(first));
  assert.equal(first, second, "a second poll must reuse the first result");
});

test("a missing native runtime yields an empty list, not a rejection", async () => {
  resetGpuDetection();
  const result = await detectGpuBackends({ loadRuntime: async () => { throw new Error("Cannot find package node-llama-cpp"); } });
  assert.deepEqual(result, []);
  resetGpuDetection();
});
