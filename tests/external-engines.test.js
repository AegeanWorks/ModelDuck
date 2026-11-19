import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { createEvaluator } from "../benchmarks/tune-evaluate.mjs";
import { tune } from "../benchmarks/tune.mjs";
import { LlamaServerBackend, OllamaBackend, RoutedEngine, ServerEngine } from "../src/external-engines.js";
import { PROMPTS } from "../benchmarks/suite.mjs";
import { externalSetFrom } from "../src/inference-engines.js";

const ENTRY = { id: "m1", name: "Tiny", fileName: "tiny-q4_k_m.gguf", path: "C:\\models\\tiny-q4_k_m.gguf" };
const REGISTRY = { findById: (id) => (id === "m1" ? ENTRY : null) };

function serve(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : null;
        requests.push({ method: req.method, url: req.url, body: parsed });
        const out = handler({ method: req.method, url: req.url, body: parsed, count: requests.length });
        if (out.ndjson) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.end(out.ndjson.map((event) => `${JSON.stringify(event)}
`).join(""));
          return;
        }
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json ?? {}));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, close: () => new Promise((done) => server.close(done)) }));
  });
}

// A llama-server stand-in: "spawning" it starts an HTTP server on the port the command line asked for.
function fakeLlamaServer({ healthyAfter = 1, exitWith = null, reply } = {}) {
  const spawned = [];
  const spawnImpl = (binary, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    const port = Number(args[args.indexOf("--port") + 1]);
    const record = { binary, args, port, requests: [], killed: false, child };
    spawned.push(record);
    let server = null;
    child.kill = () => {
      record.killed = true;
      child.exitCode = 0;
      server?.close();
      child.emit("exit", 0);
    };
    if (exitWith !== null) {
      setImmediate(() => {
        child.stderr.emit("data", "error: unknown argument: -ctk\nfailed to load model");
        child.exitCode = exitWith;
        child.emit("exit", exitWith);
      });
      return child;
    }
    let health = 0;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/health") {
          health += 1;
          res.writeHead(health >= healthyAfter ? 200 : 503).end("{}");
          return;
        }
        record.requests.push({ url: req.url, ...JSON.parse(body) });
        // The real server streams: content pieces, then a finish chunk carrying usage and timings, then [DONE].
        const answer = reply ?? { text: "Four.", finish: "stop", usage: { prompt_tokens: 12, completion_tokens: 3 }, timings: { prompt_n: 12, prompt_ms: 24, predicted_n: 3, predicted_per_second: 41.234 } };
        const chat = req.url.includes("chat");
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (let at = 0; at < answer.text.length; at += 2) {
          const piece = answer.text.slice(at, at + 2);
          res.write(`data: ${JSON.stringify({ choices: [chat ? { delta: { content: piece }, finish_reason: null } : { text: piece, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ ...(chat ? { delta: {} } : { text: "" }), finish_reason: answer.finish }], usage: answer.usage, timings: answer.timings })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(port, "127.0.0.1");
    return child;
  };
  return { spawnImpl, spawned };
}

const LOAD = { contextSize: 4096, threads: 6, batchSize: 256, sequences: 2, gpuBackend: "cpu", gpuLayers: 0, kvCache: "q8_0", flashAttention: "off", useMmap: false };

test("a load becomes llama-server flags: context per slot, GPU layers only on a GPU, the kv types, mmap", () => {
  const args = LlamaServerBackend.args({ entry: ENTRY, load: LOAD, port: 8123 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("-m"), ENTRY.path);
  assert.equal(at("--port"), "8123");
  assert.equal(at("-c"), "8192", "4096 tokens for each of 2 slots");
  assert.equal(at("-np"), "2");
  assert.equal(at("-t"), "6");
  assert.equal(at("-ngl"), "0", "cpu offloads nothing");
  assert.equal(at("-ctk"), "q8_0");
  assert.equal(at("-fa"), "off");
  assert.deepEqual(args.slice(args.indexOf("-lm"), args.indexOf("-lm") + 2), ["-lm", "none"]);
  const gpu = LlamaServerBackend.args({ entry: ENTRY, load: { ...LOAD, gpuBackend: "vulkan", gpuLayers: "max", useMmap: "auto" }, port: 1 });
  assert.equal(gpu[gpu.indexOf("-ngl") + 1], "999");
  assert.equal(gpu.includes("-lm"), false, "auto mmap sends nothing");
});

test("llama-server is started, waited for until healthy, asked, and stopped", async () => {
  const { spawnImpl, spawned } = fakeLlamaServer({ healthyAfter: 3 });
  const backend = new LlamaServerBackend({ binary: "llama-server.exe", spawnImpl });
  await backend.start({ entry: ENTRY, load: LOAD });
  const result = await backend.generate({ messages: [{ role: "user", content: "2+2?" }], settings: { maxTokens: 64, temperature: 0, topP: 0.9, topK: 20, minP: 0.05, repeatPenalty: 1.1, seed: 7 } });
  assert.deepEqual(result, { text: "Four.", stopReason: "eogToken", promptTokens: 12, outputTokens: 3, tokensPerSecond: 41.23, firstTokenMs: 24 });
  const sent = spawned[0].requests[0];
  assert.equal(sent.max_tokens, 64);
  assert.equal(sent.seed, 7);
  assert.equal(sent.top_k, 20);
  assert.equal(sent.min_p, 0.05);
  assert.equal(sent.cache_prompt, false, "every answer pays for its own prompt, as the in-process engine does");
  await backend.stop();
  assert.equal(spawned[0].killed, true);
});

test("a length finish is reported as the token cap, and a restart replaces the server", async () => {
  const { spawnImpl, spawned } = fakeLlamaServer({ reply: { text: "cut", finish: "length", usage: {}, timings: {} } });
  const backend = new LlamaServerBackend({ binary: "b", spawnImpl });
  await backend.start({ entry: ENTRY, load: LOAD });
  assert.equal((await backend.generate({ messages: [], settings: {} })).stopReason, "maxTokens");
  await backend.start({ entry: ENTRY, load: { ...LOAD, threads: 2 } });
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].killed, true, "the first server was stopped before the second started");
  await backend.stop();
});

test("a llama-server that dies while loading says why, with the last lines it printed", async () => {
  const { spawnImpl } = fakeLlamaServer({ exitWith: 1 });
  const backend = new LlamaServerBackend({ binary: "b", spawnImpl });
  await assert.rejects(() => backend.start({ entry: ENTRY, load: LOAD }), (error) => error.code === "engine_start_failed" && /exited with 1/.test(error.why) && /unknown argument: -ctk/.test(error.why) && Boolean(error.fix));
});

test("a llama-server that never becomes healthy is stopped and reported", async () => {
  const { spawnImpl, spawned } = fakeLlamaServer({ healthyAfter: 1e9 });
  const backend = new LlamaServerBackend({ binary: "b", spawnImpl, startTimeoutMs: 400 });
  await assert.rejects(() => backend.start({ entry: ENTRY, load: LOAD }), (error) => error.code === "engine_start_timeout");
  assert.equal(spawned[0].killed, true, "a server that did not come up is not left running");
});

function ollamaServer({ models = [{ name: "tiny:latest" }], version = "0.5.1" } = {}) {
  return serve(({ url, body }) => {
    if (url === "/api/version") return { json: { version } };
    if (url === "/api/tags") return { json: { models } };
    if (url === "/api/generate") return { json: { done: true } };
    if (url === "/api/chat") {
      return { ndjson: [{ message: { content: "echo " }, done: false }, { message: { content: String(body.options.num_predict) }, done: false }, { done: true, done_reason: "length", prompt_eval_count: 30, prompt_eval_duration: 60_000_000, eval_count: 20, eval_duration: 400_000_000 }] };
    }
    return { status: 404, json: {} };
  });
}

test("Ollama is loaded with the load's options and answers with its own timings", async () => {
  const server = await ollamaServer();
  try {
    const backend = new OllamaBackend({ baseUrl: `http://127.0.0.1:${server.port}` });
    await backend.start({ entry: ENTRY, load: LOAD });
    const preload = server.requests.find((request) => request.url === "/api/generate").body;
    assert.equal(preload.model, "tiny:latest", "the tag that shares the file's stem");
    assert.equal(preload.options.num_ctx, 4096);
    assert.equal(preload.options.num_gpu, 0, "a cpu candidate forbids GPU layers");
    const result = await backend.generate({ messages: [{ role: "user", content: "hi" }], settings: { maxTokens: 50, temperature: 0, topP: 1, topK: 40, minP: 0.05, repeatPenalty: 1.1, seed: 3 } });
    assert.deepEqual(result, { text: "echo 50", stopReason: "maxTokens", promptTokens: 30, outputTokens: 20, tokensPerSecond: 50, firstTokenMs: 60 });
    const chat = server.requests.find((request) => request.url === "/api/chat").body;
    assert.equal(chat.options.seed, 3);
    assert.equal(chat.options.num_ctx, 4096, "the same options, so Ollama does not reload");
    await new OllamaBackend({ baseUrl: `http://127.0.0.1:${server.port}` }).start({ entry: ENTRY, load: { ...LOAD, gpuBackend: "auto", gpuLayers: "max" } });
    const auto = server.requests.filter((request) => request.url === "/api/generate").at(-1).body;
    assert.equal("num_gpu" in auto.options, false, "a GPU candidate leaves the choice to Ollama");
  } finally {
    await server.close();
  }
});

