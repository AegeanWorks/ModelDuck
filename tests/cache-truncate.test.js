import assert from "node:assert/strict";
import test from "node:test";

import { eligibleForCache, LlamaEngine } from "../src/engine.js";

const GIB = 1024 ** 3;
const quiet = { warn() {}, info() {}, error() {} };
const ENTRY = { id: "m1", path: "model.gguf", fileName: "model.gguf", size: 2 * GIB, contextLength: 4096 };

// IDEA-1076: only greedy seeded answers are cacheable.
test("eligibleForCache fences on temperature zero and explicit seed", () => {
  assert.equal(eligibleForCache({ temperature: 0, seed: 7 }), true);
  assert.equal(eligibleForCache({ temperature: 0.7, seed: 7 }), false);
  assert.equal(eligibleForCache({ temperature: 0, seed: -1 }), false);
  assert.equal(eligibleForCache({}), false);
});

function chatRuntime(counter) {
  return async () => ({
    LlamaChatSession: class {
      constructor() {}
      getChatHistory() { return []; }
      setChatHistory() {}
      dispose() {}
      async promptWithMeta(prompt, options) {
        counter.calls += 1;
        options.onTextChunk("Quack");
        options.onToken([1, 2]);
        return { stopReason: "eogToken" };
      }
    },
    LlamaCompletion: class {},
    getModuleVersion: async () => "test",
    getLlama: async () => ({
      gpu: false,
      maxThreads: 4,
      loadModel: async () => ({
        trainContextSize: 4096,
        tokenize: (text) => [...String(text)],
        createContext: async ({ contextSize }) => ({
          contextSize,
          sequencesLeft: 1,
          getSequence: () => ({ dispose() {} }),
        }),
        dispose: async () => {},
      }),
      dispose: async () => {},
    }),
  });
}

async function loadedEngine(t, counter, settings) {
  const registry = { findById: () => ENTRY };
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 8 * GIB, loadRuntime: chatRuntime(counter) });
  await engine.load({ modelId: "m1" });
  t.after(() => engine.dispose().catch(() => {}));
  return engine;
}

// IDEA-1076: an exact repeat skips regeneration; anything else regenerates.
test("deterministic repeats hit the memory-only cache", async (t) => {
  const counter = { calls: 0 };
  const engine = await loadedEngine(t, counter);
  const settings = { temperature: 0, seed: 7, maxTokens: 32 };
  const messages = [{ role: "user", content: "hello" }];
  const first = await engine.chat({ conversationId: "c1", messages, systemPrompt: "sys", settings });
  assert.equal(first.text, "Quack");
  assert.equal(first.stats.cached, false);
  const second = await engine.chat({ conversationId: "c2", messages, systemPrompt: "sys", settings });
  assert.equal(second.text, "Quack");
  assert.equal(second.stats.cached, true);
  assert.equal(counter.calls, 1);
  const creative = await engine.chat({ conversationId: "c3", messages, systemPrompt: "sys", settings: { temperature: 0.7, seed: 7, maxTokens: 32 } });
  assert.equal(creative.stats.cached, false);
  assert.equal(counter.calls, 2);
});

// IDEA-1082: truncate mode drops the oldest turns instead of failing.
test("truncate overflow survives long history and flags the manifest", async (t) => {
  const counter = { calls: 0 };
  const engine = await loadedEngine(t, counter);
  const longHistory = [
    { role: "user", content: "old question " + "x".repeat(2000) },
    { role: "assistant", content: "old answer " + "y".repeat(2000) },
    { role: "user", content: "new question" },
  ];
  const settings = { temperature: 0.7, seed: -1, maxTokens: 512, contextOverflow: "truncate" };
  const result = await engine.chat({ conversationId: "t1", messages: longHistory, systemPrompt: "sys", settings });
  assert.equal(result.text, "Quack");
  assert.equal(result.manifest.history.truncated, true);
});

// IDEA-1082: strict mode still fails loudly on the same overflow.
test("strict overflow still throws 413", async (t) => {
  const counter = { calls: 0 };
  const engine = await loadedEngine(t, counter);
  const longHistory = [
    { role: "user", content: "old question " + "x".repeat(2000) },
    { role: "assistant", content: "old answer " + "y".repeat(2000) },
    { role: "user", content: "new question" },
  ];
  const settings = { temperature: 0.7, seed: -1, maxTokens: 512, contextOverflow: "strict" };
  await assert.rejects(
    engine.chat({ conversationId: "s1", messages: longHistory, systemPrompt: "sys", settings }),
    (error) => error.code === "context_overflow",
  );
});

// IDEA-1076: the completion path shares the exact-repeat cache.
test("deterministic completion repeats hit the memory-only cache", async (t) => {
  let calls = 0;
  const loadRuntime = async () => ({
    LlamaChatSession: class {
      constructor() {}
      getChatHistory() { return []; }
      setChatHistory() {}
      dispose() {}
      async promptWithMeta() { return { stopReason: "eogToken" }; }
    },
    LlamaCompletion: class {
      constructor() {}
      dispose() {}
      async generateCompletionWithMeta(prompt, options) {
        calls += 1;
        options.onTextChunk("Done");
        options.onToken([1]);
        return { metadata: { stopReason: "eogToken" } };
      }
    },
    getModuleVersion: async () => "test",
    getLlama: async () => ({
      gpu: false,
      maxThreads: 4,
      loadModel: async () => ({
        trainContextSize: 4096,
        tokenize: (text) => [...String(text)],
        createContext: async ({ contextSize }) => ({
          contextSize,
          sequencesLeft: 1,
          getSequence: () => ({ dispose() {} }),
        }),
        dispose: async () => {},
      }),
      dispose: async () => {},
    }),
  });
  const registry = { findById: () => ENTRY };
  const engine = new LlamaEngine({ registry, logger: quiet, availableMemory: () => 8 * GIB, loadRuntime });
  await engine.load({ modelId: "m1" });
  t.after(() => engine.dispose().catch(() => {}));
  const settings = { temperature: 0, seed: 3, maxTokens: 16 };
  const first = await engine.complete({ conversationId: "k1", prompt: "say hi", settings });
  assert.equal(first.text, "Done");
  assert.equal(first.stats.cached, false);
  const second = await engine.complete({ conversationId: "k2", prompt: "say hi", settings });
  assert.equal(second.stats.cached, true);
  assert.equal(calls, 1);
});

// IDEA-1082: truncate mode drops oldest turns and marks the manifest.
// (Covered by "truncate overflow survives long history and flags the manifest"
// above with a 4k-char history against the 4096-token test context.)
