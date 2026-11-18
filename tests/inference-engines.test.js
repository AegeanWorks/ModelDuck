import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LlamaBenchAdapter, LlamaServerAdapter, NodeBackendAdapter, OllamaAdapter, OpenAICompatAdapter, WORKLOAD, cleanPath, parseDevices, parseLlamaVersion } from "../src/inference-engine-adapters.js";
import { assessEngines, createEngineRegistry, defaultEngines, fastestEngine, formatAssessment, usableNodeBackends } from "../src/inference-engines.js";

const ENTRY = { id: "m1", fileName: "tiny-q4_k_m.gguf", path: "C:\\models\\tiny-q4_k_m.gguf" };

const fakeEngine = (id, { available = true, reason = null, measure } = {}) => ({
  id,
  label: id,
  detect: async () => ({ available, reason, version: "1" }),
  measure: measure ?? (async () => ({ promptTps: 100, genTps: 10, runs: 3, detail: "fake" })),
});

test("the registry looks engines up by id and names the known ones on a miss", () => {
  const registry = createEngineRegistry({ engines: [fakeEngine("a"), fakeEngine("b")] });
  assert.deepEqual(registry.ids(), ["a", "b"]);
  assert.equal(registry.get("b").id, "b");
  assert.throws(() => registry.get("zzz"), /Unknown inference engine "zzz"; known: a, b/);
});

test("with nothing installed the default engines still list every engine, and the missing server says how to install it", async () => {
  const ids = createEngineRegistry({ engines: defaultEngines({ roots: [] }) }).ids();
  assert.deepEqual(ids, ["node-llama-cpp:cpu", "node-llama-cpp:vulkan", "node-llama-cpp:cuda", "node-llama-cpp:metal", "llama-bench", "llama-server", "ollama"]);
  const server = createEngineRegistry({ engines: defaultEngines({ roots: [] }) }).get("llama-server");
  const found = await server.detect();
  assert.equal(found.available, false);
  assert.match(found.reason, /npm run engines:install/);
});

test("assessing ranks by generation speed and never lets one engine stop the others", async () => {
  const registry = createEngineRegistry({
    engines: [
      fakeEngine("slow", { measure: async () => ({ promptTps: 50, genTps: 5, runs: 3 }) }),
      fakeEngine("missing", { available: false, reason: "no GPU" }),
      fakeEngine("broken", { measure: async () => { throw new Error("segfault"); } }),
      fakeEngine("fast", { measure: async () => ({ promptTps: 900, genTps: 40, runs: 3 }) }),
    ],
  });
  const seen = [];
  const report = await assessEngines({ registry, entry: ENTRY, onProgress: (event) => seen.push(`${event.engine}:${event.stage}`) });
  assert.equal(report.fastest, "fast");
  const by = Object.fromEntries(report.results.map((result) => [result.id, result]));
  assert.equal(by.missing.available, false);
  assert.equal(by.missing.reason, "no GPU");
  assert.equal(by.broken.available, true);
  assert.equal(by.broken.ok, false);
  assert.equal(by.broken.error, "segfault");
  assert.equal(by.slow.genTps, 5);
  assert.ok(Object.isFrozen(report) && Object.isFrozen(report.results) && Object.isFrozen(by.fast));
  assert.deepEqual(seen.filter((line) => line.startsWith("missing")), ["missing:detect"], "an unavailable engine is never measured");
});

test("assessing can be limited to named engines, and fastest is null when none measured", async () => {
  const registry = createEngineRegistry({ engines: [fakeEngine("a"), fakeEngine("b", { available: false, reason: "x" })] });
  const only = await assessEngines({ registry, entry: ENTRY, only: ["b"] });
  assert.deepEqual(only.results.map((r) => r.id), ["b"]);
  assert.equal(only.fastest, null);
  assert.equal(fastestEngine([]), null);
});

test("the in-process backends that start here are the ones the device stage may try", async () => {
  const registry = createEngineRegistry({
    engines: [fakeEngine("node-llama-cpp:cpu"), fakeEngine("node-llama-cpp:vulkan"), fakeEngine("node-llama-cpp:cuda", { available: false, reason: "no CUDA" }), fakeEngine("ollama")],
  });
  assert.deepEqual(await usableNodeBackends({ registry }), ["cpu", "vulkan"]);
});

// The real shape llama-bench -o json printed on this machine: one row for prompt, one for generation.
const BENCH_JSON = JSON.stringify([
  { build_commit: "cd8427d", backends: "CPU", n_prompt: 256, n_gen: 0, avg_ts: 779.68 },
  { build_commit: "cd8427d", backends: "CPU", n_prompt: 0, n_gen: 64, avg_ts: 28.857824 },
]);

