import assert from "node:assert/strict";
import test from "node:test";

import {
  listProfiles, loadProfile, loadProfileStatCount, profileStampFor, resetProfileListCache, saveProfile,
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
