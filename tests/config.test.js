import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PORT,
  DEFAULT_SETTINGS,
  SETTING_PRESETS,
  applyPreset,
  normalizeSettings,
  parseArgs,
  resolvePaths,
} from "../src/config.js";

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
    ["balanced", "quality", "token_saver"],
  );
  const preset = applyPreset("token_saver", { systemPrompt: "keep me" });
  assert.equal(preset.kvCache, "q8_0", "q4_0 KV measured 19.1% on Qwen2.5 0.5B (IDEA-1062)");
  assert.equal(preset.systemPrompt, "keep me");
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

test("resolvePaths puts all state under the chosen home", () => {
  const home = path.join(os.tmpdir(), "duck-home");
  const models = path.join(os.tmpdir(), "duck-models");
  const paths = resolvePaths({ home, models });
  assert.equal(paths.models, path.resolve(models));
  assert.equal(paths.settings, path.join(path.resolve(home), "settings.json"));
});
