import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SETTINGS, normalizeSettings } from "../src/config.js";
import { DEFAULT_STEPS, promptAxes, qualityAxes, samplingAxes, speedAxes } from "../benchmarks/tune-grid.mjs";
import { TASKS } from "../benchmarks/tasks.mjs";
import { currentFingerprint, profileFromTune, saveProfile } from "../src/model-profiles.js";
import { TunedSettings } from "../src/tuned-settings.js";

const ENTRY = { id: "m1", fileName: "tuned-model.gguf", size: 64 };
const registry = { findById: (id) => (id === ENTRY.id ? ENTRY : null) };
const fingerprint = (entry) => currentFingerprint(entry, { nodeLlamaCpp: "test" });

async function setup(t, { useTunedProfile = true, fingerprintPatch = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-tuned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveProfile(dir, profileFromTune(
    {
      load: { settings: { contextSize: 8192, threads: 6, kvCache: "q8_0" } },
      tasks: { code: { settings: { temperature: 0.1, maxTokens: 1024 } } },
      sweeps: [],
      runs: 1,
      budgetExhausted: false,
    },
    { catalogId: "tuned-model", fingerprint: { ...(await fingerprint(ENTRY)), ...fingerprintPatch } },
  ));
  const settings = { value: { ...DEFAULT_SETTINGS, useTunedProfile } };
  return new TunedSettings({ profilesDir: dir, registry, settings, fingerprint });
}

test("a tuned model's load settings and the chosen task's sampling are applied", async (t) => {
  const tuned = await setup(t);
  const forLoad = await tuned.resolve("m1");
  assert.deepEqual(forLoad.settings, { contextSize: 8192, threads: 6, kvCache: "q8_0" });
  const forCode = await tuned.resolve("m1", "code");
  assert.equal(forCode.task, "code");
  assert.equal(forCode.settings.temperature, 0.1);
  assert.equal(forCode.settings.threads, 6);
  assert.deepEqual(forCode.warnings, []);
});

test("a task the profile lacks keeps the user's sampling", async (t) => {
  const forMath = await (await setup(t)).resolve("m1", "comprehension");
  assert.equal(forMath.task, null);
  assert.equal("temperature" in forMath.settings, false);
});

test("turning tuned settings off, an untuned model and an unknown model all give null", async (t) => {
  assert.equal(await (await setup(t, { useTunedProfile: false })).resolve("m1", "code"), null);
  const tuned = await setup(t);
  assert.equal(await tuned.resolve("other"), null);
  assert.equal(await new TunedSettings({ profilesDir: null, registry, settings: { value: DEFAULT_SETTINGS } }).resolve("m1"), null);
});

test("a stale profile is applied with its warnings", async (t) => {
  const resolved = await (await setup(t, { fingerprintPatch: { suiteVersion: 1 } })).resolve("m1", "code");
  assert.equal(resolved.settings.temperature, 0.1);
  assert.deepEqual(resolved.stale, ["suiteVersion"]);
  assert.match(resolved.warnings[0], /test suite changed/i);
});

test("an unknown task is refused", async (t) => {
  await assert.rejects((await setup(t)).resolve("m1", "poetry"), (error) => error.code === "unknown_task");
});

test("tuned settings are on by default and can be switched off", () => {
  assert.equal(DEFAULT_SETTINGS.useTunedProfile, true);
  assert.equal(normalizeSettings({}).useTunedProfile, true);
  assert.equal(normalizeSettings({ useTunedProfile: false }).useTunedProfile, false);
});

test("every value the tuner can choose survives settings normalisation unchanged", () => {
  const patches = [
    ...qualityAxes().flatMap((axis) => axis.patches),
    ...speedAxes({ logicalCores: 64 }, { ...DEFAULT_STEPS.load, checkpointing: { ...DEFAULT_STEPS.load.checkpointing, enabled: true } }).flatMap((axis) => axis.patches),
    ...promptAxes().flatMap((axis) => axis.patches),
    ...TASKS.flatMap((task) => samplingAxes(task.id).flatMap((axis) => axis.patches)),
  ];
  for (const patch of patches) {
    const normalised = normalizeSettings({ ...DEFAULT_SETTINGS, ...patch });
    for (const [key, value] of Object.entries(patch)) assert.equal(normalised[key], value, `${key}=${value} is clamped`);
  }
});

test("the Light speed preset and a task's tuned prompt settings are applied", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-tuned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveProfile(dir, profileFromTune(
    {
      load: { settings: { contextSize: 8192, threads: 8 } },
      speed: { fastest: { threads: 8 }, light: { threads: 4 }, quiet: { threads: 2 } },
      tasks: { comprehension: { settings: { temperature: 0, systemPrompt: "Think from first principles.", reasoning: "auto" } } },
      stages: { quality: "done", speed: "done", sampling: { comprehension: "done" }, prompt: { comprehension: "done" } },
      sweeps: [],
      runs: 1,
      budgetExhausted: false,
    },
    { catalogId: "tuned-model", fingerprint: await fingerprint(ENTRY) },
  ));
  const settings = { value: { ...DEFAULT_SETTINGS, speedPreset: "light" } };
  const resolved = await new TunedSettings({ profilesDir: dir, registry, settings, fingerprint }).resolve("m1", "comprehension");
  assert.equal(resolved.settings.threads, 4);
  assert.equal(resolved.settings.systemPrompt, "Think from first principles.");
  assert.equal(resolved.settings.reasoning, "auto");
  assert.equal(resolved.speedPreset, "light");
  const quiet = await new TunedSettings({ profilesDir: dir, registry, settings: { value: { ...DEFAULT_SETTINGS, speedPreset: "quiet" } }, fingerprint }).resolve("m1", "comprehension");
  assert.equal(quiet.settings.threads, 2);
  assert.equal(quiet.speedPreset, "quiet");
});

