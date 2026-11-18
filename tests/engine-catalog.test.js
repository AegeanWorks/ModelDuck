import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { tune } from "../benchmarks/tune.mjs";
import { BUILTIN_DESCRIPTORS, assertDescriptor, createEngineCatalog, engineContext, loadEnginePlugin } from "../src/engine-catalog.js";
import { OllamaBackend, OpenAICompatBackend, RoutedEngine, ServerEngine } from "../src/external-engines.js";
import { assessEngines, createEngineRegistry, defaultEngines, externalEngineFor, externalSetFrom } from "../src/inference-engines.js";
import { checkBackendContract } from "./engine-contract.js";

const ENTRY = { id: "m1", name: "Tiny", fileName: "tiny.gguf", path: "tiny.gguf" };
const MODELS = { findById: (id) => (id === "m1" ? ENTRY : null) };

// ---- a brand-new engine, defined here and nowhere in src/: the proof that adding one touches nothing else ----

/** An engine nobody has heard of: it answers "ok" at a speed the test sets. */
function fakeDuckBackend({ tokensPerSecond = 500 } = {}) {
  const run = async ({ signal, onToken, text = "quack" }) => {
    if (signal?.aborted) throw new Error("aborted");
    for (const piece of [text.slice(0, 2), text.slice(2)]) onToken?.(piece);
    return { text, stopReason: "eogToken", promptTokens: 5, outputTokens: 2, tokensPerSecond, firstTokenMs: 3 };
  };
  return {
    start: async () => {},
    stop: async () => {},
    unsupported: (settings) => (settings.responsePrefix ? ["responsePrefix"] : []),
    generate: (args) => run(args),
    complete: (args) => run(args),
  };
}

const fastDuck = (speed = 500) => ({
  kind: "fastduck",
  servable: true,
  owns: (id) => id === "fastduck" || id.startsWith("fastduck:"),
  adapters: () => [{
    id: "fastduck",
    label: "FastDuck",
    detect: async () => ({ available: true, reason: null, version: "9.9", backends: ["cpu"], location: "fastduck://local" }),
    measure: async () => ({ promptTps: 9000, genTps: speed, genRange: [speed, speed], runs: 1, detail: "toy engine" }),
  }],
  resolve: (id, ctx) => (id === "fastduck" ? new ServerEngine({ id, registry: ctx.registry, backend: fakeDuckBackend({ tokensPerSecond: speed }) }) : null),
  candidates: (result) => [{ engine: result.id, gpuBackend: "cpu", gpuLayers: 0 }],
});

const withFuture = (speed) => createEngineCatalog({ descriptors: [...BUILTIN_DESCRIPTORS, fastDuck(speed)] });

test("the built-in engines are a valid catalog and every id is owned by exactly one descriptor", () => {
  const catalog = createEngineCatalog();
  assert.deepEqual(catalog.descriptors().map((descriptor) => descriptor.kind), ["node-llama-cpp", "llama-bench", "llama-server", "ollama", "openai"]);
  const owners = (id) => catalog.descriptors().filter((descriptor) => descriptor.owns(id)).map((descriptor) => descriptor.kind);
  for (const id of ["node-llama-cpp:vulkan", "llama-bench", "llama-server", "llama-server:cuda", "ollama", "openai:vllm"]) assert.equal(owners(id).length, 1, id);
  assert.deepEqual(owners("llama-serverX"), [], "a prefix is not a kind");
  assert.equal(catalog.descriptorFor("nope"), null);
});

test("what the app can start from a profile is a property of the engine, not a list in the code", () => {
  const catalog = createEngineCatalog();
  assert.deepEqual(["llama-server:vulkan", "ollama"].map((id) => catalog.isServable(id)), [true, true]);
  assert.deepEqual(["openai:vllm", "llama-bench", "node-llama-cpp:cpu", "unknown"].map((id) => catalog.isServable(id)), [false, false, false, false]);
});