test("Ollama that is not running, or has no matching model, refuses with a Why and a Fix", async () => {
  const down = new OllamaBackend({ baseUrl: "http://127.0.0.1:1", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(() => down.start({ entry: ENTRY, load: LOAD }), (error) => error.code === "engine_start_failed" && /No Ollama server/.test(error.why) && Boolean(error.fix));
  const server = await ollamaServer({ models: [{ name: "llama3.2:3b" }] });
  try {
    const backend = new OllamaBackend({ baseUrl: `http://127.0.0.1:${server.port}` });
    await assert.rejects(() => backend.start({ entry: ENTRY, load: LOAD }), (error) => /matches tiny-q4_k_m.gguf/.test(error.why) && /--ollama-model/.test(error.fix));
    await new OllamaBackend({ baseUrl: `http://127.0.0.1:${server.port}`, model: "llama3.2:3b" }).start({ entry: ENTRY, load: LOAD });
  } finally {
    await server.close();
  }
});

function recordingBackend(log) {
  return {
    start: async (args) => { log.push(["start", args.load]); },
    generate: async (args) => { log.push(["generate", args.messages, args.settings.reasoning]); return { text: "ok", stopReason: "eogToken", promptTokens: 5, outputTokens: 2, tokensPerSecond: 20, firstTokenMs: 10 }; },
    stop: async () => { log.push(["stop"]); },
  };
}

test("a server engine speaks the evaluator's interface: load, chat with a system prompt, reconfigure, unload", async () => {
  const log = [];
  const engine = new ServerEngine({ id: "fake", registry: REGISTRY, backend: recordingBackend(log) });
  await assert.rejects(() => engine.chat({ messages: [], settings: {} }), (error) => error.code === "model_not_loaded");
  await engine.load({ modelId: "m1", ...LOAD });
  assert.equal(engine.loadedId, "m1");
  assert.equal((await engine.status()).memory, null, "an external engine's memory is not ours to read");
  const result = await engine.chat({ conversationId: "c", messages: [{ role: "user", content: "hi" }], systemPrompt: "Be brief.", settings: { reasoning: "off" } });
  assert.equal(result.text, "ok");
  assert.equal(result.stats.tokensPerSecond, 20);
  assert.equal(result.stats.stopReason, "eogToken");
  assert.equal(result.stats.promptTokens, 5);
  assert.ok(result.stats.ms >= 0);
  assert.deepEqual(log.find((entry) => entry[0] === "generate")[1], [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }]);
  await engine.reconfigure({ threads: 2 });
  const starts = log.filter((entry) => entry[0] === "start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1][1].threads, 2);
  assert.equal(starts[1][1].contextSize, 16384, "a reconfigure keeps what it did not change (and the 16K floor)");
  await engine.unload();
  assert.equal(engine.loadedId, null);
  assert.equal(log.at(-1)[0], "stop");
  await assert.rejects(() => engine.load({ modelId: "zzz" }), (error) => error.code === "model_not_found");
});

function fakeInProcess(log) {
  return {
    loadedId: null,
    busy: false,
    phase: "idle",
    startBackend: async (backend) => { log.push(`in:startBackend ${backend}`); },
    status: async () => ({ memory: { cpuRam: 1 } }),
    load: async (options) => { log.push(`in:load ${options.modelId}`); },
    reconfigure: async () => { log.push("in:reconfigure"); },
    chat: async () => ({ text: "in-process", stats: {} }),
    dropSession: () => {},
    unload: async () => { log.push("in:unload"); },
    teardown: async () => ({}),
    dispose: async () => { log.push("in:dispose"); },
  };
}

test("the routed engine uses the in-process engine unless a load names another, and never keeps two loaded", async () => {
  const log = [];
  const external = { fake: new ServerEngine({ id: "fake", registry: REGISTRY, backend: recordingBackend(log) }) };
  const routed = new RoutedEngine({ inProcess: fakeInProcess(log), external });
  await routed.startBackend("vulkan");
  await routed.load({ modelId: "m1" });
  assert.equal((await routed.chat({})).text, "in-process");
  await routed.load({ modelId: "m1", engine: "fake" });
  assert.deepEqual(log.filter((line) => typeof line === "string"), ["in:startBackend vulkan", "in:load m1", "in:unload"], "the in-process model was unloaded before the external one loaded");
  assert.equal((await routed.chat({ messages: [], settings: {} })).text, "ok");
  await routed.reconfigure({ threads: 2 });
  assert.equal(log.filter((line) => line[0] === "start").length, 2, "a reconfigure goes to the engine that is running");
  await routed.load({ modelId: "m1" });
  assert.equal((await routed.chat({})).text, "in-process");
  assert.equal(log.at(-1), "in:load m1");
  await assert.rejects(() => routed.load({ modelId: "m1", engine: "nope" }), (error) => error.code === "engine_unknown" && /fake/.test(error.fix));
  await routed.dispose();
  assert.ok(log.includes("in:dispose"));
});

test("the evaluator reloads onto another engine when a candidate names one, and answers through it", async () => {
  const log = [];
  const inProcess = {
    ...fakeInProcess(log),
    chat: async () => ({ text: "in-process", stats: { ms: 5, tokensPerSecond: 100 } }),
  };
  const external = { fake: new ServerEngine({ id: "fake", registry: REGISTRY, backend: recordingBackend(log) }) };
  const routed = new RoutedEngine({ inProcess, external });
  const evaluate = createEvaluator({ engine: routed, modelId: "m1" });
  const item = PROMPTS[0].id;
  const first = await evaluate({ temperature: 0 }, [item], 1);
  assert.equal(first.prompts[0].text, "in-process");
  const second = await evaluate({ temperature: 0, engine: "fake" }, [item], 1);
  assert.equal(second.prompts[0].text, "ok");
  assert.equal(second.prompts[0].tokensPerSecond, 20);
  assert.ok(log.includes("in:unload"), "switching engine is a full reload");
  const again = await evaluate({ temperature: 0, engine: "fake", threads: 4 }, [item], 1);
  assert.equal(again.prompts[0].text, "ok");
  assert.equal(log.filter((line) => line[0] === "start").length, 2, "a context-level change restarts the external engine instead of reloading the model onto another");
});

/** Stage 0 with external candidates; behaviour is given per "engine:backend", or per in-process backend. */
async function probe(behaviour, externalEngines) {
  const calls = [];
  const evaluate = async (settings, itemIds) => {
    calls.push(settings);
    const key = settings.engine ? `${settings.engine}:${settings.gpuBackend}` : settings.gpuBackend === "cpu" || !settings.gpuBackend ? "cpu" : `${settings.gpuBackend}:${settings.gpuLayers}`;
    const device = behaviour[key] ?? behaviour.cpu;
    return {
      prompts: itemIds.map((id, index) => device.error
        ? { id, passed: 0, total: 1, error: device.error, ms: null }
        : { id, passed: index < device.passed ? 1 : 0, total: 1, ms: device.ms * (1 + index / 20), tokensPerSecond: 1000 / device.ms, digest: id }),
    };
  };
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
  const result = await tune({
    evaluate,
    base: { threads: 4 },
    tasks: [],
    stages: ["device"],
    modelLayers: 28,
    externalEngines,
    deviceBackends: ["cpu"],
    rungs: { load: [ids("mix", 2)], speed: [ids("speed", 6)] },
    qualityAxes: [],
    speedAxes: [],
  });
  return { result, calls };
}

const EXTERNAL = [{ engine: "llama-server", gpuBackend: "cpu", gpuLayers: 0 }];

test("stage 0 measures an external engine like a GPU but never saves it: the app serves in-process only", async () => {
  const { result, calls } = await probe({ cpu: { ms: 1000, passed: 6 }, "llama-server:cpu": { ms: 200, passed: 6 } }, EXTERNAL);
  assert.ok(calls.some((settings) => settings.engine === "llama-server"), "the external engine answered the speed items");
  assert.deepEqual(result.load.settings, { gpuBackend: "cpu", gpuLayers: 0 }, "the profile keeps a device the app can serve");
  assert.equal("engine" in result.load.settings, false);
  const row = result.device.probe.find((entry) => entry.patch.engine === "llama-server");
  assert.match(row.verdict, /faster than the CPU, but not adopted: the app serves in-process only/);
  assert.match(result.device.reason, /Also measured faster than the CPU but not adopted.*llama-server 5 tok\/s, 6\/6/);
});

test("stage 0 still prefers the fastest in-process device when an external engine is faster still", async () => {
  const { result } = await probe({ cpu: { ms: 1000, passed: 6 }, "vulkan:max": { ms: 400, passed: 6 }, "ollama:cpu": { ms: 100, passed: 6 } }, [{ engine: "ollama", gpuBackend: "cpu", gpuLayers: 0 }]);
  assert.deepEqual(result.load.settings, { gpuBackend: "cpu", gpuLayers: 0 }, "vulkan is not among the candidates here, so the CPU stays");
  const withGpu = await (async () => {
    const calls = [];
    const evaluate = async (settings, itemIds) => {
      calls.push(settings);
      const ms = settings.engine ? 100 : settings.gpuBackend === "vulkan" ? 400 : 1000;
      return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms, tokensPerSecond: 1000 / ms, digest: id })) };
    };
    return tune({ evaluate, base: { threads: 4 }, tasks: [], stages: ["device"], modelLayers: 28, deviceBackends: ["cpu", "vulkan"], externalEngines: [{ engine: "ollama", gpuBackend: "cpu", gpuLayers: 0 }], rungs: { load: [["mix-1", "mix-2"]], speed: [["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"]] }, qualityAxes: [], speedAxes: [] });
  })();
  assert.deepEqual(withGpu.load.settings, { gpuBackend: "vulkan", gpuLayers: "max" }, "the faster in-process device is adopted");
  assert.match(withGpu.device.reason, /ollama/);
});

