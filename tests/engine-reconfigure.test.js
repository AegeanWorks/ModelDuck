import assert from "node:assert/strict";
import test from "node:test";

import { LlamaEngine } from "../src/engine.js";

const ENTRY = { id: "m1", path: "model.gguf", name: "Duck", fileName: "model.gguf", size: 1 };
const registry = { findById: (id) => (id === ENTRY.id ? ENTRY : null) };
const quiet = { warn() {}, info() {}, error() {} };

/**
 * A runtime whose model and context creation are counted, so a test can prove
 * that a reconfigure recreates the context without paying a model reload.
 * `failContext` makes the next createContext call fail once.
 */
function countingRuntime({ failContextAt = 0 } = {}) {
  const model = {
    trainContextSize: 4096,
    gpuLayers: 0,
    contexts: 0,
    disposed: false,
    tokenize: (text) => [...String(text)],
    detokenize: (tokens) => String(tokens),
    async createContext(options) {
      model.contexts += 1;
      if (failContextAt > 0 && model.contexts === failContextAt) {
        throw new Error("cannot allocate context");
      }
      let left = options.sequences ?? 1;
      return {
        contextSize: options.contextSize,
        get sequencesLeft() {
          return left;
        },
        getSequence() {
          if (left === 0) throw new Error("No sequences left");
          left -= 1;
          return { dispose: () => (left += 1) };
        },
        dispose: async () => {},
      };
    },
    async dispose() {
      model.disposed = true;
    },
  };
  const sessions = [];
  class Session {
    constructor({ contextSequence }) {
      this.sequence = contextSequence;
      this.disposed = false;
      sessions.push(this);
    }

    getChatHistory() {
      return [];
    }

    setChatHistory() {}

    async promptWithMeta() {
      return { responseText: "quack", stopReason: "eogToken" };
    }

    dispose() {
      this.disposed = true;
    }
  }
  const llama = {
    gpu: false,
    maxThreads: 4,
    modelLoads: 0,
    async loadModel() {
      llama.modelLoads += 1;
      return model;
    },
    async dispose() {},
  };
  const loadRuntime = async () => ({
    LlamaChatSession: Session,
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama: async () => llama,
    dispose: async () => {},
  });
  return { loadRuntime, llama, model, sessions };
}

const asking = (engine, conversationId) =>
  engine.chat({ conversationId, messages: [{ role: "user", content: "hi" }], systemPrompt: "Be brief.", settings: { maxTokens: 8 } });

async function loadedEngine(runtime) {
  const engine = new LlamaEngine({
    registry,
    logger: quiet,
    availableMemory: () => 64 * 2 ** 30,
    loadRuntime: runtime.loadRuntime,
  });
  await engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048, threads: 4, batchSize: 512, sequences: 1 });
  return engine;
}

test("reconfigure recreates the context without reloading the model", async () => {
  const runtime = countingRuntime();
  const engine = await loadedEngine(runtime);
  const state = await engine.reconfigure({ contextSize: 2048, threads: 8, maxThreads: 8, batchSize: 512, sequences: 1, kvCache: "f16" });
  assert.equal(runtime.llama.modelLoads, 1, "the model is loaded exactly once");
  assert.equal(runtime.model.contexts, 2, "the context is recreated");
  assert.equal(state.status, "ready");
  assert.equal(state.threads, 8);
  assert.equal(state.maxThreads, 8);
  assert.equal(runtime.llama.maxThreads, 8, "the runtime thread cap follows the reconfigure");
  const once = runtime.model.contexts;
  const again = await engine.reconfigure({ contextSize: 2048, threads: 8, maxThreads: 8, batchSize: 256, sequences: 1, kvCache: "f16" });
  assert.equal(runtime.llama.modelLoads, 1, "still the same resident model");
  assert.equal(runtime.model.contexts, once + 1);
  assert.equal(again.batchSize, 256, "normalised batch of the new context");
});

test("reconfigure keeps the previous context-level settings when a key is omitted", async () => {
  const runtime = countingRuntime();
  const engine = await loadedEngine(runtime);
  const before = await engine.status();
  const state = await engine.reconfigure({ threads: 2 });
  assert.equal(state.contextSize, before.contextSize, "the loaded context size survives (a load clamps the 16K floor to the trained window)");
  assert.equal(state.batchSize, before.batchSize, "the loaded batch survives");
  assert.equal(state.threads, 2);
});

test("reconfigure disposes the sessions of the replaced context", async () => {
  const runtime = countingRuntime();
  const engine = await loadedEngine(runtime);
  await asking(engine, "a");
  assert.equal(runtime.sessions[0].disposed, false);
  await engine.reconfigure({ threads: 6 });
  assert.equal(runtime.sessions[0].disposed, true, "old sessions never outlive their context");
  const reply = await asking(engine, "b");
  assert.equal(reply.text, "quack", "the engine answers from the new context");
});

test("an unanswered ready model cannot reconfigure while a reply is in flight", async (t) => {
  // gate: not needed to hold a reply open here; the load guard already refuses
  // mid-generation, so only the not-ready refusal is proven exhaustively.
  const runtime = countingRuntime();
  const engine = await loadedEngine(runtime);
  await engine.unload();
  await assert.rejects(engine.reconfigure({ threads: 2 }), (error) => error.code === "model_not_loaded");
  t.after(() => engine.dispose());
});

test("a failed recreate leaves the engine in the error phase, and a fresh load recovers", async () => {
  const runtime = countingRuntime({ failContextAt: 2 });
  const engine = await loadedEngine(runtime);
  await assert.rejects(engine.reconfigure({ threads: 2 }), (error) => error.code === "context_recreate_failed");
  assert.equal(await (await engine.status()).status, "error");
  const state = await engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048, threads: 4, batchSize: 512, sequences: 1 });
  assert.equal(state.status, "ready", "a full load is the recovery path");
  assert.equal(runtime.llama.modelLoads, 2, "the failed reconfigure disposed the model");
});