test("llama-bench is found, run with the shared workload, and its rows become the two speeds", async () => {
  const calls = [];
  const adapter = new LlamaBenchAdapter({
    binary: "C:\\llama\\llama-bench.exe",
    exists: (file) => file === "C:\\llama\\llama-bench.exe",
    run: async (file, args) => {
      calls.push([file, args]);
      return `warming up\n${BENCH_JSON}`;
    },
  });
  assert.equal((await adapter.detect()).available, true);
  const measured = await adapter.measure({ entry: ENTRY, runs: 2 });
  assert.equal(measured.promptTps, 779.68);
  assert.equal(measured.genTps, 28.86);
  assert.match(measured.detail, /CPU build cd8427d/);
  assert.deepEqual(calls.at(-1)[1], ["-m", ENTRY.path, "-p", String(WORKLOAD.promptTokens), "-n", String(WORKLOAD.genTokens), "-r", "2", "-o", "json"]);
});

test("a missing llama-bench says how to point at one, and empty output is an error", async () => {
  const absent = new LlamaBenchAdapter({ exists: () => false, home: "C:\\nobody" });
  const found = await absent.detect();
  assert.equal(found.available, false);
  assert.match(found.reason, /--llama-bench/);
  const empty = new LlamaBenchAdapter({ binary: "b", exists: () => true, run: async () => "[]" });
  await assert.rejects(() => empty.measure({ entry: ENTRY }), /no timing rows/);
});

function fakeOllama({ tags = [], generate = {}, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (down) throw new Error("ECONNREFUSED");
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith("/api/version")) return json({ version: "0.5.1" });
    if (url.endsWith("/api/tags")) return json({ models: tags });
    return json({ prompt_eval_count: 256, prompt_eval_duration: 500_000_000, eval_count: 64, eval_duration: 2_000_000_000, ...generate, _body: init?.body });
  };
  return { fetchImpl, calls };
}

test("Ollama is detected by its version endpoint and reported unavailable when nothing answers", async () => {
  assert.deepEqual(await new OllamaAdapter({ fetchImpl: fakeOllama().fetchImpl }).detect(), { available: true, reason: null, version: "0.5.1" });
  const down = await new OllamaAdapter({ fetchImpl: fakeOllama({ down: true }).fetchImpl }).detect();
  assert.equal(down.available, false);
  assert.match(down.reason, /No Ollama server answered/);
});

test("Ollama speeds come from its own nanosecond timings, using the tag that matches the file", async () => {
  const { fetchImpl, calls } = fakeOllama({ tags: [{ name: "llama3.2:3b" }, { name: "tiny:latest" }] });
  const measured = await new OllamaAdapter({ fetchImpl }).measure({ entry: ENTRY, runs: 2 });
  assert.equal(measured.promptTps, 512, "256 tokens in 0.5 s");
  assert.equal(measured.genTps, 32, "64 tokens in 2 s");
  assert.match(measured.detail, /tiny:latest/);
  assert.equal(calls.filter((url) => url.endsWith("/api/generate")).length, 3, "one uncounted warm-up plus two measured runs");
});

test("Ollama with no matching model asks for one by name instead of guessing", async () => {
  const none = fakeOllama({ tags: [{ name: "llama3.2:3b" }] });
  await assert.rejects(() => new OllamaAdapter({ fetchImpl: none.fetchImpl }).measure({ entry: ENTRY }), /--ollama-model/);
  const named = await new OllamaAdapter({ fetchImpl: none.fetchImpl, model: "llama3.2:3b" }).measure({ entry: ENTRY, runs: 1 });
  assert.match(named.detail, /llama3.2:3b/);
});

function fakeLlamaEngine({ failBackend = null, stats }) {
  const log = [];
  return {
    log,
    create: () => ({
      startBackend: async (backend) => {
        if (backend === failBackend) throw Object.assign(new Error("bad"), { why: `${backend} could not be loaded` });
      },
      load: async (options) => {
        log.push(options);
        return { gpuBackend: options.gpuBackend, gpuLayers: options.gpuLayers === 0 ? 0 : 31 };
      },
      complete: async () => ({ stats: stats.shift() }),
      dispose: async () => {},
    }),
  };
}

test("an in-process backend that will not start is unavailable with the engine's own reason", async () => {
  const { create } = fakeLlamaEngine({ failBackend: "cuda", stats: [] });
  const cuda = await new NodeBackendAdapter({ backend: "cuda", createEngine: create }).detect();
  assert.equal(cuda.available, false);
  assert.equal(cuda.reason, "cuda could not be loaded");
  assert.equal((await new NodeBackendAdapter({ backend: "cpu", createEngine: create }).detect()).available, true);
});