test("an external engine that cannot run is a result for that candidate, not a failed tune", async () => {
  const { result } = await probe({ cpu: { ms: 1000, passed: 6 }, "llama-server:cpu": { error: "load failed: llama-server did not start" } }, EXTERNAL);
  assert.equal(result.stages.device, "done");
  assert.match(result.device.probe.find((entry) => entry.patch.engine === "llama-server").verdict, /did not run: load failed: llama-server did not start/);
  assert.deepEqual(result.load.settings, { gpuBackend: "cpu", gpuLayers: 0 });
});

test("the tuner's external engines come from what an assessment measured, and llama-bench only times", () => {
  const assessment = {
    results: [
      { id: "llama-bench", ok: true, location: null },
      { id: "llama-server", ok: true, location: "C:\\llama-server.exe", backends: ["cpu", "vulkan"] },
      { id: "ollama", ok: true },
      { id: "node-llama-cpp:cpu", ok: true },
    ],
  };
  const { engines, candidates, servable } = externalSetFrom(assessment, { registry: REGISTRY, roots: [], llamaServer: "llama-server-binary" });
  assert.deepEqual(Object.keys(engines).sort(), ["llama-server", "ollama"], "llama-bench cannot generate text");
  assert.deepEqual(candidates, [
    { engine: "llama-server", gpuBackend: "cpu", gpuLayers: 0 },
    { engine: "llama-server", gpuBackend: "vulkan", gpuLayers: "max" },
    { engine: "ollama", gpuBackend: "cpu", gpuLayers: 0 },
    { engine: "ollama", gpuBackend: "auto", gpuLayers: "max" },
  ]);
  assert.deepEqual(servable, ["ollama"], "the app can start Ollama from a saved profile, but not a binary passed on one command line");
  assert.deepEqual(externalSetFrom({ results: [{ id: "llama-server", ok: false }] }, { registry: REGISTRY }), { engines: {}, candidates: [], servable: [] }, "an engine that did not measure is not offered");
});

