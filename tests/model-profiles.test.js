import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePaths } from "../src/config.js";
import { MODEL_CATALOG } from "../src/model-catalog.js";
import {
  FINGERPRINT_KEYS,
  PROFILE_SCHEMA,
  currentFingerprint,
  importRecipe,
  listProfiles,
  loadProfile,
  measuredOnAfter,
  measuredUnderAfter,
  pendingWork,
  planTune,
  presetFor,
  profileCacheStats,
  profileFromTune,
  profileRecipe,
  profileIdFor,
  resetFingerprintCache,
  resetProfileCache,
  saveProfile,
  typeWarnings,
} from "../src/model-profiles.js";

const FINGERPRINT = Object.freeze({
  cpu: "Test CPU",
  cores: 8,
  platform: "win32",
  arch: "x64",
  nodeLlamaCpp: "3.22.2",
  suiteVersion: 8,
  taskHash: "abc123",
  modelFile: "qwen.gguf",
  modelSize: 1000,
});

const TUNE = {
  load: { settings: { contextSize: 8192, threads: 8, kvCache: "q8_0", temperature: 0.7, maxTokens: 512 }, stats: { rate: 90 } },
  tasks: {
    code: { settings: { temperature: 0.2, maxTokens: 1024 }, stats: { rate: 75, vsDefault: { rateDelta: 10, b: 0, c: 2, pValue: 0.5 } } },
    comprehension: { settings: { temperature: 0, maxTokens: 768 }, stats: { rate: 60 } },
  },
  speed: { fastest: { threads: 8, batchSize: 512 }, light: { threads: 4, batchSize: 512 }, quiet: { threads: 2, batchSize: 512 } },
  stages: { device: "done", quality: "done", speed: "done", sampling: { code: "done", comprehension: "done" }, prompt: { code: "done", comprehension: "partial" } },
  progress: { quality: { status: "done" }, sweeps: [] },
  sweeps: [{ stage: "speed", axis: "threads", rungs: [] }],
  runs: 321,
  budgetExhausted: false,
  options: { seeds: [42], passes: 2 },
};

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-profiles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const profile = () => profileFromTune(TUNE, { catalogId: "qwen2.5-0.5b-instruct-q4", fingerprint: FINGERPRINT, createdAt: "2026-10-30T20:00:00.000Z" });

test("profiles live under the data folder", () => {
  const home = path.join(os.tmpdir(), "duck-home");
  assert.equal(resolvePaths({ home }).profiles, path.join(path.resolve(home), "profiles"));
});

test("a tune becomes a profile with load settings, task presets and its statistics", () => {
  const value = profile();
  assert.equal(value.schema, PROFILE_SCHEMA);
  assert.deepEqual(value.load.settings, { contextSize: 8192, threads: 8, kvCache: "q8_0" }, "sampling keys are not load settings");
  assert.equal(value.tasks.code.stats.vsDefault.rateDelta, 10);
  assert.equal(value.search.runs, 321);
  assert.equal(value.sweeps.length, 1);
});

test("a profile records which items its search used", () => {
  const tunedOn = { comprehension: { items: 48, ids: ["m-1", "m-2"], excluded: ["m-3"], fellBack: false } };
  const value = profileFromTune({ ...TUNE, tunedOn }, { catalogId: "qwen2.5-0.5b-instruct-q4", fingerprint: FINGERPRINT });
  assert.deepEqual(value.tunedOn, tunedOn);
  assert.equal("tunedOn" in profile(), false, "a tune without a filtered search omits it");
});

test("a task preset is the tuned load settings, the speed preset and that task's settings", () => {
  assert.deepEqual(presetFor(profile(), "code"), { contextSize: 8192, threads: 8, kvCache: "q8_0", batchSize: 512, temperature: 0.2, maxTokens: 2048 }, "a suite-fitted 1024 cap is raised to the code serving floor (M1)");
  assert.equal(presetFor(profile(), "code", "light").threads, 4, "Light keeps half the threads free");
  assert.equal(presetFor(profile(), "code", "quiet").threads, 2, "Quiet keeps three quarters of the threads free");
  const legacy = { ...profile(), speed: { fastest: { threads: 8 }, light: { threads: 4 } } };
  assert.equal(presetFor(legacy, "code", "quiet").threads, 4, "a profile from before Quiet falls back to Light");
  assert.deepEqual(presetFor(profile(), "recall"), { contextSize: 8192, threads: 8, kvCache: "q8_0", batchSize: 512 }, "an untuned task keeps its default sampling");
  assert.equal(presetFor(null, "code"), null);
});