test("a descriptor that does not fit the contract is refused where it is added, naming what is wrong", () => {
  const good = fastDuck();
  assert.equal(assertDescriptor(good), good);
  const refuses = (change, pattern) => assert.throws(() => assertDescriptor({ ...good, ...change }), (error) => error.code === "engine_descriptor_invalid" && pattern.test(error.why) && /engine-catalog\.js/.test(error.fix));
  refuses({ kind: "Bad Name" }, /kind must be a lowercase name/);
  refuses({ owns: "no" }, /owns\(id\) must be a function/);
  refuses({ adapters: undefined }, /adapters\(ctx\) must be a function/);
  refuses({ servable: "yes" }, /servable must be true, false or a function/);
  refuses({ resolve: undefined }, /a servable engine needs resolve/);
  refuses({ candidates: 3 }, /candidates must be a function when given/);
  assert.throws(() => assertDescriptor(null), (error) => /not an object/.test(error.why));
  assert.throws(() => createEngineCatalog({ descriptors: [good, fastDuck()] }), (error) => /More than one descriptor is called "fastduck"/.test(error.why));
});

test("a descriptor can be loaded from a file, and a bad file says why", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-plugin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = path.join(dir, "plugin.mjs");
  fs.writeFileSync(good, 'export default { kind: "plug", servable: false, owns: (id) => id === "plug", adapters: () => [] };\n');
  assert.equal((await loadEnginePlugin(good)).kind, "plug");
  const named = path.join(dir, "named.mjs");
  fs.writeFileSync(named, 'export const descriptor = { kind: "named", servable: false, owns: (id) => id === "named", adapters: () => [] };\n');
  assert.equal((await loadEnginePlugin(named)).kind, "named");
  const broken = path.join(dir, "broken.mjs");
  fs.writeFileSync(broken, "export default { kind: 3 };\n");
  await assert.rejects(() => loadEnginePlugin(broken), (error) => error.code === "engine_descriptor_invalid" && error.why.includes("broken.mjs"));
  await assert.rejects(() => loadEnginePlugin(path.join(dir, "missing.mjs")), (error) => error.code === "engine_plugin_failed" && Boolean(error.fix));
});

test("a new engine is assessed with the others, with no change to the assessment code", async () => {
  const catalog = withFuture(750);
  const ids = defaultEngines({ catalog, roots: [], registry: MODELS }).map((adapter) => adapter.id);
  assert.ok(ids.includes("fastduck"), "the catalog's adapters include it");
  assert.deepEqual(ids.slice(-2), ["fastduck"].length === 1 ? [ids.at(-2), "fastduck"] : [], "it comes after the built-in engines, in catalog order");
  const report = await assessEngines({ registry: createEngineRegistry({ engines: defaultEngines({ catalog, roots: [] }).filter((adapter) => adapter.id === "fastduck") }), entry: ENTRY });
  assert.equal(report.fastest, "fastduck");
  assert.equal(report.results[0].version, "9.9");
});

test("a new engine becomes a tuner candidate and a servable one, from its own descriptor", () => {
  const catalog = withFuture(750);
  const assessment = { results: [{ id: "fastduck", ok: true, location: "fastduck://local", backends: ["cpu"] }, { id: "ollama", ok: false }] };
  const { engines, candidates, servable } = externalSetFrom(assessment, { catalog, registry: MODELS, roots: [] });
  assert.deepEqual(Object.keys(engines), ["fastduck"]);
  assert.deepEqual(candidates, [{ engine: "fastduck", gpuBackend: "cpu", gpuLayers: 0 }]);
  assert.deepEqual(servable, ["fastduck"]);
});

