import assert from "node:assert/strict";
import test from "node:test";

import { LlamaEngine } from "../src/engine.js";
import { AppError } from "../src/errors.js";

const ENTRY = { id: "m1", path: "model.gguf", name: "Duck", fileName: "model.gguf", size: 1 };
const registry = { findById: (id) => (id === ENTRY.id ? ENTRY : null) };
const quiet = { warn() {}, info() {}, error() {} };

function fakeRuntime(getLlama) {
  return async () => ({
    LlamaChatSession: class {},
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama,
  });
}

test("the runtime is never built or downloaded on demand", async () => {
  const calls = [];
  const engine = new LlamaEngine({
    registry,
    logger: quiet,
    loadRuntime: fakeRuntime(async (options) => {
      calls.push(options);
      throw new Error("stop after getLlama");
    }),
  });
  await assert.rejects(() => engine.load({ modelId: "m1", gpuBackend: "auto" }));
  assert.ok(calls.length >= 1);
  for (const options of calls) assert.equal(options.build, "never", JSON.stringify(options));
});

test("a missing prebuilt binary is an actionable error, not a silent compile", async () => {
  const engine = new LlamaEngine({
    registry,
    logger: quiet,
    loadRuntime: fakeRuntime(async () => {
      throw new Error("No prebuilt binary found for this platform");
    }),
  });
  await assert.rejects(
    () => engine.load({ modelId: "m1", gpuBackend: "cpu" }),
    (error) => error instanceof AppError && error.code === "runtime_binary_missing" && /source download/.test(error.fix),
  );
});

const GIB = 1024 ** 3;
const LLAMA_3B = { layers: 28, kvHeads: 8, headDim: 128 };
const BIG_ENTRY = { ...ENTRY, size: 1.83 * GIB, contextLength: 131072, kvShape: LLAMA_3B };

function workingRuntime({ maxContext = Infinity, onLoad = () => {} } = {}) {
  return fakeRuntime(async () => ({
    gpu: false,
    maxThreads: 4,
    loadModel: async () => {
      onLoad();
      return {
        trainContextSize: 131072,
        gpuLayers: 0,
        createContext: async ({ contextSize }) => {
          if (contextSize > maxContext) throw new Error(`could not allocate ${contextSize}`);
          return { contextSize, dispose: async () => {} };
        },
        dispose: async () => {},
      };
    },
    dispose: async () => {},
  }));
}

test("a load that will not fit in memory is refused before anything is loaded", async () => {
  let loaded = false;
  const engine = new LlamaEngine({
    registry: { findById: () => BIG_ENTRY },
    logger: quiet,
    availableMemory: () => 2 * GIB,
    loadRuntime: workingRuntime({ onLoad: () => { loaded = true; } }),
  });
  await assert.rejects(
    () => engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 8192, kvCache: "f16" }),
    (error) => error instanceof AppError && error.code === "model_will_not_fit" && error.status === 507 && /Context size|smaller model/.test(error.fix),
  );
  assert.equal(loaded, false);
});

test("a load that cannot allocate the 16K floor fails instead of silently shrinking", async () => {
  const engine = new LlamaEngine({
    registry: { findById: () => BIG_ENTRY },
    logger: quiet,
    availableMemory: () => 16 * GIB,
    loadRuntime: workingRuntime({ maxContext: 2048 }),
  });
  await assert.rejects(
    () => engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 8192, kvCache: "q8_0" }),
    (error) => /16384|allocate|context/i.test(`${error.message} ${error.why ?? ""}`),
  );
  assert.equal((await engine.status()).status, "error");
});

test("GPU offload skips the RAM check instead of refusing", async () => {
  const engine = new LlamaEngine({
    registry: { findById: () => BIG_ENTRY },
    logger: quiet,
    availableMemory: () => 1 * GIB,
    loadRuntime: workingRuntime(),
  });
  const state = await engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 4096, gpuLayers: "max" });
  assert.equal(state.fit.verdict, "unknown");
});

test("checkpoint interval and max are reported and clamped", async () => {
  const engine = new LlamaEngine({
    registry,
    logger: quiet,
    availableMemory: () => 16 * GIB,
    loadRuntime: workingRuntime(),
  });
  const state = await engine.load({
    modelId: "m1",
    gpuBackend: "cpu",
    contextSize: 2048,
    checkpointInterval: 512,
    checkpointMax: 4,
  });
  assert.equal(state.checkpointInterval, 512);
  assert.equal(state.checkpointMax, 4);

  const clamped = new LlamaEngine({
    registry,
    logger: quiet,
    availableMemory: () => 16 * GIB,
    loadRuntime: workingRuntime(),
  });
  const low = await clamped.load({
    modelId: "m1",
    gpuBackend: "cpu",
    contextSize: 2048,
    checkpointInterval: 1,
    checkpointMax: 999,
  });
  assert.equal(low.checkpointInterval, 128);
  assert.equal(low.checkpointMax, 64);
});

test("Load anyway (force) proceeds and still reports the will-not-fit verdict", async () => {
  const engine = new LlamaEngine({
    registry: { findById: () => BIG_ENTRY },
    logger: quiet,
    availableMemory: () => 2 * GIB,
    loadRuntime: workingRuntime(),
  });
  const state = await engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 8192, kvCache: "f16", force: true });
  assert.equal(state.status, "ready");
  assert.equal(state.fit.verdict, "will_not_fit");
});
