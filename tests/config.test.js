import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PORT,
  DEFAULT_SETTINGS,
  SETTING_PRESETS,
  applyPreset,
  defaultGenerationThreads,
  defaultThreads,
  hasSmt,
  normalizeSettings,
  parseArgs,
  resolvePaths,
} from "../src/config.js";

// Measured on an i5-14400F (10 cores, 16 logical), CPU only: Qwen2.5 Coder 1.5B ran
// 3.9 tok/s at 15 threads and 28.8 at 8; Qwen2.5 0.5B 47.7 and 83.7. Threads on
// every logical core contend; half of them is the default.
test("generation uses half the logical cores by default; the thread pool keeps all but one", () => {
  assert.equal(defaultGenerationThreads(16, true), 8);
  assert.equal(defaultGenerationThreads(8, true), 4);
  assert.equal(defaultGenerationThreads(4, true), 2);
  assert.equal(defaultGenerationThreads(3, true), 1);
  assert.equal(defaultGenerationThreads(1, true), 1);
  assert.equal(defaultGenerationThreads(200, true), 64, "never above the engine's cap");
  assert.equal(DEFAULT_SETTINGS.threads, defaultGenerationThreads());
  assert.equal(DEFAULT_SETTINGS.maxThreads, defaultThreads(), "the pool cap is unchanged");
  assert.ok(DEFAULT_SETTINGS.threads <= DEFAULT_SETTINGS.maxThreads);
});

// Halving helps only when two logical cores share one physical core. Without SMT,
// half the logical cores is half the machine, so those CPUs keep all cores but one.
test("without SMT the default keeps all logical cores but one", () => {
  assert.equal(defaultGenerationThreads(8, false), 7, "an 8-core Apple or ARM chip is not halved to 4");
  assert.equal(defaultGenerationThreads(1, false), 1);
  assert.equal(defaultGenerationThreads(200, false), 64);
});

test("SMT is detected from the architecture and, on Linux, from /proc/cpuinfo", () => {
  const block = (siblings, cores) => `processor\t: 0\nvendor_id\t: GenuineIntel\nsiblings\t: ${siblings}\ncpu cores\t: ${cores}\n\nprocessor\t: 1\n`;
  assert.equal(hasSmt({ platform: "darwin", arch: "arm64" }), false, "Apple Silicon has no SMT");
  assert.equal(hasSmt({ platform: "linux", arch: "arm64", cpuinfo: "" }), false, "ARM cores have no SMT");
  assert.equal(hasSmt({ platform: "linux", arch: "x64", cpuinfo: block(16, 10) }), true, "16 threads on 10 cores");
  assert.equal(hasSmt({ platform: "linux", arch: "x64", cpuinfo: block(6, 6) }), false, "6 threads on 6 cores");
  assert.equal(hasSmt({ platform: "linux", arch: "x64", cpuinfo: null }), true, "unreadable: keep the measured default");
  assert.equal(hasSmt({ platform: "win32", arch: "x64" }), true, "no cheap source on Windows: keep the measured default");
});

test("parseArgs uses loopback defaults", () => {
  const options = parseArgs([], {});
  assert.equal(options.port, DEFAULT_PORT);
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.open, true);
  assert.equal(options.help, false);
  assert.equal(options.portExplicit, false);
  assert.equal(options.hostExplicit, false);
});

test("parseArgs accepts inline and separate values", () => {
  assert.deepEqual(parseArgs(["--port=5000", "--no-open"], {}), {
    port: 5000,
    portExplicit: true,
    host: "127.0.0.1",
    hostExplicit: false,
    open: false,
    home: null,
    models: null,
    help: false,
    version: false,
  });
  const separate = parseArgs(["--port", "5001", "--home", "C:\\data"], {});
  assert.equal(separate.port, 5001);
  assert.equal(separate.home, "C:\\data");
});

test("parseArgs rejects an invalid port", () => {
  assert.throws(() => parseArgs(["--port", "99999"], {}), /Invalid port/);
  assert.throws(() => parseArgs(["--wat"], {}), /Unknown option/);
  assert.throws(
    () => parseArgs([], { MODELDUCK_PORT: "not-a-port" }),
    /Invalid MODELDUCK_PORT/,
  );
});

test("normalizeSettings clamps every numeric field", () => {
  const settings = normalizeSettings({
    temperature: 9,
    topP: -1,
    maxTokens: 1,
    contextSize: 999999,
    threads: 0,
    kvCache: "q4_0",
    systemPrompt: "  be nice  ",
  });
  assert.equal(settings.temperature, 2);
  assert.equal(settings.topP, 0.05);
  assert.equal(settings.maxTokens, 16);
  assert.equal(settings.contextSize, 32768);
  assert.equal(settings.threads, 1);
  assert.equal(settings.kvCache, "q4_0");
  assert.equal(settings.systemPrompt, "  be nice  ");
});