test("the tuner builds the whole profile on a new engine when it is the fastest, with no change to the tuner", async () => {
  const catalog = withFuture(750);
  const { candidates, servable } = externalSetFrom({ results: [{ id: "fastduck", ok: true }] }, { catalog, registry: MODELS, roots: [] });
  const calls = [];
  const evaluate = async (settings, itemIds) => {
    calls.push(settings);
    const ms = settings.engine === "fastduck" ? 100 : 1000;
    return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms, tokensPerSecond: 1000 / ms, digest: id })) };
  };
  const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
  const result = await tune({
    evaluate, base: { threads: 4, kvCache: "f16" }, tasks: [], stages: ["device", "quality"], modelLayers: 28,
    deviceBackends: ["cpu"], externalEngines: candidates, servableEngines: servable,
    rungs: { load: [ids("mix", 6)], speed: [ids("speed", 6)] },
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q8_0"].map((kvCache) => ({ kvCache })) }], speedAxes: [],
  });
  assert.equal(result.load.settings.engine, "fastduck");
  assert.ok(calls.filter((settings) => settings.kvCache === "q8_0").every((settings) => settings.engine === "fastduck"), "the quality stage ran on it too");
});

test("the app serves through a new engine named by a profile, and falls back honestly when it is gone", async () => {
  const catalog = withFuture(750);
  const inProcess = {
    loadedId: null, busy: false, phase: "idle",
    startBackend: async () => {}, status: async () => ({ status: "ready", engine: null }),
    load: async (options) => { inProcess.loaded = options; inProcess.loadedId = options.modelId; return {}; },
    reconfigure: async () => {}, chat: async () => ({ text: "in-process", stats: {} }), complete: async () => ({ text: "in-process", stats: {} }),
    dropSession: () => {}, unload: async () => {}, teardown: async () => ({}), dispose: async () => {},
  };
  const resolve = (id) => externalEngineFor(id, { catalog, registry: MODELS, roots: [], cachePrompt: true });
  const routed = new RoutedEngine({ inProcess, resolve, fallback: true });
  await routed.load({ modelId: "m1", engine: "fastduck", contextSize: 2048 });
  assert.equal(routed.engineId, "fastduck");
  const pieces = [];
  const answer = await routed.chat({ conversationId: "c", messages: [{ role: "user", content: "hi" }], settings: {}, onToken: (piece) => pieces.push(piece) });
  assert.deepEqual([answer.text, pieces.join("")], ["quack", "quack"], "streamed through the new engine");
  assert.equal((await routed.complete({ prompt: "x", settings: {} })).text, "quack");
  assert.equal((await routed.status()).engine, "fastduck");
  // The same profile on a machine where the engine is not available: the in-process engine serves, and says so.
  const without = new RoutedEngine({ inProcess, resolve: (id) => externalEngineFor(id, { catalog: createEngineCatalog(), registry: MODELS, roots: [] }), fallback: true });
  await without.load({ modelId: "m1", engine: "fastduck", contextSize: 2048 });
  assert.equal(without.engineId, null);
  assert.equal(inProcess.loaded.engine, undefined, "the engine key is not passed on to the in-process engine");
  assert.match((await without.status()).engineFallback.reason, /fastduck is not an engine this machine can use/);
});

test("a setting the new engine cannot honour is refused with a Why and a Fix, never changed", async () => {
  const engine = externalEngineFor("fastduck", { catalog: withFuture(500), registry: MODELS, roots: [] });
  await engine.load({ modelId: "m1", contextSize: 2048 });
  await assert.rejects(
    () => engine.chat({ messages: [{ role: "user", content: "hi" }], settings: { responsePrefix: "{" } }),
    (error) => error.code === "engine_setting_unsupported" && /fastduck cannot apply: responsePrefix/.test(error.why) && /in-process/.test(error.fix),
  );
});