test("an in-process backend is timed with a warm-up first and the median of the counted runs", async () => {
  const stats = [
    { promptTokens: 256, firstTokenMs: 9999, tokensPerSecond: 1 }, // warm-up, not counted
    { promptTokens: 256, firstTokenMs: 500, tokensPerSecond: 40 },
    { promptTokens: 256, firstTokenMs: 250, tokensPerSecond: 50 },
    { promptTokens: 256, firstTokenMs: 1000, tokensPerSecond: 60 },
  ];
  const { create, log } = fakeLlamaEngine({ stats });
  const measured = await new NodeBackendAdapter({ backend: "vulkan", createEngine: create }).measure({ entry: ENTRY, runs: 3 });
  assert.equal(measured.genTps, 50);
  assert.deepEqual(measured.genRange, [40, 60], "the spread across counted runs is reported beside the median");
  assert.equal(measured.promptTps, 512, "median of 256/0.25, 256/0.5, 256/1");
  assert.equal(log[0].gpuBackend, "vulkan");
  assert.equal(log[0].gpuLayers, "max");
  assert.match(measured.detail, /vulkan, 31 GPU layers/);
});

test("the report prints every engine with the fastest marked and reasons for the rest", async () => {
  const registry = createEngineRegistry({
    engines: [fakeEngine("fast", { measure: async () => ({ promptTps: 900, genTps: 40, runs: 3 }) }), fakeEngine("gone", { available: false, reason: "no GPU" }), fakeEngine("bad", { measure: async () => { throw new Error("boom"); } })],
  });
  const text = formatAssessment(await assessEngines({ registry, entry: ENTRY }));
  assert.match(text, /1 of 3 engines measured/);
  assert.match(text, /\* fast\s+40 tok\/s gen\s+900 tok\/s prompt/);
  const ranged = formatAssessment({ model: "m", fastest: "r", results: [{ id: "r", label: "r", available: true, ok: true, genTps: 50, genRange: [40, 60], promptTps: 1, detail: "d" }] });
  assert.match(ranged, /50 tok\/s gen \(40-60\)/);
  assert.match(text, /unavailable: no GPU/);
  assert.match(text, /FAILED: boom/);
});

// Engine versions: speed and behaviour change between builds, so every result names its build.
test("a llama.cpp version line becomes a short version with its commit", () => {
  assert.equal(parseLlamaVersion("version: 0.8.0-dev (build 1, commit cd8427d)\nbuilt with GNU 16.2.0"), "0.8.0-dev (cd8427d)");
  assert.equal(parseLlamaVersion("version: 1.2.3"), "1.2.3");
  assert.equal(parseLlamaVersion("garbage"), null);
  assert.equal(parseLlamaVersion(undefined), null);
});

test("Git for Windows' usr and mingw directories are dropped from the native engine's PATH", () => {
  const dirty = String.raw`C:\Program Files\Git\mingw64\bin;C:\Windows\system32;C:\Program Files\Git\usr\bin;C:\Program Files\Git\cmd;C:\tools`;
  assert.equal(cleanPath(dirty, "win32"), String.raw`C:\Windows\system32;C:\Program Files\Git\cmd;C:\tools`);
  assert.equal(cleanPath("/usr/bin:/bin", "linux"), "/usr/bin:/bin", "other platforms are left alone");
});

test("llama-bench reports its version from --version and must start to count as available", async () => {
  const runs = [];
  const ok = new LlamaBenchAdapter({ binary: "b", exists: () => true, run: async (file, args) => { runs.push(args); return { stdout: "", stderr: "version: 0.8.0-dev (build 1, commit cd8427d)" }; } });
  assert.deepEqual(await ok.detect(), { available: true, reason: null, version: "0.8.0-dev (cd8427d)" });
  assert.deepEqual(runs[0], ["--version"]);
  const crash = new LlamaBenchAdapter({ binary: "b", exists: () => true, run: async () => { throw Object.assign(new Error("exit"), { code: 3221225785 }); } });
  const found = await crash.detect();
  assert.equal(found.available, false);
  assert.match(found.reason, /did not start \(3221225785\).*DLL/);
});

test("llama-bench keeps its JSON on stdout apart from log lines on stderr", async () => {
  const adapter = new LlamaBenchAdapter({ binary: "b", exists: () => true, run: async () => ({ stdout: BENCH_JSON, stderr: "load_backend: loaded CPU backend" }) });
  const measured = await adapter.measure({ entry: ENTRY });
  assert.equal(measured.genTps, 28.86);
  assert.equal(measured.version, "commit cd8427d");
});

