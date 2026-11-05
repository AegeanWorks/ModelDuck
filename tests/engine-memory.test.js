import assert from "node:assert/strict";
import test from "node:test";

import { LlamaEngine, validKvLabel } from "../src/engine.js";

const GIB = 1024 ** 3;
const ENTRY = { id: "m1", path: "model.gguf", name: "Duck", fileName: "model.gguf", size: 2 * GIB };
const registry = { findById: (id) => (id === ENTRY.id ? ENTRY : null) };
const quiet = { warn() {}, info() {}, error() {} };

/** A runtime on `gpu` (false for the CPU) whose free VRAM is `freeVram`. */
function runtime({ gpu = false, freeVram = 0 } = {}) {
  return async () => ({
    LlamaChatSession: class {},
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama: async () => ({
      gpu,
      maxThreads: 4,
      getVramState: async () => ({ total: 16 * GIB, used: 16 * GIB - freeVram, free: freeVram }),
      loadModel: async () => ({
        trainContextSize: 4096,
        gpuLayers: gpu ? 28 : 0,
        tokenize: (text) => [...String(text)],
        createContext: async ({ contextSize }) => ({ contextSize, sequencesLeft: 1, getSequence: () => ({ dispose() {} }), dispose: async () => {} }),
        dispose: async () => {},
      }),
      dispose: async () => {},
    }),
  });
}

test("free memory for a load counts the loaded model's own share as free", async () => {
  const cpu = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 5 * GIB, loadRuntime: runtime() });
  assert.equal(await cpu.availableMemory({ gpuBackend: "cpu" }), 5 * GIB, "nothing loaded yet: just the free RAM");
  await cpu.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048 });
  assert.equal(await cpu.availableMemory({ gpuBackend: "cpu" }), 7 * GIB);

  const gpu = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 5 * GIB, loadRuntime: runtime({ gpu: "vulkan", freeVram: 10 * GIB }) });
  await gpu.load({ modelId: "m1", gpuBackend: "vulkan", contextSize: 2048 });
  assert.equal(await gpu.availableMemory({ gpuBackend: "vulkan" }), 12 * GIB, "free VRAM plus the model on the GPU");
  assert.equal(await cpu.availableMemory({ gpuBackend: "vulkan" }), null, "no GPU runtime: unknown, so the budget falls back");
});

test("inherited property names are not KV cache labels", () => {
  assert.equal(validKvLabel("toString"), "f16");
  assert.equal(validKvLabel("__proto__"), "f16");
  assert.equal(validKvLabel("constructor"), "f16");
});

test("known KV cache labels pass through, malformed ones fall back", () => {
  assert.equal(validKvLabel("f16"), "f16");
  assert.equal(validKvLabel("q8_0"), "q8_0");
  assert.equal(validKvLabel("q4_0"), "q4_0");
  assert.equal(validKvLabel("q8_0:q4_0"), "q8_0:q4_0");
  assert.equal(validKvLabel("f16:f16:f16"), "f16");
  assert.equal(validKvLabel("q9"), "f16");
  assert.equal(validKvLabel(undefined), "f16");
});

test("a backend can be started without a model, failing the way a load would", async () => {
  const failing = async () => ({
    ...(await runtime()()),
    getLlama: async ({ gpu }) => {
      if (gpu) throw new Error("NoBinaryFoundError");
      return { gpu: false, maxThreads: 4, dispose: async () => {} };
    },
  });
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => GIB, loadRuntime: failing });
  await engine.startBackend("cpu");
  await assert.rejects(engine.startBackend("vulkan"), (error) => error.code === "gpu_backend_failed" && /NoBinaryFoundError/.test(error.why));
});

// IDEA-1627: batch 1 reaches the runtime only on the explicit repro path;
// everything else keeps the 32 floor.
test("batch 1 loads only with the deterministic repro flag", async (t) => {
  const seen = [];
  const capturing = async () => ({
    LlamaChatSession: class {},
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama: async () => ({
      gpu: false,
      maxThreads: 4,
      loadModel: async () => ({
        trainContextSize: 8192,
        tokenize: (text) => [...String(text)],
        createContext: async (contextOptions) => {
          seen.push({ ...contextOptions });
          return { contextSize: contextOptions.contextSize, sequencesLeft: 1, getSequence: () => ({ dispose() {} }), dispose: async () => {} };
        },
        dispose: async () => {},
      }),
      dispose: async () => {},
    }),
  });
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 16 * GIB, loadRuntime: capturing });
  t.after(() => engine.dispose().catch(() => {}));
  await engine.load({ modelId: "m1", batchSize: 1 });
  assert.equal(seen.at(-1).batchSize, 32, "unflagged batch 1 floors to 32");
  await engine.unload();
  await engine.load({ modelId: "m1", batchSize: 1, deterministicRepro: true });
  assert.equal(seen.at(-1).batchSize, 1, "the repro flag lets batch 1 through");
});
