import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluator } from "../benchmarks/tune-evaluate.mjs";

function recordingEngine(reply = () => "quack") {
  const engine = {
    loads: [],
    reconfigures: [],
    chats: [],
    async load(options) {
      engine.loads.push(options);
    },
    async reconfigure(options) {
      engine.reconfigures.push(options);
    },
    async status() {
      return { memory: { cpuRam: 4096, gpuVram: 8192 } };
    },
    async chat(request) {
      engine.chats.push(request);
      const text = reply(request);
      if (text instanceof Error) throw text;
      return { text, stats: { ms: 250, tokensPerSecond: 12.5 } };
    },
    dropSession() {},
  };
  return engine;
}

const SETTINGS = { contextSize: 4096, threads: 4, batchSize: 512, kvCache: "f16", temperature: 0.3, topP: 0.9, topK: 40, minP: 0.05, repeatPenalty: 1.1, maxTokens: 64 };

test("an evaluation scores items with the suite checks and reports latency, speed and memory", async () => {
  const evaluate = createEvaluator({ engine: recordingEngine(() => "0"), modelId: "m1" });
  const out = await evaluate(SETTINGS, ["read-sumTo-1"], 42);
  assert.equal(out.memoryBytes, 4096);
  assert.equal(out.gpuVram, 8192, "GPU VRAM stays with the measurement");
  assert.deepEqual(out.prompts.map(({ id, passed, total, ms, tokensPerSecond, error }) => ({ id, ok: passed === total, ms, tokensPerSecond, error })), [
    { id: "read-sumTo-1", ok: true, ms: 250, tokensPerSecond: 12.5, error: null },
  ]);
});

test("the model reloads only for model-level settings; context-level changes reconfigure in place", async () => {
  const engine = recordingEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  await evaluate(SETTINGS, ["read-sumTo-1"], 42);
  await evaluate({ ...SETTINGS, temperature: 0.9, maxTokens: 128 }, ["read-sumTo-1"], 7);
  assert.equal(engine.loads.length, 1);
  assert.equal(engine.reconfigures.length, 0);
  // A thread sweep candidate only re-creates the context on the resident model.
  await evaluate({ ...SETTINGS, threads: 8 }, ["read-sumTo-1"], 42);
  assert.equal(engine.loads.length, 1, "no model reload for a threads candidate");
  assert.equal(engine.reconfigures.length, 1);
  assert.equal(engine.reconfigures[0].threads, 8);
  assert.equal(engine.reconfigures[0].modelId, undefined, "the resident model is implied");
  // A batch candidate reconfigures too, and never reloads.
  await evaluate({ ...SETTINGS, threads: 8, batchSize: 256 }, ["read-sumTo-1"], 42);
  assert.equal(engine.loads.length, 1);
  assert.equal(engine.reconfigures.length, 2);
  assert.equal(engine.reconfigures[1].batchSize, 256);
  // A model-level setting change still pays the full load.
  await evaluate({ ...SETTINGS, threads: 8, batchSize: 256, gpuLayers: 4 }, ["read-sumTo-1"], 42);
  assert.equal(engine.loads.length, 2);
  assert.equal(engine.loads[1].gpuLayers, 4);
  assert.equal(engine.loads[1].modelId, "m1");
  // The first load lifts the runtime thread cap above every axis candidate.
  assert.equal(engine.loads[0].maxThreads, 64, "per-candidate thread hints are never clipped");
});

test("a draft model rides the load option and its change pays the full reload", async () => {
  const engine = recordingEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  await evaluate({ ...SETTINGS, draftModel: "d1" }, ["read-sumTo-1"], 42);
  assert.equal(engine.loads.length, 1, "the first load carries the draft model");
  assert.equal(engine.loads[0].draftModel, "d1");
  // Context-level churn keeps the resident draft: no reload.
  await evaluate({ ...SETTINGS, draftModel: "d1", threads: 8 }, ["read-sumTo-1"], 42);
  assert.equal(engine.loads.length, 1);
  assert.equal(engine.reconfigures.length, 1);
  // Turning the draft off is a model-level change: full reload.
  await evaluate({ ...SETTINGS }, ["read-sumTo-1"], 42);
  assert.equal(engine.loads.length, 2);
  assert.equal(engine.loads[1].draftModel, undefined);
});

test("sampling settings, the seed and the tuned token budget reach the engine", async () => {
  const engine = recordingEngine();
  await createEvaluator({ engine, modelId: "m1" })({ ...SETTINGS, temperature: 0.6, maxTokens: 96 }, ["read-sumTo-1"], 1234);
  const sent = engine.chats.at(-1).settings;
  assert.equal(sent.temperature, 0.6);
  assert.equal(sent.maxTokens, 96, "the tuned budget, not the item's own");
  assert.equal(sent.seed, 1234);
  assert.equal(sent.topK, 40);
});

test("code-only sampling keys reach the engine with off/empty defaults", async () => {
  const engine = recordingEngine();
  await createEvaluator({ engine, modelId: "m1" })(SETTINGS, ["read-sumTo-1"], 42);
  const defaults = engine.chats.at(-1).settings;
  assert.equal(defaults.dryStrength, 0);
  assert.equal(defaults.dryBase, 1.75);
  assert.equal(defaults.dryAllowedLength, 4);
  assert.equal(defaults.responsePrefix, "");
  assert.deepEqual(defaults.customStopTriggers, []);
  await createEvaluator({ engine, modelId: "m1" })(
    { ...SETTINGS, dryStrength: 0.8, responsePrefix: "```", customStopTriggers: ["```"] },
    ["read-sumTo-1"],
    43,
  );
  const tuned = engine.chats.at(-1).settings;
  assert.equal(tuned.dryStrength, 0.8);
  assert.equal(tuned.responsePrefix, "```");
  assert.deepEqual(tuned.customStopTriggers, ["```"]);
});