test("the conformance check accepts the toy engine and every built-in network backend, and rejects a broken one", async (t) => {
  await checkBackendContract(fakeDuckBackend());

  const openAi = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url.endsWith("/models")) return res.writeHead(200).end(JSON.stringify({ data: [{ id: "tiny" }] }));
        const chat = req.url.includes("chat");
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const piece of ["he", "llo"]) res.write(`data: ${JSON.stringify({ choices: [chat ? { delta: { content: piece } } : { text: piece }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(() => { openAi.closeAllConnections?.(); openAi.close(); });
  await checkBackendContract(new OpenAICompatBackend({ baseUrl: `http://127.0.0.1:${openAi.address().port}/v1` }));

  const ollama = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/api/version") return res.writeHead(200).end('{"version":"1"}');
        if (req.url === "/api/tags") return res.writeHead(200).end('{"models":[{"name":"tiny:latest"}]}');
        if (req.url === "/api/generate" && !JSON.parse(body).raw) return res.writeHead(200).end("{}");
        const chat = req.url === "/api/chat";
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end([chat ? { message: { content: "he" } } : { response: "he" }, chat ? { message: { content: "llo" } } : { response: "llo" }, { done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2, eval_duration: 1e8, prompt_eval_duration: 1e7 }].map((event) => `${JSON.stringify(event)}\n`).join(""));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(() => { ollama.closeAllConnections?.(); ollama.close(); });
  await checkBackendContract(new OllamaBackend({ baseUrl: `http://127.0.0.1:${ollama.address().port}` }));

  const noStream = { ...fakeDuckBackend(), generate: async () => ({ text: "x", stopReason: "eogToken", promptTokens: 1, outputTokens: 1, tokensPerSecond: 1, firstTokenMs: 1 }) };
  await assert.rejects(() => checkBackendContract(noStream), /streams exactly the text it returns/);
  await assert.rejects(() => checkBackendContract({ ...fakeDuckBackend(), stop: undefined }), /a backend needs stop\(\)/);
});

test("the context every descriptor receives carries the options and defaults, frozen", () => {
  const ctx = engineContext({ registry: MODELS, llamaServer: "x", cachePrompt: true });
  assert.equal(ctx.options.llamaServer, "x");
  assert.deepEqual(ctx.options.openai, []);
  assert.equal(ctx.cachePrompt, true);
  assert.ok(Object.isFrozen(ctx) && Object.isFrozen(ctx.options));
});

test("whether the app can start an engine can depend on which one: an installed variant yes, a build passed by hand no", () => {
  const catalog = createEngineCatalog();
  assert.equal(catalog.isServable("llama-server:vulkan"), true, "installed through engines:install, so the app can find it again");
  assert.equal(catalog.isServable("llama-server"), false, "a binary passed on one command line is not something a saved profile can start");
  const perId = { ...fastDuck(), servable: (id) => id === "fastduck:local" };
  assert.equal(assertDescriptor(perId), perId, "servable may be a function of the id");
  const custom = createEngineCatalog({ descriptors: [...BUILTIN_DESCRIPTORS, perId] });
  assert.deepEqual(["fastduck:local", "fastduck:remote"].map((id) => custom.isServable(id)), [true, false]);
  assert.throws(() => assertDescriptor({ ...fastDuck(), servable: "yes" }), (error) => /servable must be true, false or a function/.test(error.why));
});

test("an engine reports the version the app would run, from its own descriptor", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duck-ver-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "bin", "llama.cpp-vulkan");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ engine: "llama.cpp", variant: "vulkan", release: "b12521" }));
  const catalog = createEngineCatalog({ descriptors: [...BUILTIN_DESCRIPTORS, { ...fastDuck(), version: () => "9.9" }] });
  const ctx = engineContext({ roots: [root] });
  assert.equal(catalog.version("llama-server:vulkan", ctx), "b12521", "the installed release, the same string at tune time and at serve time");
  assert.equal(catalog.version("llama-server:cuda", ctx), null, "not installed");
  assert.equal(catalog.version("llama-server", ctx), null, "a hand-passed binary has no release to name");
  assert.equal(catalog.version("fastduck", ctx), "9.9", "a new engine says its own");
  assert.equal(catalog.version("ollama", ctx), null, "an engine with no version() reports none rather than guessing");
  assert.equal(catalog.version("nope", ctx), null);
});
