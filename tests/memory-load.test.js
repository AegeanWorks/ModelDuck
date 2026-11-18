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

// Two simultaneous load requests must not both get past the guard while the first
// is still planning memory fit; the second is refused and the model loads once.
test("a second load started while the first is still planning is refused", async () => {
  const registry = { findById: () => ENTRY };
  let loads = 0;
  const base = loadRuntime();
  const countingRuntime = async () => {
    const module = await base();
    const getLlama = module.getLlama;
    return {
      ...module,
      getLlama: async (...args) => {
        const llama = await getLlama(...args);
        const loadModel = llama.loadModel;
        llama.loadModel = async (...a) => {
          loads += 1;
          return loadModel(...a);
        };
        return llama;
      },
    };
  };
  const engine = new LlamaEngine({
    registry,
    logger: quiet,
    availableMemory: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 8 * GIB;
    },
    loadRuntime: countingRuntime,
  });
  const results = await Promise.allSettled([engine.load({ modelId: "m1" }), engine.load({ modelId: "m1" })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const refused = results.find((r) => r.status === "rejected");
  assert.equal(refused.reason.code, "model_loading");
  assert.equal(loads, 1);
  assert.equal(engine.phase, "ready");
});

test("a load started while a reconfigure is still planning is refused", async () => {
  const registry = { findById: () => ENTRY };
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 8 * GIB, loadRuntime: loadRuntime() });
  await engine.load({ modelId: "m1" });
  const results = await Promise.allSettled([engine.reconfigure({ contextSize: 16384 }), engine.load({ modelId: "m1" })]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "model_loading");
  assert.equal(engine.phase, "ready");
});
