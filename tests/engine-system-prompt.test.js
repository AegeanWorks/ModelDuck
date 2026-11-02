import assert from "node:assert/strict";
import test from "node:test";

import { LlamaEngine } from "../src/engine.js";

const ENTRY = { id: "m1", path: "model.gguf", name: "Duck", fileName: "model.gguf", size: 1 };
const registry = { findById: (id) => (id === ENTRY.id ? ENTRY : null) };
const quiet = { warn() {}, info() {}, error() {} };

/** Mirrors node-llama-cpp: the constructor seeds the history with the system message and `setChatHistory` replaces all of it. */
function recordingRuntime() {
  const prompted = [];
  class Session {
    constructor({ contextSequence, systemPrompt }) {
      this.sequence = contextSequence;
      this.history = systemPrompt ? [{ type: "system", text: systemPrompt }] : [];
    }

    getChatHistory() {
      return structuredClone(this.history);
    }

    setChatHistory(history) {
      this.history = structuredClone(history);
    }

    async promptWithMeta(text, { onTextChunk, onToken }) {
      prompted.push(structuredClone(this.history));
      this.history.push({ type: "user", text }, { type: "model", response: ["ok"] });
      onTextChunk("ok");
      onToken([1]);
      return { responseText: "ok", stopReason: "eogToken" };
    }

    dispose() {
      this.sequence.dispose();
    }
  }
  const loadRuntime = async () => ({
    LlamaChatSession: Session,
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama: async () => ({
      gpu: false,
      maxThreads: 4,
      loadModel: async () => ({
        trainContextSize: 4096,
        gpuLayers: 0,
        tokenize: (value) => [...String(value)],
        createContext: async ({ contextSize }) => ({
          contextSize,
          sequencesLeft: 1,
          getSequence: () => ({ dispose() {} }),
          dispose: async () => {},
        }),
        dispose: async () => {},
      }),
      dispose: async () => {},
    }),
  });
  return { loadRuntime, prompted };
}

async function loaded(runtime) {
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 64 * 2 ** 30, loadRuntime: runtime.loadRuntime });
  await engine.load({ modelId: "m1", gpuBackend: "cpu", contextSize: 2048 });
  return engine;
}

/** A runtime whose completion engine records what it was asked to continue. */
function completionRuntime() {
  const base = recordingRuntime();
  const inputs = [];
  const loadRuntime = async () => ({
    ...(await base.loadRuntime()),
    LlamaCompletion: class {
      dispose() {}
      async generateCompletionWithMeta(input, options) {
        inputs.push({ input, options });
        return { response: "code", metadata: { stopReason: "eogToken" } };
      }
    },
  });
  return { loadRuntime, inputs };
}

test("the system prompt reaches the model on a new conversation", async () => {
  const runtime = recordingRuntime();
  const engine = await loaded(runtime);
  await engine.chat({ conversationId: "a", messages: [{ role: "user", content: "hi" }], systemPrompt: "Answer in one word.", settings: { maxTokens: 8, reasoning: "off" } });
  assert.deepEqual(runtime.prompted[0][0], { type: "system", text: "Answer in one word." });
});

test("the tuned response prefix is prefilled on text completions", async () => {
  const runtime = completionRuntime();
  const engine = await loaded(runtime);
  const result = await engine.complete({
    conversationId: "c",
    prompt: "write fizzbuzz",
    settings: { responsePrefix: "```", customStopTriggers: ["```"] },
  });
  assert.equal(runtime.inputs.length, 1);
  assert.ok(runtime.inputs[0].input.endsWith("```"), "the fence prefix starts the continuation");
  assert.deepEqual(runtime.inputs[0].options.customStopTriggers, ["```"]);
  assert.equal(result.text, "code");
});

test("a rebuilt session keeps the system prompt ahead of the earlier turns", async () => {
  const runtime = recordingRuntime();
  const engine = await loaded(runtime);
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "one" },
    { role: "user", content: "second" },
  ];
  await engine.chat({ conversationId: "b", messages, systemPrompt: "Be brief.", settings: { maxTokens: 8, reasoning: "off" } });
  assert.deepEqual(runtime.prompted[0].map((item) => item.type), ["system", "user", "model"]);
  assert.equal(runtime.prompted[0][0].text, "Be brief.");
});
