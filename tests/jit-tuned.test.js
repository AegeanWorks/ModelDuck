import assert from "node:assert/strict";
import test from "node:test";

import { JitManager } from "../src/jit.js";

test("a just-in-time load uses the model's tuned load settings", async () => {
  const loads = [];
  const entry = { id: "m1", name: "Tuned", fileName: "tuned.gguf" };
  const jit = new JitManager({
    engine: { loadedId: null, load: async (options) => loads.push(options), unload: async () => {} },
    registry: { listPublic: () => [entry], findById: (id) => (id === "m1" ? entry : null) },
    settings: { value: { contextSize: 2048, threads: 2, temperature: 0.7 } },
    serverSettings: { value: { jitLoading: true, jitModelLoading: true, justInTimeModelLoading: true, onlyKeepLastJitLoadedModel: true, autoUnloadMinutes: 0 } },
    tuned: { resolve: async (modelId) => (modelId === "m1" ? { settings: { contextSize: 8192, threads: 6 } } : null) },
    logger: { info() {}, warn() {} },
  });
  await jit.ensure("tuned.gguf");
  jit.dispose();
  assert.equal(loads[0].contextSize, 8192);
  assert.equal(loads[0].threads, 6);
  assert.equal(loads[0].temperature, 0.7, "untuned keys keep the user's value");
});

function coldJit({ loadMs = 15, failFirst = false } = {}) {
  const entries = [
    { id: "m1", name: "One", fileName: "one.gguf" },
    { id: "m2", name: "Two", fileName: "two.gguf" },
  ];
  const state = { loadedId: null, loads: [] };
  const engine = {
    get loadedId() {
      return state.loadedId;
    },
    load: async ({ modelId }) => {
      state.loads.push(modelId);
      await new Promise((resolve) => setTimeout(resolve, loadMs));
      if (failFirst && state.loads.length === 1) throw new Error("load failed");
      state.loadedId = modelId;
    },
    unload: async () => {
      state.loadedId = null;
    },
  };
  const jit = new JitManager({
    engine,
    registry: { listPublic: () => entries, findById: (id) => entries.find((e) => e.id === id) ?? null },
    settings: { value: {} },
    serverSettings: { value: { justInTimeModelLoading: true, onlyKeepLastJitLoadedModel: true } },
    logger: { info() {}, warn() {} },
  });
  return { jit, state };
}

test("parallel requests for the same cold model share one load", async () => {
  const { jit, state } = coldJit();
  const [a, b] = await Promise.all([jit.ensure("one.gguf"), jit.ensure("one")]);
  jit.dispose();
  assert.equal(a.id, "m1");
  assert.equal(b.id, "m1");
  assert.deepEqual(state.loads, ["m1"]);
});

test("a failed shared load fails every waiter and the next request retries", async () => {
  const { jit, state } = coldJit({ failFirst: true });
  const results = await Promise.allSettled([jit.ensure("one.gguf"), jit.ensure("one.gguf")]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(state.loads.length, 1, "the waiters did not start a second load");
  const retry = await jit.ensure("one.gguf");
  jit.dispose();
  assert.equal(retry.id, "m1");
  assert.equal(state.loads.length, 2);
});

test("a request for a different model while one loads is refused, not interleaved", async () => {
  const { jit, state } = coldJit();
  const first = jit.ensure("one.gguf");
  await assert.rejects(() => jit.ensure("two.gguf"), (error) => error.code === "model_loading");
  await first;
  jit.dispose();
  assert.deepEqual(state.loads, ["m1"]);
});
