import assert from "node:assert/strict";
import test from "node:test";

import { LlamaEngine } from "../src/engine.js";
import { calibratedReserveBytes, ladderRank, rankLadder, recordLoadSample, resetCalibration } from "../src/memory-fit.js";

const GIB = 1024 ** 3;
const quiet = { warn() {}, info() {}, error() {} };

// IDEA-1064: higher quant first, then larger context.
test("ladder ranks fidelity over size", () => {
  assert.ok(ladderRank("q8_0") > ladderRank("q4_k_m"));
  const ranked = rankLadder([
    { id: "a", quant: "Q4_K_M", contextSize: 8192, estimateTotal: 2 * GIB },
    { id: "b", quant: "Q8_0", contextSize: 2048, estimateTotal: 2 * GIB },
  ], { availableBytes: 8 * GIB });
  assert.equal(ranked[0].id, "b");
  const fitting = rankLadder([
    { id: "big", quant: "Q8_0", contextSize: 8192, estimateTotal: 7 * GIB },
    { id: "small", quant: "Q4_K_M", contextSize: 2048, estimateTotal: 2 * GIB },
  ], { availableBytes: 8 * GIB });
  assert.ok(fitting.every((row) => row.estimateTotal <= 8 * GIB * 0.75));
});

// IDEA-1065: the reserve follows measured RSS, falling back when empty.
test("calibration uses the median overhead", () => {
  resetCalibration();
  assert.equal(calibratedReserveBytes(123), 123);
  recordLoadSample({ rssBytes: 2 * GIB, modelBytes: GIB });
  recordLoadSample({ rssBytes: 3 * GIB, modelBytes: GIB });
  recordLoadSample({ rssBytes: 4 * GIB, modelBytes: GIB });
  assert.equal(calibratedReserveBytes(123), 2 * GIB);
  resetCalibration();
});

function loadRuntime() {
  return async () => ({
    LlamaChatSession: class {},
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama: async () => ({
      gpu: false,
      maxThreads: 4,
      loadModel: async () => ({
        trainContextSize: 4096,
        tokenize: (text) => [...String(text)],
        createContext: async ({ contextSize }) => ({ contextSize, sequencesLeft: 1, getSequence: () => ({ dispose() {} }), dispose: async () => {} }),
        dispose: async () => {},
      }),
      dispose: async () => {},
    }),
  });
}

const ENTRY = { id: "m1", path: "model.gguf", name: "Duck", fileName: "model.gguf", size: 2 * GIB };

// IDEA-1158/1095: phase machine, loadedId guard, teardown receipt.
test("phase moves idle loading ready unloading idle with a teardown receipt", async () => {
  const registry = { findById: () => ENTRY };
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 8 * GIB, loadRuntime: loadRuntime() });
  assert.equal(engine.phase, "idle");
  assert.equal(engine.loadedId, null);
  await engine.load({ modelId: "m1" });
  assert.equal(engine.phase, "ready");
  assert.equal(engine.loadedId, "m1");
  const receipt = await engine.teardown();
  assert.equal(receipt.modelId, "m1");
  assert.deepEqual(receipt.errors, []);
  assert.equal(engine.phase, "idle");
  assert.equal(engine.loadedId, null);
});

// IDEA-1094: cancelLoad refuses when idle and flags a load in flight.
test("cancelLoad is a no-op without a load", () => {
  const registry = { findById: () => ENTRY };
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 8 * GIB, loadRuntime: loadRuntime() });
  assert.equal(engine.cancelLoad(), false);
});