test("a profile recipe carries settings and a receipt, and imports back", () => {
  const recipe = profileRecipe(profile());
  assert.equal(recipe.kind, "modelduck-profile");
  assert.equal(recipe.catalogId, "qwen2.5-0.5b-instruct-q4");
  assert.equal("sweeps" in recipe, false, "the sweep log is not portable");
  assert.equal(recipe.receipt.rates.code.rate, 75);
  const imported = importRecipe(recipe);
  assert.deepEqual(imported.load.settings, { threads: 8, kvCache: "q8_0" }, "the 16K floor is the default, so it is not repeated");
  assert.equal(imported.load.settings.contextSize, undefined);
  assert.deepEqual(imported.tasks.code.settings, { temperature: 0.2, maxTokens: 1024 });
  assert.equal(imported.tasks.comprehension.settings.maxTokens, 768);
  assert.equal(imported.search.imported, true);
  assert.equal(imported.stages, null, "an imported profile is not marked as tuned here");
  assert.equal(imported.speed.quiet.threads, 2);
});

test("a recipe carries the newline and DRY settings and imports them back", () => {
  const recipe = profileRecipe(profile());
  recipe.tasks.code.settings = {
    temperature: 0.2, maxTokens: 1024, penalizeNewLine: false,
    dryStrength: 0.8, dryBase: 1.75, dryAllowedLength: 4,
    responsePrefix: "```", customStopTriggers: ["```"],
  };
  const imported = importRecipe(recipe);
  assert.deepEqual(imported.tasks.code.settings, {
    temperature: 0.2, maxTokens: 1024, penalizeNewLine: false,
    dryStrength: 0.8, dryBase: 1.75, dryAllowedLength: 4,
    responsePrefix: "```", customStopTriggers: ["```"],
  }, "tuned newline and DRY settings travel with the profile");
});

test("an imported recipe drops unknown and out-of-range settings", () => {
  const recipe = {
    ...profileRecipe(profile()),
    load: { settings: { threads: 9999, kvCache: "q4_0", gpuBackend: "vulkan", gpuLayers: "max" } },
    tasks: { code: { settings: { temperature: 5, maxTokens: 1024, evil: true }, stats: { rate: 75 } }, poetry: { settings: { temperature: 0 } } },
  };
  const imported = importRecipe(recipe);
  assert.equal(imported.load.settings.threads, undefined, "out of range");
  assert.equal(imported.load.settings.kvCache, "q4_0");
  assert.equal(imported.load.settings.gpuBackend, "vulkan");
  assert.equal(imported.load.settings.gpuLayers, "max");
  assert.equal(imported.tasks.code.settings.temperature, undefined, "out of range");
  assert.equal(imported.tasks.code.settings.maxTokens, 1024);
  assert.equal(imported.tasks.code.settings.evil, undefined);
  assert.equal(imported.tasks.poetry, undefined, "unknown task");
});

test("an imported recipe keeps the item subset it was tuned on", () => {
  const tunedOn = { code: { items: 48, ids: ["c-1", "c-2"], excluded: ["c-3"], fellBack: false }, poetry: { items: 9, ids: ["p-1"] } };
  const imported = importRecipe({ ...profileRecipe(profile()), tunedOn });
  assert.deepEqual(imported.tunedOn.code, tunedOn.code);
  assert.equal(imported.tunedOn.poetry, undefined, "an unknown task is dropped");
});

test("a recipe that is not a ModelDuck profile is refused", () => {
  assert.throws(() => importRecipe({ kind: "other", schema: 1 }), (error) => error.code === "profile_recipe_invalid");
  const recipe = profileRecipe(profile());
  assert.throws(() => importRecipe({ ...recipe, catalogId: "../escape" }), (error) => error.code === "profile_recipe_invalid");
  assert.throws(() => importRecipe({ ...recipe, load: {}, tasks: {} }), (error) => error.code === "profile_recipe_empty");
});

test("a preset's clearly worse question types are named", () => {
  const value = structuredClone(profile());
  value.tasks.code.stats.byType = {
    bugfix: { items: 12, right: 4, defaultRight: 9, p: 0.03 },
    code: { items: 10, right: 10, defaultRight: 10, p: 1 },
  };
  assert.deepEqual(typeWarnings(value).code.map((entry) => entry.type), ["bugfix"]);
  assert.deepEqual(typeWarnings(profile()), {}, "a profile without type statistics says nothing");
});