test("an in-process backend names the runtime that serves it", async () => {
  const { create } = fakeLlamaEngine({ stats: [] });
  const describe = async (backend) => `node-llama-cpp 3.22.2, llama.cpp v0.7.0 (${backend})`;
  const cpu = await new NodeBackendAdapter({ backend: "cpu", createEngine: create, describe }).detect();
  assert.equal(cpu.version, "node-llama-cpp 3.22.2, llama.cpp v0.7.0 (cpu)");
  const vulkan = await new NodeBackendAdapter({ backend: "vulkan", createEngine: create, describe }).detect();
  assert.equal(vulkan.version, "node-llama-cpp 3.22.2, llama.cpp v0.7.0 (vulkan)");
  const broken = await new NodeBackendAdapter({ backend: "cpu", createEngine: create, describe: async () => { throw new Error("no"); } }).detect();
  assert.deepEqual(broken, { available: true, reason: null, version: null }, "a version that cannot be read never makes an engine unavailable");
});

test("the report carries each engine's version, measured or not", async () => {
  const detected = (version) => async () => ({ available: true, reason: null, version });
  const registry = createEngineRegistry({
    engines: [
      { ...fakeEngine("a"), detect: detected("1.0") },
      { ...fakeEngine("b", { measure: async () => { throw new Error("boom"); } }), detect: detected("2.0") },
      { ...fakeEngine("c", { measure: async () => ({ promptTps: 1, genTps: 2, runs: 1, version: "3.1-measured" }) }), detect: detected("3.0") },
      { ...fakeEngine("d", { measure: async () => ({ promptTps: 1, genTps: 2, runs: 1, version: "4-measured" }) }), detect: detected(null) },
    ],
  });
  const report = await assessEngines({ registry, entry: ENTRY });
  const by = Object.fromEntries(report.results.map((result) => [result.id, result.version]));
  assert.deepEqual(by, { a: "1.0", b: "2.0", c: "3.0", d: "4-measured" }, "the detected version wins; a measurement only fills a gap");
  const text = formatAssessment(report);
  assert.match(text, /\[1\.0\]/);
  assert.match(text, /FAILED: boom \[2\.0\]/);
});

// node-llama-cpp quietly starts Vulkan when asked for Metal on Windows; that is not a Metal result.
test("an in-process backend that started a different backend is unavailable, not a duplicate result", async () => {
  const { create } = fakeLlamaEngine({ stats: [] });
  const describe = async () => ({ version: "node-llama-cpp 3.22.2", gpu: "vulkan" });
  const metal = await new NodeBackendAdapter({ backend: "metal", createEngine: create, describe }).detect();
  assert.equal(metal.available, false);
  assert.match(metal.reason, /asked for metal but node-llama-cpp started vulkan/);
  const vulkan = await new NodeBackendAdapter({ backend: "vulkan", createEngine: create, describe }).detect();
  assert.equal(vulkan.available, true);
  assert.equal(vulkan.version, "node-llama-cpp 3.22.2");
  const cpu = await new NodeBackendAdapter({ backend: "cpu", createEngine: create, describe: async () => ({ version: "v", gpu: false }) }).detect();
  assert.equal(cpu.available, true, "cpu reports gpu false and is still cpu");
});

test("a measurement that ran on another backend than the one asked for is an error", async () => {
  const stats = [{ promptTokens: 256, firstTokenMs: 100, tokensPerSecond: 10 }, { promptTokens: 256, firstTokenMs: 100, tokensPerSecond: 10 }];
  const { create } = fakeLlamaEngine({ stats });
  const wrong = { ...create(), load: async () => ({ gpuBackend: "vulkan", gpuLayers: 31 }), complete: async () => ({ stats: stats.shift() }), dispose: async () => {} };
  await assert.rejects(() => new NodeBackendAdapter({ backend: "metal", createEngine: () => wrong }).measure({ entry: ENTRY, runs: 1 }), /ran on vulkan, not metal/);
});

test("the device stage tries every in-process backend that measured, cpu first, and never an external engine", async () => {
  const { deviceBackendsFrom } = await import("../src/inference-engines.js");
  const report = {
    results: [
      { id: "node-llama-cpp:vulkan", ok: true },
      { id: "node-llama-cpp:cpu", ok: true },
      { id: "node-llama-cpp:cuda", ok: false, available: false },
      { id: "node-llama-cpp:metal", ok: false, available: true, error: "boom" },
      { id: "llama-bench", ok: true },
      { id: "ollama", ok: true },
    ],
  };
  assert.deepEqual(deviceBackendsFrom(report), ["cpu", "vulkan"]);
  assert.deepEqual(deviceBackendsFrom({ results: [] }), ["cpu"], "cpu always stays a candidate");
});