// ADR-159: tuning is based on the best token-generation engine. The device stage picks the fastest accurate
// engine the app can serve, external ones included, and every later stage then runs on it.
const idsOf = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

async function pick({ ms, passed = {}, servable = ["llama-server:cpu"], stages = ["device"], qualityAxes = [], gpu = false }) {
  const calls = [];
  const evaluate = async (settings, itemIds) => {
    calls.push(settings);
    const key = settings.engine ?? (settings.gpuBackend === "vulkan" ? "vulkan" : "cpu");
    return { prompts: itemIds.map((id, index) => ({ id, passed: index < (passed[key] ?? 6) ? 1 : 0, total: 1, ms: ms[key] * (1 + index / 20), tokensPerSecond: 1000 / ms[key], digest: id })) };
  };
  const result = await tune({
    evaluate, base: { threads: 4, kvCache: "f16" }, tasks: [], stages, modelLayers: 28,
    deviceBackends: gpu ? ["cpu", "vulkan"] : ["cpu"],
    externalEngines: [{ engine: "llama-server:cpu", gpuBackend: "cpu", gpuLayers: 0 }],
    servableEngines: servable,
    rungs: { load: [idsOf("mix", 6)], speed: [idsOf("speed", 6)] },
    qualityAxes, speedAxes: [],
  });
  return { result, calls };
}