test("a profile keeps its speed presets, stage status and progress", () => {
  const value = profile();
  assert.equal(value.speed.light.threads, 4);
  assert.equal(value.stages.prompt.comprehension, "partial");
  assert.equal(value.progress.quality.status, "done");
});

test("a saved profile loads back fresh on the same machine", async (t) => {
  const dir = await directory(t);
  await saveProfile(dir, profile());
  const loaded = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", FINGERPRINT);
  assert.deepEqual(loaded.profile, profile());
  assert.deepEqual(loaded.stale, []);
  assert.equal(await loadProfile(dir, "smollm2-135m", FINGERPRINT), null);
});

test("the profile text cache is reused and invalidated by a save", async (t) => {
  const dir = await directory(t);
  resetProfileCache();
  await saveProfile(dir, profile());
  const first = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", FINGERPRINT);
  const afterFirst = profileCacheStats();
  const second = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", FINGERPRINT);
  const afterSecond = profileCacheStats();
  assert.deepEqual(second, first);
  assert.equal(afterFirst.misses, 1);
  assert.equal(afterSecond.hits, afterFirst.hits + 1);
  await saveProfile(dir, profileFromTune({ ...TUNE, runs: 999 }, { catalogId: "qwen2.5-0.5b-instruct-q4", fingerprint: FINGERPRINT }));
  const third = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", FINGERPRINT);
  assert.equal(third.profile.search.runs, 999, "a saved profile replaces the cached text");
  assert.equal(profileCacheStats().misses, afterSecond.misses + 1);
});

test("the fingerprint cache is bypassed by an explicit runtime", async () => {
  resetFingerprintCache();
  const entry = { fileName: "sub/qwen.gguf", size: 77 };
  const first = await currentFingerprint(entry);
  const second = await currentFingerprint(entry);
  assert.deepEqual(second, first);
  const explicit = await currentFingerprint(entry, { nodeLlamaCpp: "9.9.9" });
  assert.equal(explicit.nodeLlamaCpp, "9.9.9");
});

test("a profile is stale when the hardware, runtime, suite or model file changes", async (t) => {
  const dir = await directory(t);
  await saveProfile(dir, profile());
  const changed = { ...FINGERPRINT, cpu: "Other CPU", nodeLlamaCpp: "3.23.0", taskHash: "def456", modelSize: 2000 };
  const { stale, warnings, profile: kept } = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", changed);
  assert.deepEqual(stale.sort(), ["cpu", "modelSize", "nodeLlamaCpp", "taskHash"]);
  assert.equal(kept.catalogId, "qwen2.5-0.5b-instruct-q4", "a stale profile is still returned for use");
  assert.equal(warnings.length, 4);
  assert.ok(warnings.some((text) => /test items changed/i.test(text)));
  assert.ok(warnings.some((text) => /3\.22\.2 → 3\.23\.0/.test(text)));
});

test("a suite version change is reported with both versions", async (t) => {
  const dir = await directory(t);
  await saveProfile(dir, profile());
  const { warnings } = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", { ...FINGERPRINT, suiteVersion: 9 });
  assert.match(warnings[0], /test suite changed \(v8 → v9\)/i);
  assert.match(warnings[0], /re-tune/i);
});

test("the current fingerprint names this machine, runtime, test and model file", async () => {
  const value = await currentFingerprint({ fileName: "sub/qwen.gguf", size: 77 }, { nodeLlamaCpp: "9.9.9" });
  assert.deepEqual(Object.keys(value).sort(), [...FINGERPRINT_KEYS].sort());
  assert.equal(value.modelFile, "qwen.gguf");
  assert.equal(value.modelSize, 77);
  assert.equal(value.nodeLlamaCpp, "9.9.9");
  assert.match(value.taskHash, /^[a-f0-9]{16}$/);
});

test("unfinished stages are listed per task", () => {
  assert.deepEqual(pendingWork(profile(), ["code", "comprehension", "recall"]), ["prompt:comprehension", "sampling:recall", "prompt:recall"]);
  assert.deepEqual(pendingWork(profile(), ["code"], ["quality", "speed"]), []);
  assert.deepEqual(pendingWork(null, ["code"], ["quality"]), ["quality"]);
});

