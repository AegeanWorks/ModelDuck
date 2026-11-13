import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { matchPreset, presetProfile, readShippedPresets } from "../src/preset-match.js";

const RECIPE = Object.freeze({
  schema: 1,
  kind: "modelduck-profile",
  catalogId: "qwen2.5-coder-1.5b-instruct-q4",
  createdAt: "2026-11-08T02:58:49.391Z",
  fingerprint: {
    cpu: "Intel(R) Core(TM) i5-14400F", cores: 16, platform: "win32", arch: "x64", nodeLlamaCpp: "3.22.2",
    suiteVersion: 17, taskHash: "9e89fb9cc27ae435", modelFile: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf", modelSize: 1117320768, tunerVersion: 9,
  },
  load: { settings: { kvCache: "f16", batchSize: 512, threads: 12, gpuLayers: "max", gpuBackend: "vulkan" }, stats: null },
  speed: null,
  tasks: { code: { settings: { temperature: 0.4, minP: 0.1, topP: 0.85, maxTokens: 512 }, stats: { rate: 58.8, items: 136, seeds: 3 } } },
  receipt: { stages: null, search: null, rates: { code: { rate: 58.8, items: 136, holdout: null } } },
});

const SAME = Object.freeze({ ...RECIPE.fingerprint, suiteVersion: 18, taskHash: "605fa46013e915d5", tunerVersion: 10 });

test("the same model on the same machine applies the whole recipe", () => {
  const match = matchPreset(RECIPE, SAME);
  assert.equal(match.status, "exact");
  assert.deepEqual(match.keeps, ["load", "tasks"]);
  assert.ok(match.reasons.some((reason) => /suite/i.test(reason)), "a stale suite is said, not hidden");
});

test("the same model on another machine keeps the task presets and drops the machine-specific load", () => {
  const laptop = { ...SAME, cpu: "AMD Ryzen 5 5500U", cores: 12 };
  const match = matchPreset(RECIPE, laptop);
  assert.equal(match.status, "portable");
  assert.deepEqual(match.keeps, ["tasks"]);
  assert.match(match.reasons.join(" "), /i5-14400F/);
  assert.match(match.next, /device/i, "it says how to fit the load settings to this machine");
  const profile = presetProfile(RECIPE, match);
  assert.deepEqual(profile.load.settings, {}, "Vulkan, max GPU layers and 12 threads stay behind");
  assert.equal(profile.tasks.code.settings.temperature, 0.4);
  assert.equal(profile.tasks.code.stats.rate, 58.8, "the receipt stays with the preset");
});

test("another file, size or platform is no match", () => {
  assert.equal(matchPreset(RECIPE, { ...SAME, modelFile: "other.gguf" }).status, "none");
  assert.equal(matchPreset(RECIPE, { ...SAME, modelSize: 1 }).status, "none", "a re-quantized file with the same name is not the measured file");
  assert.equal(matchPreset(RECIPE, { ...SAME, platform: "linux" }).status, "portable", "another OS is another machine");
  assert.equal(matchPreset(RECIPE, null).status, "none");
  assert.equal(matchPreset({ ...RECIPE, fingerprint: null }, SAME).status, "none");
});

test("an applied preset is marked as a shipped preset with its match, and never as tuned here", () => {
  const profile = presetProfile(RECIPE, matchPreset(RECIPE, SAME));
  assert.equal(profile.search.imported, true);
  assert.deepEqual(profile.search.preset, { status: "exact", source: "shipped" });
  assert.equal(profile.stages, null, "no stage counts as tuned on this machine");
  assert.throws(() => presetProfile(RECIPE, { status: "none" }), (error) => error.code === "preset_no_match");
});

test("shipped presets are read from their folder; a broken file is skipped, not fatal", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-presets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "a.modelduck-profile.json"), JSON.stringify(RECIPE));
  await writeFile(path.join(dir, "broken.modelduck-profile.json"), "{ not json");
  await writeFile(path.join(dir, "README.md"), "# not a preset");
  const presets = await readShippedPresets(dir);
  assert.deepEqual(presets.map((preset) => preset.catalogId), ["qwen2.5-coder-1.5b-instruct-q4"]);
  assert.deepEqual(await readShippedPresets(path.join(dir, "missing")), []);
});

test("the shipped presets in the repository are valid recipes", async () => {
  const presets = await readShippedPresets();
  assert.ok(presets.length >= 3);
  for (const preset of presets) {
    const match = matchPreset(preset, preset.fingerprint);
    assert.equal(match.status, "exact", `${preset.catalogId} matches its own fingerprint`);
    presetProfile(preset, match);
  }
});