test("normalizeSettings keeps defaults for junk values", () => {
  const settings = normalizeSettings({
    temperature: "hot",
    topP: null,
    kvCache: "float128",
    gpuBackend: "rocm",
    gpuLayers: "all",
  });
  assert.equal(settings.temperature, DEFAULT_SETTINGS.temperature);
  assert.equal(settings.topP, DEFAULT_SETTINGS.topP);
  assert.equal(settings.kvCache, "f16");
  assert.equal(settings.gpuBackend, "cpu");
  assert.equal(settings.gpuLayers, 0);
  assert.equal(settings.checkpointInterval, DEFAULT_SETTINGS.checkpointInterval);
  assert.equal(settings.checkpointMax, DEFAULT_SETTINGS.checkpointMax);
});

test("checkpoint interval and max are clamped to safe values", () => {
  const low = normalizeSettings({ checkpointInterval: 1, checkpointMax: 0 });
  assert.equal(low.checkpointInterval, 128);
  assert.equal(low.checkpointMax, 1);
  const high = normalizeSettings({ checkpointInterval: 999999, checkpointMax: 999 });
  assert.equal(high.checkpointInterval, 32768);
  assert.equal(high.checkpointMax, 64);
});

test("sampling fields clamp and presets are benchmark candidates", () => {
  const settings = normalizeSettings({
    topK: 999,
    minP: 9,
    repeatPenalty: 9,
    promptRepeat: 99,
    seed: -5,
    contextOverflow: "explode",
    structuredOutput: "xml",
    gpuBackend: "vulkan",
    gpuLayers: "auto",
  });
  assert.equal(settings.topK, 200);
  assert.equal(settings.minP, 1);
  assert.equal(settings.repeatPenalty, 2);
  assert.equal(settings.promptRepeat, 3);
  assert.equal(settings.seed, -1);
  assert.equal(settings.contextOverflow, "shift");
  assert.equal(settings.structuredOutput, "none");
  assert.equal(settings.gpuBackend, "vulkan");
  assert.equal(settings.gpuLayers, "auto");

  const dry = normalizeSettings({ dryStrength: 9, dryBase: -1, dryAllowedLength: 0 });
  assert.equal(dry.dryStrength, 1, "DRY strength clamps to 0..1");
  assert.equal(dry.dryBase, 1.75, "a non-positive DRY base falls back to the default");
  assert.equal(dry.dryAllowedLength, 1, "the DRY window clamps to at least 1");
  const dryDefaults = normalizeSettings({});
  assert.equal(dryDefaults.dryStrength, 0, "DRY is off unless tuned on");
  assert.equal(dryDefaults.dryAllowedLength, 4, "code-length repeats are allowed");

  assert.deepEqual(
    Object.keys(SETTING_PRESETS).sort(),
    ["balanced", "cheap", "quality", "token_saver"],
  );
  const preset = applyPreset("token_saver", { systemPrompt: "keep me" });
  assert.equal(preset.kvCache, "q8_0", "q4_0 KV measured 19.1% on Qwen2.5 0.5B (IDEA-1062)");
  assert.equal(preset.systemPrompt, "keep me");
  assert.equal(DEFAULT_SETTINGS.contextSize, 16384, "coding needs the 16K floor (ADR-089)");
  assert.equal(normalizeSettings({ contextSize: 1024 }).contextSize, 16384, "a smaller context is clamped up");
  for (const name of Object.keys(SETTING_PRESETS)) {
    assert.equal(SETTING_PRESETS[name].settings.contextSize, undefined, `${name} does not override the context floor`);
  }
});

test("a long stop list keeps the first stops instead of dropping the fence", () => {
  const settings = normalizeSettings({ customStopTriggers: ["```", "a", "b", "c", "d"] });
  assert.deepEqual(settings.customStopTriggers, ["```", "a", "b", "c"]);
  assert.deepEqual(
    normalizeSettings({ customStopTriggers: ["```"] }).customStopTriggers,
    ["```"],
    "the tuned fence stop still applies on its own",
  );
  assert.deepEqual(
    normalizeSettings({ customStopTriggers: "```" }).customStopTriggers,
    DEFAULT_SETTINGS.customStopTriggers,
    "a non-list is still refused",
  );
});

// A settings file in its own temp directory: writeJsonAtomic keeps a .bak beside it, so a bare file
// in the shared temp folder left stray files behind on every run.
async function settingsFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "settings.json");
}

test("SettingsStore isolates stop lists and ignores non-object patches", async (t) => {
  const { SettingsStore } = await import("../src/settings.js");
  const file = await settingsFile(t);
  const store = new SettingsStore({ file, logger: { warn() {}, error() {} } });
  const snapshot = store.value;
  snapshot.customStopTriggers.push("leak");
  assert.deepEqual(store.value.customStopTriggers, []);
  await store.update("abc");
  assert.deepEqual(store.value.customStopTriggers, []);
});