test("an unsupported schema is refused and left untouched", async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, "qwen2.5-0.5b-instruct-q4.json");
  const text = JSON.stringify({ ...profile(), schema: 99 });
  await writeFile(file, text);
  await assert.rejects(loadProfile(dir, "qwen2.5-0.5b-instruct-q4", FINGERPRINT), (error) => error.code === "profile_unsupported" && /99/.test(error.why));
  assert.equal(await readFile(file, "utf8"), text);
});

test("a catalog id that is not a plain file name is refused", async (t) => {
  const dir = await directory(t);
  await assert.rejects(saveProfile(dir, { ...profile(), catalogId: "../escape" }), (error) => error.code === "profile_invalid");
  await assert.rejects(loadProfile(dir, "..\\escape", FINGERPRINT), (error) => error.code === "profile_invalid");
});

test("a model file maps to its catalog id, or to a safe name for an imported file", () => {
  const catalog = MODEL_CATALOG[0];
  assert.equal(profileIdFor(catalog.file), catalog.id);
  assert.equal(profileIdFor(`sub/${catalog.file.toUpperCase()}`), catalog.id);
  assert.equal(profileIdFor("My Model (v2).Q4_K_M.gguf"), "my-model-v2-.q4_k_m");
});

test("listing returns every saved profile by model", async (t) => {
  const dir = await directory(t);
  assert.deepEqual(await listProfiles(path.join(dir, "missing")), []);
  await saveProfile(dir, profile());
  await saveProfile(dir, { ...profile(), catalogId: "smollm2-135m-instruct-q8" });
  await writeFile(path.join(dir, "notes.txt"), "ignored");
  assert.deepEqual((await listProfiles(dir)).map((item) => item.catalogId).sort(), ["qwen2.5-0.5b-instruct-q4", "smollm2-135m-instruct-q8"]);
});

test("a tune reuses what is saved before measuring again", () => {
  const fresh = { profile: profile(), stale: [], warnings: [] };
  assert.deepEqual(planTune(null, ["code"]), { resume: null });
  assert.deepEqual(planTune(fresh, ["code"]), { skip: true });
  assert.deepEqual(planTune(fresh, ["code", "comprehension"]), { resume: { ...profile().progress, sweeps: profile().sweeps } }, "comprehension's prompt stage is unfinished");
  const stale = { ...fresh, stale: ["suiteVersion"], warnings: ["The test suite changed (v8 → v9)."] };
  assert.deepEqual(planTune(stale, ["code"]), { skip: true }, "a stale profile is still used, with its warning");
  assert.throws(() => planTune(stale, ["recall"]), (error) => error.code === "tune_profile_stale" && /--force/.test(error.fix));
});

test("an explicit selection of settings always runs, resuming the saved progress, even on a stale profile", () => {
  const fresh = { profile: profile(), stale: [], warnings: [] };
  assert.deepEqual(planTune(fresh, ["code"], undefined, ["contextSize"]), { resume: { ...profile().progress, sweeps: profile().sweeps }, rerun: [] });
  const stale = { ...fresh, stale: ["suiteVersion"], warnings: ["changed"] };
  assert.deepEqual(planTune(stale, ["code"], undefined, ["contextSize"]), { resume: { ...profile().progress, sweeps: profile().sweeps }, rerun: [] }, "a part run keeps the rest of a stale profile (ADR-040)");
});

const PROGRESS = {
  device: { status: "done", settings: { gpuBackend: "vulkan" } },
  quality: { status: "done", settings: { contextSize: 8192 } },
  speed: { status: "done", settings: { threads: 8 } },
  sampling: { code: { status: "done", settings: { temperature: 0.2 } }, comprehension: { status: "done", settings: { temperature: 0 } } },
  prompt: { code: { status: "done", settings: { reasoning: "off" } }, comprehension: { status: "partial", settings: {} } },
  sweeps: [],
  runs: 10,
};
const withProgress = () => ({ ...profile(), progress: structuredClone(PROGRESS) });
const profileWith = (progress) => ({ ...profile(), progress });

test("choosing some stages measures them again on top of the saved rest, even when they are done or the profile is stale", () => {
  const stale = { profile: withProgress(), stale: ["suiteVersion"], warnings: ["changed"] };
  const quality = planTune(stale, ["code"], ["quality"]);
  assert.deepEqual(quality.rerun, ["quality"]);
  assert.equal(quality.resume.quality, undefined, "the chosen stage starts over");
  assert.deepEqual(quality.resume.device, PROGRESS.device, "the other stages stay as the starting point");
  assert.deepEqual(quality.resume.sampling, PROGRESS.sampling);
  const prompt = planTune(stale, ["code", "comprehension"], ["prompt"]);
  assert.deepEqual(prompt.rerun, ["prompt:code"], "a partial stage resumes instead of starting over");
  assert.deepEqual(Object.keys(prompt.resume.prompt), ["comprehension"]);
  assert.deepEqual(planTune(stale, ["code"], ["device"]).rerun, ["device"]);
  assert.throws(() => planTune(stale, ["recall"]), (error) => error.code === "tune_profile_stale", "a full run of a stale profile still needs --force");
});

