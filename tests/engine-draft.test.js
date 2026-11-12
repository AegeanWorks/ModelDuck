import assert from "node:assert/strict";
import test from "node:test";

import { LlamaEngine } from "../src/engine.js";

const MAIN = { id: "m1", path: "model.gguf", name: "Duck", fileName: "model.gguf", size: 1 };
const DRAFT = { id: "d1", path: "draft.gguf", name: "Duckling", fileName: "draft.gguf", size: 1 };
const registry = { findById: (id) => (id === MAIN.id ? MAIN : id === DRAFT.id ? DRAFT : null) };
const quiet = { warn() {}, info() {}, error() {} };

/**
 * A runtime whose draft side is fully instrumented: two models (main and
 * draft), a claimed-sequence pool per context that observes pool accounting,
 * and a predictor class whose instances are recorded so a test can prove that
 * every target sequence got exactly one predictor over its own draft sequence.
 */
function draftingRuntime() {
  const predictors = [];
  class Predictor {
    constructor(draftSequence) {
      this.draftSequence = draftSequence;
      this.disposed = false;
      predictors.push(this);
    }

    dispose() {
      this.disposed = true;
    }
  }
  const makeModel = (name) => {
    const model = {
      name,
      trainContextSize: 4096,
      gpuLayers: 0,
      contexts: 0,
      contextOptions: null,
      disposed: false,
      tokenize: (text) => [...String(text)],
      detokenize: (tokens) => String(tokens),
      async createContext(options) {
        model.contexts += 1;
        model.contextOptions = options;
        let left = typeof options.sequences === "number" ? options.sequences : 1;
        return {
          contextSize: options.contextSize && typeof options.contextSize === "object" ? options.contextSize.max : options.contextSize,
          get sequencesLeft() {
            return left;
          },
          getSequence(options = {}) {
            if (left === 0) throw new Error("No sequences left");
            left -= 1;
            const sequence = {
              predictor: options.tokenPredictor ?? null,
              disposed: false,
              dispose() {
                if (sequence.disposed) return;
                sequence.disposed = true;
                left += 1;
              },
            };
            return sequence;
          },
          dispose: async () => {
            model.disposed = true;
          },
        };
      },
      async dispose() {
        model.disposed = true;
      },
    };
    return model;
  };
  const main = makeModel("main");
  const draft = makeModel("draft");
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
      if (this.disposed) return;
      this.disposed = true;
      this.sequence?.dispose?.();
    }
  }
  const llama = {
    gpu: false,
    maxThreads: 4,
    modelLoads: 0,
    async loadModel({ modelPath }) {
      llama.modelLoads += 1;
      return modelPath === DRAFT.path ? draft : main;
    },
    async dispose() {},
  };
  const loadRuntime = async () => ({
    LlamaChatSession: Session,
    LlamaCompletion: class {},
    DraftSequenceTokenPredictor: Predictor,
    getModuleVersion: async () => "test",
    getLlama: async () => llama,
    dispose: async () => {},
  });
  return { loadRuntime, llama, main, draft, sessions, predictors };
}

const asking = (engine, conversationId) =>
  engine.chat({ conversationId, messages: [{ role: "user", content: "hi" }], systemPrompt: "Be brief.", settings: { maxTokens: 8 } });

async function newEngine(runtime) {
  const engine = new LlamaEngine({
    registry,
    logger: quiet,
    availableMemory: () => 64 * 2 ** 30,
    loadRuntime: runtime.loadRuntime,
  });
  return engine;
}

async function loadedDraftEngine(runtime) {
  const engine = await newEngine(runtime);
  await engine.load({
    modelId: "m1",
    gpuBackend: "cpu",
    contextSize: 2048,
    threads: 4,
    batchSize: 512,
    sequences: 1,
    draftModel: "d1",
  });
  return engine;
}

