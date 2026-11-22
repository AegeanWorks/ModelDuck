import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listProfiles, profileListParses, resetProfileListCache } from "../src/model-profiles.js";

const PROFILE = JSON.stringify({
  schema: 1, catalogId: "catalog-1", createdAt: "2026-01-01",
  tasks: { code: {}, recall: {} }, settings: { temperature: 0.1 },
});

test("an unchanged profile directory is read once", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-profile-list-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "p1.json"), PROFILE);
  resetProfileListCache();
  const first = await listProfiles(dir);
  assert.equal(first.length, 1);
  assert.equal(profileListParses(), 1);
  const second = await listProfiles(dir);
  assert.deepEqual(second, first);
  assert.equal(profileListParses(), 1);
  assert.notEqual(second, first, "callers get a copy, not the cache's array");
});

test("adding a profile invalidates the cache", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-profile-list-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetProfileListCache();
  await writeFile(path.join(dir, "p1.json"), PROFILE);
  assert.equal((await listProfiles(dir)).length, 1);
  await writeFile(path.join(dir, "p2.json"), PROFILE.replace("catalog-1", "catalog-2"));
  assert.equal((await listProfiles(dir)).length, 2);
  assert.equal(profileListParses(), 2, "the changed directory was read again");
});