test("a servable engine that is clearly faster and as accurate becomes the device: the profile is built on it", async () => {
  const { result } = await pick({ ms: { cpu: 1000, "llama-server:cpu": 400 } });
  assert.deepEqual(result.load.settings, { engine: "llama-server:cpu", gpuBackend: "cpu", gpuLayers: 0 });
  const row = result.device.probe.find((entry) => entry.patch.engine);
  assert.equal(row.verdict, "chosen");
  assert.match(result.device.reason, /^llama-server:cpu \(cpu with 0 layers\): 2\.5 tok\/s vs 1 tok\/s on the CPU/);
  assert.doesNotMatch(result.device.reason, /not adopted/);
});

test("an engine only slightly faster than the best in-process device does not displace it", async () => {
  const { result } = await pick({ ms: { cpu: 1000, vulkan: 400, "llama-server:cpu": 380 }, gpu: true });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: "max" }, "5% is noise, not a reason to run a second process");
  assert.match(result.device.probe.find((entry) => entry.patch.engine).verdict, /kept the in-process vulkan: .* only 5% faster/);
});

test("an engine clearly faster than the in-process GPU does displace it", async () => {
  const { result } = await pick({ ms: { cpu: 1000, vulkan: 400, "llama-server:cpu": 200 }, gpu: true });
  assert.equal(result.load.settings.engine, "llama-server:cpu");
});