test("without a tuned budget each item keeps its own", async () => {
  const engine = recordingEngine();
  await createEvaluator({ engine, modelId: "m1" })({ ...SETTINGS, maxTokens: null }, ["read-sumTo-1"], 42);
  assert.ok(engine.chats.at(-1).settings.maxTokens > 8);
  assert.notEqual(engine.chats.at(-1).settings.maxTokens, null);
});

test("an engine error fails the item instead of the tune", async () => {
  const evaluate = createEvaluator({ engine: recordingEngine(() => new Error("context full")), modelId: "m1" });
  const [item] = (await evaluate(SETTINGS, ["read-sumTo-1"], 42)).prompts;
  assert.equal(item.passed, 0);
  assert.equal(item.error, "context full");
});

test("an unknown item id is refused", async () => {
  const evaluate = createEvaluator({ engine: recordingEngine(), modelId: "m1" });
  await assert.rejects(evaluate(SETTINGS, ["no-such-item"], 42), (error) => error.code === "unknown_item");
});

test("each reload is warmed up before an item is timed", async () => {
  const engine = recordingEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  await evaluate(SETTINGS, ["read-sumTo-1"], 42);
  await evaluate(SETTINGS, ["read-sumTo-1"], 7);
  assert.equal(engine.chats.length, 3, "one warm-up, then two timed answers");
  assert.ok(engine.chats[0].settings.maxTokens <= 8);
});

test("a load that fails marks every item failed with the reason instead of stopping the tune", async () => {
  const engine = recordingEngine();
  engine.load = async (options) => {
    if (options.kvCache === "q4_0") throw new Error("unsupported KV cache type");
    engine.loads.push(options);
  };
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  const failed = await evaluate({ ...SETTINGS, kvCache: "q4_0" }, ["read-sumTo-1", "read-sumTo-2"], 42);
  assert.deepEqual(failed.prompts.map((item) => [item.id, item.passed, item.ms, item.error]), [
    ["read-sumTo-1", 0, null, "load failed: unsupported KV cache type"],
    ["read-sumTo-2", 0, null, "load failed: unsupported KV cache type"],
  ]);
  const recovered = await evaluate(SETTINGS, ["read-sumTo-1"], 42);
  assert.equal(recovered.prompts[0].error, null, "the next settings load normally");
});

test("prompt settings reach the engine and each answer reports its tokens and a digest of its text", async () => {
  const engine = recordingEngine((request) => `answer for ${request.systemPrompt}`);
  engine.chat = async (request) => {
    engine.chats.push(request);
    return { text: `answer for ${request.systemPrompt}`, stats: { ms: 100, tokensPerSecond: 10, outputTokens: 7 } };
  };
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  const first = await evaluate({ ...SETTINGS, systemPrompt: "Think from first principles.", reasoning: "auto", promptRepeat: 2 }, ["read-sumTo-1"], 42);
  const sent = engine.chats.at(-1);
  assert.equal(sent.systemPrompt, "Think from first principles.");
  assert.equal(sent.settings.reasoning, "auto");
  assert.equal(sent.settings.promptRepeat, 2);
  assert.equal(first.prompts[0].outputTokens, 7);
  assert.match(first.prompts[0].digest, /^[a-f0-9]{16}$/);
  const other = await evaluate({ ...SETTINGS, systemPrompt: "Embrace ambiguity." }, ["read-sumTo-1"], 42);
  assert.notEqual(other.prompts[0].digest, first.prompts[0].digest);
  assert.equal(engine.chats.at(-1).settings.reasoning, "off", "reasoning is off unless a candidate turns it on");
});

test("with parallel answers the model loads that many sequences and runs that many items at once", async () => {
  let running = 0;
  let peak = 0;
  const engine = recordingEngine();
  engine.chat = async (request) => {
    engine.chats.push(request);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    return { text: "quack", stats: { ms: 10, tokensPerSecond: 5, outputTokens: 1 } };
  };
  const evaluate = createEvaluator({ engine, modelId: "m1", parallel: 3 });
  const out = await evaluate(SETTINGS, ["read-sumTo-1", "read-sumTo-2", "read-clamp-1", "needle", "code-palindrome"], 42);
  assert.equal(engine.loads[0].sequences, 3);
  assert.equal(peak, 3);
  assert.deepEqual(out.prompts.map((item) => item.id), ["read-sumTo-1", "read-sumTo-2", "read-clamp-1", "needle", "code-palindrome"], "results keep item order");
  peak = 0;
  await evaluate({ ...SETTINGS, parallelism: 1 }, ["read-sumTo-1", "read-sumTo-2", "read-clamp-1"], 7);
  assert.equal(peak, 1, "timing stages answer one at a time");
  assert.equal(engine.loads.length, 1, "switching to one at a time does not reload the model");
});

test("every untimed answer passes the pause point first; timed answers do not", async () => {
  const engine = recordingEngine();
  let pauses = 0;
  const evaluate = createEvaluator({ engine, modelId: "m1", beforeAnswer: async () => { pauses += 1; } });
  await evaluate(SETTINGS, ["read-sumTo-1", "read-sumTo-2"], 42);
  assert.equal(pauses, 2);
  await evaluate({ ...SETTINGS, timed: true }, ["read-sumTo-1"], 7);
  assert.equal(pauses, 2);
});