// IDEA-1097: version fence prevents silent downgrade on load.
test("SettingsStore rejects a newer version file", async (t) => {
  const { SettingsStore } = await import("../src/settings.js");
  const file = await settingsFile(t);
  // Write a settings file with a future version
  const { writeJsonAtomic } = await import("../src/fs-atomic.js");
  await writeJsonAtomic(file, { version: 999, settings: { temperature: 0.5 } });
  const store = new SettingsStore({ file, logger: { warn() {}, error() {} } });
  await assert.rejects(store.load(), /is newer than supported/);
});

// The fence used to skip any version that was not a number, so "2" or 1.5 loaded as if current.
test("SettingsStore refuses a version it cannot read, with Why and Fix, and leaves the file alone", async (t) => {
  const { SettingsStore } = await import("../src/settings.js");
  const { writeJsonAtomic } = await import("../src/fs-atomic.js");
  const fs = await import("node:fs/promises");
  const file = await settingsFile(t);
  const store = new SettingsStore({ file, logger: { warn() {}, error() {} } });
  for (const version of ["2", 1.5, -1, "soon", true]) {
    await writeJsonAtomic(file, { version, settings: { temperature: 0.5 } });
    const before = await fs.readFile(file, "utf8");
    await assert.rejects(store.load(), (error) => error.code === "settings_version_unsupported" && /version/i.test(error.why) && Boolean(error.fix), `refuses ${JSON.stringify(version)}`);
    assert.equal(await fs.readFile(file, "utf8"), before, "the file is not rewritten");
  }
  await writeJsonAtomic(file, { version: "1", settings: { temperature: 0.5 } });
  assert.equal((await store.load()).temperature, 0.5, "a version written as a numeric string still loads");
});

// IDEA-1097: missing or older version is accepted.
test("SettingsStore accepts missing or older version", async (t) => {
  const { SettingsStore } = await import("../src/settings.js");
  const file = await settingsFile(t);
  const { writeJsonAtomic } = await import("../src/fs-atomic.js");
  // A file with no version loads, and its values are used.
  await writeJsonAtomic(file, { settings: { temperature: 0.5 } });
  const store1 = new SettingsStore({ file, logger: { warn() {}, error() {} } });
  await store1.load();
  assert.equal(store1.value.temperature, 0.5);
  // An older version (0) loads the same way.
  await writeJsonAtomic(file, { version: 0, settings: { temperature: 0.4 } });
  const store2 = new SettingsStore({ file, logger: { warn() {}, error() {} } });
  await store2.load();
  assert.equal(store2.value.temperature, 0.4);
});

test("boolean strings parse instead of Boolean() truthiness", () => {
  assert.equal(normalizeSettings({ checkpoints: "false" }).checkpoints, false);
  assert.equal(normalizeSettings({ checkpoints: "0" }).checkpoints, false);
  assert.equal(normalizeSettings({ penalizeNewLine: "0" }).penalizeNewLine, false);
  assert.equal(normalizeSettings({ useTunedProfile: "no" }).useTunedProfile, false);
  assert.equal(normalizeSettings({ checkpoints: "true" }).checkpoints, true);
  assert.equal(normalizeSettings({ checkpoints: "1" }).checkpoints, true);
});

test("dryBase coerces numeric strings like other numbers", () => {
  assert.equal(normalizeSettings({ dryBase: "2.5" }).dryBase, 2.5);
  assert.equal(normalizeSettings({ dryBase: -1 }).dryBase, 1.75);
});

test("stop lists are isolated copies, not shared references", () => {
  const first = normalizeSettings({});
  first.customStopTriggers.push("leak");
  assert.deepEqual(normalizeSettings({}).customStopTriggers, []);
  assert.deepEqual(DEFAULT_SETTINGS.customStopTriggers, []);
});

// IDEA-1627: the repro flag survives normalization, and only then is batch
// 1 legal. Every other path keeps the 32 floor.
test("determinism lockdown opts in explicitly and keeps batch 1", () => {
  assert.equal(normalizeSettings({}).deterministicRepro, false);
  assert.equal(normalizeSettings({ deterministicRepro: true }).deterministicRepro, true);
  assert.equal(normalizeSettings({ batchSize: 1 }).batchSize, 32);
  assert.equal(normalizeSettings({ batchSize: 1, deterministicRepro: true }).batchSize, 1);
  assert.equal(normalizeSettings({ batchSize: 8, deterministicRepro: true }).batchSize, 8);
});

test("resolvePaths puts all state under the chosen home", () => {
  const home = path.join(os.tmpdir(), "duck-home");
  const models = path.join(os.tmpdir(), "duck-models");
  const paths = resolvePaths({ home, models });
  assert.equal(paths.models, path.resolve(models));
  assert.equal(paths.settings, path.join(path.resolve(home), "settings.json"));
});