test("a faster engine that answers fewer items correctly is not adopted", async () => {
  const { result } = await pick({ ms: { cpu: 1000, "llama-server:cpu": 200 }, passed: { cpu: 6, "llama-server:cpu": 4 } });
  assert.equal("engine" in result.load.settings, false);
  assert.match(result.device.probe.find((entry) => entry.patch.engine).verdict, /answered 4 of 6 correctly vs 6 on the CPU/);
});

test("an engine the app cannot serve is measured, not adopted, however fast", async () => {
  const { result } = await pick({ ms: { cpu: 1000, "llama-server:cpu": 100 }, servable: [] });
  assert.equal("engine" in result.load.settings, false);
  assert.match(result.device.probe.find((entry) => entry.patch.engine).verdict, /not adopted/);
});

test("every stage after the device stage runs on the adopted engine, so the whole profile is measured on it", async () => {
  const { result, calls } = await pick({
    ms: { cpu: 1000, "llama-server:cpu": 300 },
    stages: ["device", "quality"],
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q8_0"].map((kvCache) => ({ kvCache })) }],
  });
  assert.equal(result.load.settings.engine, "llama-server:cpu");
  const qualityCalls = calls.filter((settings) => settings.kvCache === "q8_0");
  assert.ok(qualityCalls.length > 0, "the quality stage ran");
  assert.ok(qualityCalls.every((settings) => settings.engine === "llama-server:cpu"), "no quality answer came from another engine");
});

// The speed items are mostly prompt, so an engine that reads prompts twice as fast answers twice as fast even when
// its decode speed is the same. The choice follows the time to answer, not decode tokens/s alone.
test("the best engine is the one that answers the same items fastest end to end, not the one with the higher decode speed", async () => {
  const evaluate = async (settings, itemIds) => {
    const external = Boolean(settings.engine);
    return {
      prompts: itemIds.map((id) => ({
        id, passed: 1, total: 1, digest: id,
        promptTokens: 1000, outputTokens: 20,
        ms: external ? 100 : 200,
        // Decode speed is the same on both, as measured in the real run.
        tokensPerSecond: 100,
        firstTokenMs: external ? 50 : 150,
      })),
    };
  };
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
  const result = await tune({
    evaluate, base: { threads: 4 }, tasks: [], stages: ["device"], modelLayers: 28, deviceBackends: ["cpu", "vulkan"],
    externalEngines: [{ engine: "llama-server:vulkan", gpuBackend: "vulkan", gpuLayers: "max" }], servableEngines: ["llama-server:vulkan"],
    rungs: { load: [ids("mix", 6)], speed: [ids("speed", 6)] }, qualityAxes: [], speedAxes: [],
  });
  assert.equal(result.load.settings.engine, "llama-server:vulkan", "twice as fast to answer, so it wins although decode tokens/s are equal");
});

// The in-process engine never serves a context longer than the model was trained for (and keeps a 16K floor for
// models that were trained for more). An external engine must do the same, so a profile means the same thing on both.
test("an external engine clamps the context to what the model was trained for and reports both numbers", async () => {
  const log = [];
  const trained = { findById: () => ({ ...ENTRY, contextLength: 8192 }) };
  const engine = new ServerEngine({ id: "fake", registry: trained, backend: recordingBackend(log) });
  await engine.load({ modelId: "m1", contextSize: 32768, threads: 4 });
  assert.equal(log.find((entry) => entry[0] === "start")[1].contextSize, 8192, "the server is started at the trained size");
  const status = await engine.status();
  assert.deepEqual([status.requestedContextSize, status.contextSize, status.trainContextSize], [32768, 8192, 8192]);
  await engine.reconfigure({ threads: 2 });
  assert.equal(log.filter((entry) => entry[0] === "start").at(-1)[1].contextSize, 8192, "a restart keeps the clamp");
});