test("only quality was tuned: those keys apply and everything else stays default", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-tuned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveProfile(dir, profileFromTune(
    { load: { settings: { contextSize: 8192 } }, tasks: {}, stages: { quality: "done", speed: "pending", sampling: {}, prompt: {} }, sweeps: [], runs: 1, budgetExhausted: false },
    { catalogId: "tuned-model", fingerprint: await fingerprint(ENTRY) },
  ));
  const resolved = await new TunedSettings({ profilesDir: dir, registry, settings: { value: DEFAULT_SETTINGS }, fingerprint }).resolve("m1", "code");
  assert.deepEqual(resolved.settings, { contextSize: 8192 });
  assert.equal(resolved.task, null);
  assert.equal(resolved.stages.speed, "pending");
});

test("the speed preset setting defaults to fastest and accepts light and quiet", () => {
  assert.equal(normalizeSettings({}).speedPreset, "fastest");
  assert.equal(normalizeSettings({ speedPreset: "light" }).speedPreset, "light");
  assert.equal(normalizeSettings({ speedPreset: "quiet" }).speedPreset, "quiet");
  assert.equal(normalizeSettings({ speedPreset: "turbo" }).speedPreset, "fastest");
});

test("a profile that chose the GPU loads the model on it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-tuned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveProfile(dir, profileFromTune(
    {
      load: { settings: { gpuBackend: "vulkan", gpuLayers: "max", contextSize: 8192 } },
      device: { settings: { gpuBackend: "vulkan", gpuLayers: "max" }, probe: [], reason: "vulkan faster" },
      tasks: {},
      stages: { device: "done", quality: "done" },
      sweeps: [],
      runs: 1,
      budgetExhausted: false,
    },
    { catalogId: "tuned-model", fingerprint: await fingerprint(ENTRY) },
  ));
  const resolved = await new TunedSettings({ profilesDir: dir, registry, settings: { value: DEFAULT_SETTINGS }, fingerprint }).resolve("m1");
  assert.equal(resolved.settings.gpuBackend, "vulkan");
  assert.equal(resolved.settings.gpuLayers, "max");
});

// ADR-161: engines get updated. A profile measured on one build must not be silently applied to another.
async function engineSetup(t, { recorded = "b100", engineVersion }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-tuned-engine-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveProfile(dir, profileFromTune(
    {
      load: { settings: { contextSize: 8192, threads: 6, engine: "llama-server:vulkan", gpuBackend: "vulkan", gpuLayers: "max" } },
      device: { settings: { engine: "llama-server:vulkan", gpuBackend: "vulkan", gpuLayers: "max" }, probe: [], reason: "x", ...(recorded && { engineVersion: recorded }) },
      tasks: { code: { settings: { temperature: 0.1 } } },
      sweeps: [], runs: 1, budgetExhausted: false,
    },
    { catalogId: "tuned-model", fingerprint: await fingerprint(ENTRY) },
  ));
  return new TunedSettings({ profilesDir: dir, registry, settings: { value: { ...DEFAULT_SETTINGS } }, fingerprint, engineVersion });
}

test("a profile whose engine has since been updated says so, and still applies", async (t) => {
  const asked = [];
  const tuned = await engineSetup(t, { engineVersion: (id) => { asked.push(id); return "b200"; } });
  const resolved = await tuned.resolve("m1", "code");
  assert.deepEqual(asked, ["llama-server:vulkan"]);
  assert.equal(resolved.engineChanged, true);
  assert.ok(resolved.warnings.some((warning) => /llama-server:vulkan b100, now b200: tune again/.test(warning)), resolved.warnings.join(" | "));
  assert.equal(resolved.settings.engine, "llama-server:vulkan", "a changed build is a warning, not a refusal");
});

test("the same engine version, an unknown one, or a profile from before versions were recorded, warn about nothing", async (t) => {
  for (const [recorded, now] of [["b100", "b100"], ["b100", null], [null, "b200"]]) {
    const resolved = await (await engineSetup(t, { recorded, engineVersion: () => now })).resolve("m1", "code");
    assert.equal(resolved.engineChanged, false, `${recorded} -> ${now}`);
    assert.equal(resolved.warnings.some((warning) => /tune again so the profile matches the engine/.test(warning)), false);
  }
  const noResolver = await (await engineSetup(t, { engineVersion: undefined })).resolve("m1", "code");
  assert.equal(noResolver.engineChanged, false);
});