test("the engines command explains itself and refuses bad input with a Why and a Fix", async () => {
  const { main } = await import("../benchmarks/engine-speed.mjs");
  const chunks = [];
  const out = { write: (text) => chunks.push(text) };
  assert.equal(await main(["--help"], out), 0);
  assert.match(chunks.join(""), /Times every inference engine/);
  await assert.rejects(() => main([], out), (error) => error.code === "model_required" && /--model/.test(error.why));
  await assert.rejects(() => main(["--model", "x", "--runs", "0"], out), (error) => error.code === "bad_option" && /1 to 20/.test(error.why));
  await assert.rejects(() => main(["--model", "x", "--bogus"], out), (error) => error.code === "bad_option" && /--bogus/.test(error.why));
  await assert.rejects(() => main(["--model", "x", "--models-dir", "C:\definitely\not\here"], out), (error) => error.code === "model_not_found");
});

// Shipped engines: every installed llama.cpp variant is its own engine, with its own speed.
function installedRoot(t, variants) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duck-roots-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const variant of variants) {
    const dir = path.join(root, "bin", `llama.cpp-${variant}`);
    fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
    fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ engine: "llama.cpp", variant, release: "b9" }));
    fs.writeFileSync(path.join(dir, "inner", "llama-server.exe"), "");
    fs.writeFileSync(path.join(dir, "llama-bench.exe"), "");
  }
  return root;
}

test("each installed variant becomes its own engine, and a binary passed by hand is kept apart", (t) => {
  const root = installedRoot(t, ["cpu", "vulkan"]);
  const ids = (options) => createEngineRegistry({ engines: defaultEngines({ roots: [root], platform: "win32", ...options }) }).ids();
  assert.deepEqual(ids().filter((id) => id.startsWith("llama-")), ["llama-bench", "llama-server:cpu", "llama-server:vulkan"]);
  assert.ok(ids({ llamaServer: "C:\mine\llama-server.exe" }).includes("llama-server"), "a hand-passed build has its own id");
  assert.ok(ids({ openai: ["vllm=http://127.0.0.1:8000/v1"] }).includes("openai:vllm"));
  assert.throws(() => ids({ openai: ["not-an-address"] }), (error) => error.code === "bad_option" && /name=url/.test(error.why));
});

test("a GPU build on a machine without that GPU is unavailable, not a silent CPU run", async () => {
  const run = (devices) => async (file, args) => ({ stdout: "", stderr: args[0] === "--version" ? "version: 0.8.0 (build 1, commit abc1234)" : devices });
  const withGpu = new LlamaServerAdapter({ binary: "b", variant: "vulkan", release: "b9", run: run("Available devices:\n  Vulkan0: AMD Radeon (8192 MiB)") });
  const ok = await withGpu.detect();
  assert.equal(ok.available, true);
  assert.deepEqual(ok.backends, ["vulkan"]);
  assert.equal(withGpu.id, "llama-server:vulkan");
  assert.equal(withGpu.label, "llama.cpp b9 llama-server (vulkan)");
  const without = await new LlamaServerAdapter({ binary: "b", variant: "vulkan", run: run("Available devices:\n  (none)") }).detect();
  assert.equal(without.available, false);
  assert.match(without.reason, /found no vulkan device/);
  assert.equal(without.version, "0.8.0 (abc1234)", "the version is still reported");
  const cpu = await new LlamaServerAdapter({ binary: "b", variant: "cpu", run: run("Available devices:\n  (none)") }).detect();
  assert.deepEqual([cpu.available, cpu.backends], [true, ["cpu"]]);
  const byHand = await new LlamaServerAdapter({ binary: "b", run: run("Available devices:\n  CUDA0: RTX\n  Vulkan0: RTX") }).detect();
  assert.deepEqual(byHand.backends, ["cpu", "cuda", "vulkan"], "a build with no declared variant reports what it finds");
});

test("device lines name the GPU backends a llama.cpp build found", () => {
  assert.deepEqual(parseDevices("Available devices:\n  Vulkan0: NVIDIA (8 GiB)\n  Vulkan1: Intel\n  CUDA0: X"), ["vulkan", "cuda"]);
  assert.deepEqual(parseDevices("Available devices:\n  (none)"), []);
  assert.deepEqual(parseDevices(undefined), []);
});