test("a model trained for more keeps at least the 16K floor, and one with no known size is not clamped", async () => {
  const sizes = async (contextLength, requested) => {
    const log = [];
    const engine = new ServerEngine({ id: "fake", registry: { findById: () => ({ ...ENTRY, contextLength }) }, backend: recordingBackend(log) });
    await engine.load({ modelId: "m1", contextSize: requested });
    return log.find((entry) => entry[0] === "start")[1].contextSize;
  };
  assert.equal(await sizes(131072, 2048), 16384, "a small request still gets the floor");
  assert.equal(await sizes(131072, 65536), 65536);
  assert.equal(await sizes(undefined, 4096), 16384);
  assert.equal(await sizes(2048, 16384), 2048, "a model trained for less is never given more");
});

test("the device stage records the version of the engine it adopted, and none for an in-process device", async () => {
  const evaluate = async (settings, itemIds) => ({ prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: settings.engine ? 100 : 1000, tokensPerSecond: 1000 / (settings.engine ? 100 : 1000), digest: id })) });
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
  const run = (engines, deviceBackends = ["cpu"]) => tune({
    evaluate, base: { threads: 4 }, tasks: [], stages: ["device"], modelLayers: 28, deviceBackends,
    externalEngines: engines, servableEngines: ["llama-server:cpu"], engineVersionOf: (id) => (id === "llama-server:cpu" ? "b12521" : null),
    rungs: { load: [ids("mix", 6)], speed: [ids("speed", 6)] }, qualityAxes: [], speedAxes: [],
  });
  const adopted = await run([{ engine: "llama-server:cpu", gpuBackend: "cpu", gpuLayers: 0 }]);
  assert.equal(adopted.device.engineVersion, "b12521");
  const inProcess = await run([], ["cpu", "vulkan"]);
  assert.equal(inProcess.device.settings.engine, undefined, "an in-process device was chosen");
  assert.equal("engineVersion" in inProcess.device, false);
});

// A serving engine process can die (a crash, or someone ends it). The next request must not stay broken.
const crashed = () => Object.assign(new Error("llama-server stopped"), { code: "engine_crashed" });

function crashingBackend({ crashes = 1, partial = false, restartFails = false } = {}) {
  const log = { starts: 0, generates: 0, remaining: crashes };
  return {
    log,
    start: async () => {
      log.starts += 1;
      if (restartFails && log.starts > 1) throw Object.assign(new Error("llama-server did not start"), { code: "engine_start_failed" });
    },
    generate: async ({ onToken }) => {
      log.generates += 1;
      if (log.remaining > 0) {
        log.remaining -= 1;
        if (partial) onToken("qu");
        throw crashed();
      }
      onToken("ok");
      return { text: "ok", stopReason: "eogToken", promptTokens: 1, outputTokens: 1, tokensPerSecond: 10, firstTokenMs: 1 };
    },
    complete: async () => ({ text: "ok", stopReason: "eogToken", promptTokens: 1, outputTokens: 1, tokensPerSecond: 10, firstTokenMs: 1 }),
    stop: async () => {},
  };
}

test("a request that finds the engine process dead restarts it once and is answered", async () => {
  const backend = crashingBackend();
  const engine = new ServerEngine({ id: "fake", registry: REGISTRY, backend });
  await engine.load({ modelId: "m1", contextSize: 2048 });
  const pieces = [];
  const answer = await engine.chat({ messages: [{ role: "user", content: "hi" }], settings: {}, onToken: (piece) => pieces.push(piece) });
  assert.equal(answer.text, "ok");
  assert.deepEqual(pieces, ["ok"], "the client sees only the answer, not the failed try");
  assert.deepEqual([backend.log.starts, backend.log.generates], [2, 2], "one restart, one retry");
  assert.equal((await engine.status()).restarts, 1);
  assert.equal(engine.loadedId, "m1", "the engine is serving again");
});

test("an engine that dies after it started answering is not retried, so the client never gets half an answer twice", async () => {
  const backend = crashingBackend({ partial: true });
  const engine = new ServerEngine({ id: "fake", registry: REGISTRY, backend });
  await engine.load({ modelId: "m1", contextSize: 2048 });
  await assert.rejects(() => engine.chat({ messages: [{ role: "user", content: "hi" }], settings: {} }), (error) => error.code === "engine_crashed");
  assert.equal(backend.log.starts, 1, "no restart behind a half-sent answer");
  // The next request finds it dead before sending anything, so that one is recovered.
  assert.equal((await engine.chat({ messages: [{ role: "user", content: "again" }], settings: {} })).text, "ok");
});