test("a profile records which parts were measured under an older fingerprint and warns about only those", async (t) => {
  const dir = await directory(t);
  const now = { ...FINGERPRINT, suiteVersion: 9 };
  const saved = withProgress();
  const measuredUnder = measuredUnderAfter({ profile: saved }, now, TUNE.stages, ["quality"]);
  assert.deepEqual(measuredUnder.quality, now);
  assert.deepEqual(measuredUnder.device, FINGERPRINT, "parts not measured again keep their fingerprint");
  assert.deepEqual(measuredUnder["prompt:comprehension"], FINGERPRINT);
  await saveProfile(dir, profileFromTune(TUNE, { catalogId: "qwen2.5-0.5b-instruct-q4", fingerprint: now, measuredUnder }));
  const loaded = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", now);
  assert.deepEqual(loaded.stale, ["suiteVersion"]);
  assert.ok(!loaded.staleParts.includes("quality"));
  assert.ok(loaded.staleParts.includes("device") && loaded.staleParts.includes("sampling:code"));
  assert.match(loaded.warnings.at(-1), /Measured before that: device, speed/);
  assert.equal(measuredUnderAfter({ profile: saved }, FINGERPRINT, TUNE.stages, ["quality"]), null, "nothing to record when every part is current");
  assert.deepEqual(measuredUnderAfter(null, now, TUNE.stages, []), null, "a forced tune measures everything now");
});

test("a profile remembers the device each part was measured on and flags parts from another device", async (t) => {
  const dir = await directory(t);
  // An older profile on the GPU, without a record per part: its device stands in for every part.
  const saved = { profile: { ...withProgress(), load: { settings: { gpuBackend: "vulkan" } } } };
  const measuredOn = measuredOnAfter(saved, TUNE.stages, ["device"], "cpu");
  assert.equal(measuredOn.device, "cpu", "the device part was measured now");
  assert.equal(measuredOn.quality, "vulkan", "the rest keep the device they were measured on");
  assert.equal(measuredOn["sampling:code"], "vulkan");
  await saveProfile(dir, profileFromTune({ ...TUNE, load: { settings: { gpuBackend: "cpu" } } }, { catalogId: "qwen2.5-0.5b-instruct-q4", fingerprint: FINGERPRINT, measuredOn }));
  const loaded = await loadProfile(dir, "qwen2.5-0.5b-instruct-q4", FINGERPRINT);
  assert.deepEqual(loaded.stale, [], "another device is not a stale profile");
  assert.ok(loaded.deviceParts.includes("quality") && loaded.deviceParts.includes("prompt:comprehension"));
  assert.ok(!loaded.deviceParts.includes("device"));
  assert.match(loaded.warnings.at(-1), /measured on the vulkan GPU.*now on the CPU/i);
  assert.deepEqual(measuredOnAfter(null, TUNE.stages, [], "vulkan").quality, "vulkan", "a fresh tune measures everything on its device");
});

test("continuing a run measures only what is not done yet, even on a stale profile", () => {
  const stale = { profile: withProgress(), stale: ["suiteVersion"], warnings: ["changed"] };
  const plan = planTune(stale, ["code", "comprehension"], ["prompt"], null, { continueRun: true });
  assert.deepEqual(plan.rerun, [], "nothing finished is measured again");
  assert.deepEqual(plan.resume.prompt, PROGRESS.prompt, "the finished and partial task results are kept");

  // An interrupted prompt-only run: comprehension finished and nothing else was reached.
  const progress = structuredClone(PROGRESS);
  progress.prompt = { comprehension: { status: "done", settings: { reasoning: "off" } } };
  const profile = { ...profileWith(progress), stages: { ...TUNE.stages, prompt: { comprehension: "done" } } };
  const finished = { profile, stale: ["suiteVersion"], warnings: ["changed"] };
  const done = planTune(finished, ["comprehension"], ["prompt"], null, { continueRun: true });
  assert.deepEqual(done, { skip: true }, "nothing left to continue");
});