test("a draft model loads beside the main model and is reported in the state", async (t) => {
  const runtime = draftingRuntime();
  const engine = await loadedDraftEngine(runtime);
  t.after(() => engine.dispose());
  const state = await engine.status();
  assert.equal(runtime.llama.modelLoads, 2, "the main and draft models both load");
  assert.equal(state.draftModel, "d1", "the state names the draft model");
  assert.equal(runtime.draft.contexts, 1, "the draft context exists");
  assert.equal(runtime.draft.disposed, false);
  assert.ok(runtime.draft.contextOptions, "the draft context options are recorded");
  assert.equal(typeof runtime.draft.contextOptions.contextSize, "object", "the draft context is capped by a max");
});

test("every target sequence gets one predictor over a dedicated draft sequence", async (t) => {
  const runtime = draftingRuntime();
  const engine = await loadedDraftEngine(runtime);
  t.after(() => engine.dispose());
  const first = await asking(engine, "a");
  assert.equal(first.text, "quack");
  assert.equal(runtime.predictors.length, 1, "one ask pairs one predictor");
  assert.equal(runtime.predictors[0].draftSequence.disposed, false, "the draft sequence lives while its session lives");
  // A new conversation retires the first session; its draft sequence must be
  // reconciled back to the pool so the draft pool never leaks a sequence.
  const second = await asking(engine, "b");
  assert.equal(second.text, "quack");
  assert.equal(runtime.predictors.length, 2, "the second ask pairs its own predictor");
  assert.notEqual(runtime.predictors[0], runtime.predictors[1], "predictors are never shared");
});

test("reconfigure keeps the draft resources and re-pairs fresh sequences", async (t) => {
  const runtime = draftingRuntime();
  const engine = await loadedDraftEngine(runtime);
  t.after(() => engine.dispose());
  await asking(engine, "a");
  const state = await engine.reconfigure({ threads: 8 });
  assert.equal(state.draftModel, "d1", "the context rebuild keeps the draft model");
  assert.equal(runtime.llama.modelLoads, 2, "no reload happened");
  assert.equal(runtime.draft.disposed, false, "the draft model survives the reconfigure");
  const reply = await asking(engine, "b");
  assert.equal(reply.text, "quack", "the engine answers with a predictor on the new context");
  assert.equal(runtime.predictors.length, 2, "the new sequence got a fresh predictor");
});

test("unloading releases the draft pair and a later load can drop the draft", async (t) => {
  const runtime = draftingRuntime();
  const engine = await loadedDraftEngine(runtime);
  await asking(engine, "a");
  await engine.unload();
  assert.equal(runtime.draft.disposed, true, "unload releases the draft model");
  assert.equal(runtime.main.disposed, true, "unload releases the main model");
  const state = await engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048, threads: 4, batchSize: 512, sequences: 1 });
  assert.equal(state.draftModel, null, "a plain load leaves the draft off");
  await asking(engine, "c");
  assert.equal(runtime.predictors.length, 1, "the nondraft ask never creates a predictor");
  assert.equal(runtime.draft.contexts, 1, "no new draft context appears");
  t.after(() => engine.dispose());
});

test("a model cannot draft itself", async (t) => {
  const runtime = draftingRuntime();
  const engine = await newEngine(runtime);
  t.after(() => engine.dispose());
  await assert.rejects(
    engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048, threads: 4, batchSize: 512, sequences: 1, draftModel: "m1" }),
    (error) => error.code === "draft_model_self",
  );
});

test("an unknown draft model fails the load with a clear error", async (t) => {
  const runtime = draftingRuntime();
  const engine = await newEngine(runtime);
  t.after(() => engine.dispose());
  await assert.rejects(
    engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048, threads: 4, batchSize: 512, sequences: 1, draftModel: "ghost" }),
    (error) => error.code === "draft_model_not_found",
  );
  assert.equal(runtime.llama.modelLoads, 1, "only the main model was touched before the refusal");
});
