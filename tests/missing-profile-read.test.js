import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProfile, profileMissingSkips, resetProfileCache } from "../src/model-profiles.js";

const PROFILE = JSON.stringify({ schema: 1, catalogId: "catalog-1", createdAt: "2026-01-01", tasks: { code: {} } });

test("a file that stat says is missing is not read again", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-missing-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetProfileCache();
  const before = profileMissingSkips();
  assert.equal(await loadProfile(dir, "absent", null), null);
  assert.ok(profileMissingSkips() > before, "the redundant readFile must be skipped");
});

test("a profile created after a missing lookup is still loaded", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-missing-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetProfileCache();
  assert.equal(await loadProfile(dir, "catalog-1", null), null);
  await writeFile(path.join(dir, "catalog-1.json"), PROFILE);
  const loaded = await loadProfile(dir, "catalog-1", null);
  assert.equal(loaded?.profile?.catalogId, "catalog-1");
});