test("an engine that keeps dying is tried once, then reported with its own reason", async () => {
  const twice = crashingBackend({ crashes: 2 });
  const engine = new ServerEngine({ id: "fake", registry: REGISTRY, backend: twice });
  await engine.load({ modelId: "m1", contextSize: 2048 });
  await assert.rejects(() => engine.chat({ messages: [{ role: "user", content: "hi" }], settings: {} }), (error) => error.code === "engine_crashed");
  assert.equal(twice.log.starts, 2, "one restart and no more");

  const cannot = crashingBackend({ restartFails: true });
  const stuck = new ServerEngine({ id: "fake", registry: REGISTRY, backend: cannot });
  await stuck.load({ modelId: "m1", contextSize: 2048 });
  await assert.rejects(() => stuck.chat({ messages: [{ role: "user", content: "hi" }], settings: {} }), (error) => error.code === "engine_start_failed");
  assert.equal((await stuck.status()).status, "error", "the status no longer claims the model is ready");
  assert.equal(stuck.loadedId, null);
});

test("a cancelled request is not mistaken for a crash", async () => {
  const backend = crashingBackend({ crashes: 0 });
  const engine = new ServerEngine({ id: "fake", registry: REGISTRY, backend });
  await engine.load({ modelId: "m1", contextSize: 2048 });
  const controller = new AbortController();
  backend.generate = async () => { controller.abort(); throw crashed(); };
  const result = await engine.chat({ messages: [{ role: "user", content: "hi" }], settings: {}, signal: controller.signal });
  assert.equal(result.stats.stopReason, "abort");
  assert.equal(backend.log.starts, 1);
});

test("llama-server reports a dead process as a crash with a Why and a Fix, not as a raw fetch failure", async () => {
  const { spawnImpl, spawned } = fakeLlamaServer();
  const backend = new LlamaServerBackend({ binary: "b", spawnImpl });
  await backend.start({ entry: ENTRY, load: LOAD });
  spawned[0].child.kill();
  await assert.rejects(
    () => backend.generate({ messages: [{ role: "user", content: "hi" }], settings: {} }),
    (error) => error.code === "engine_crashed" && /llama-server/.test(error.why) && Boolean(error.fix),
  );
  await backend.stop();
});

// A binary that cannot be started (deleted after it was registered, or not executable) used to emit an
// unhandled "error" event, which ends the whole process; it must be a refusal with a Why and a Fix instead.
test("a binary that cannot be started is a refusal, not a crash, and leaves no listener behind", async () => {
  const before = process.listenerCount("exit");
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {};
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn llama-server.exe ENOENT"), { code: "ENOENT" })));
    return child;
  };
  const backend = new LlamaServerBackend({ binary: "llama-server.exe", spawnImpl, startTimeoutMs: 5000 });
  await assert.rejects(() => backend.start({ entry: ENTRY, load: LOAD }), (error) => error.code === "engine_start_failed" && /ENOENT/.test(error.why) && Boolean(error.fix));
  assert.equal(process.listenerCount("exit"), before, "the exit hook is removed when the start fails");
});

test("a server that exits while loading leaves no exit listener behind", async () => {
  const before = process.listenerCount("exit");
  const { spawnImpl } = fakeLlamaServer({ exitWith: 1 });
  await assert.rejects(() => new LlamaServerBackend({ binary: "x", spawnImpl }).start({ entry: ENTRY, load: LOAD }), (error) => error.code === "engine_start_failed");
  assert.equal(process.listenerCount("exit"), before);
});

// The port is chosen before llama-server binds it; losing that race once must not fail the load.
test("a server that loses its port to another program is started again on a new port, once", async () => {
  const attempts = [];
  const healthy = fakeLlamaServer({ healthyAfter: 1 });
  const spawnImpl = (binary, args) => {
    attempts.push(args[args.indexOf("--port") + 1]);
    if (attempts.length > 1) return healthy.spawnImpl(binary, args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {};
    setImmediate(() => {
      child.stderr.emit("data", "couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 1\n");
      child.exitCode = 1;
      child.emit("exit", 1);
    });
    return child;
  };
  const backend = new LlamaServerBackend({ binary: "x", spawnImpl });
  await backend.start({ entry: ENTRY, load: LOAD });
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0], attempts[1], "the second try asks for a different port");
  await backend.stop();
});

test("an exit that is not about the port is not retried", async () => {
  const { spawnImpl, spawned } = fakeLlamaServer({ exitWith: 1 });
  await assert.rejects(() => new LlamaServerBackend({ binary: "x", spawnImpl }).start({ entry: ENTRY, load: LOAD }), (error) => error.code === "engine_start_failed");
  assert.equal(spawned.length, 1);
});
