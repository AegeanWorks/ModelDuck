import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listProfiles, loadProfile, loadProfileSlim, loadProfileStatCount, profileSlimCacheStats, profileSlimParses, profileStampFor, resetProfileCache, resetProfileListCache, saveProfile,
} from "../src/model-profiles.js";
import { makeHarness } from "./helpers.js";

test("loadProfile reuses the stamp computed by listProfiles", async (t) => {
  const cleanups = [];
  const proxy = { addCleanup: (f) => cleanups.push(f), after: (f) => cleanups.push(f) };
  const harness = await makeHarness(proxy, { models: 4 });
  t.after(() => cleanups.reverse().forEach((fn) => fn()));
  for (let i = 0; i < 4; i += 1) {
    await saveProfile(harness.paths.profiles, { schema: 1, catalogId: `test-model-${i}`, createdAt: `2026-01-0${i + 1}`, tasks: {} });
  }
  resetProfileListCache();
  const listed = await listProfiles(harness.paths.profiles);
  assert.equal(listed.length, 4);

  const fingerprint = { suiteVersion: 18 };
  const before = loadProfileStatCount();
  const withStamp = await loadProfile(harness.paths.profiles, "test-model-0", fingerprint, profileStampFor(harness.paths.profiles, "test-model-0"));
  assert.ok(withStamp);
  assert.equal(loadProfileStatCount(), before, "a known stamp avoids the stat");

  const without = await loadProfile(harness.paths.profiles, "test-model-0", fingerprint);
  assert.equal(loadProfileStatCount(), before + 1, "an unknown stamp stats as before");
  assert.deepEqual(withStamp, without, "both paths return the same profile");

  const missing = await loadProfile(harness.paths.profiles, "not-saved", fingerprint, profileStampFor(harness.paths.profiles, "not-saved"));
  assert.equal(missing, null, "an absent profile still returns null");
});

test("slim profile reads parse once, clone callers and never narrow full resume reads", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-profile-slim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = {
    schema: 1,
    catalogId: "slim-model",
    createdAt: "2026-11-25T00:00:00.000Z",
    fingerprint: { suiteVersion: 18 },
    load: { settings: { threads: 4, contextSize: 4096 } },
    device: { settings: { gpuBackend: "cpu" } },
    tasks: { code: { settings: { temperature: 0.2 }, stats: { rate: 75 } } },
    stages: { sampling: { code: "done" } },
    progress: { sampling: { code: { axis: "temperature" } } },
    sweeps: [{ axis: "temperature", changed: true }],
    search: { runs: 4 },
  };
  await saveProfile(dir, profile);
  resetProfileCache();
  const fingerprint = { suiteVersion: 18 };
  const first = await loadProfileSlim(dir, "slim-model", fingerprint);
  assert.equal(first.profile.sweeps, undefined);
  assert.equal(first.profile.progress, undefined);
  assert.equal(first.profile.tasks.code.settings.temperature, 0.2);
  assert.equal(profileSlimParses(), 1);
  first.profile.tasks.code.settings.temperature = 0.9;
  first.typeWarnings.code = ["mutated"];

  const second = await loadProfileSlim(dir, "slim-model", fingerprint);
  assert.equal(second.profile.tasks.code.settings.temperature, 0.2, "callers cannot mutate the cached projection");
  assert.deepEqual(second.typeWarnings, {}, "cached type warnings are cloned too");
  assert.equal(profileSlimParses(), 1, "an unchanged profile is not reparsed");
  assert.deepEqual(profileSlimCacheStats(), { size: 1, hits: 1, misses: 1 });

  const full = await loadProfile(dir, "slim-model", fingerprint);
  assert.deepEqual(full.profile.sweeps, profile.sweeps, "full reads keep resume evidence");
  assert.deepEqual(full.profile.progress, profile.progress);
  assert.deepEqual(full.stale, second.stale);

  await saveProfile(dir, { ...profile, tasks: { code: { settings: { temperature: 0.4 }, stats: { rate: 80 } } } });
  const changed = await loadProfileSlim(dir, "slim-model", fingerprint);
  assert.equal(changed.profile.tasks.code.settings.temperature, 0.4, "save invalidates the slim cache");
  assert.equal(profileSlimParses(), 2);
  resetProfileCache();
});
