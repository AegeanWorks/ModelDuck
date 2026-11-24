import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fileForComputations, loadProfile, resetFileForCache, saveProfile } from "../src/model-profiles.js";

test("profile paths are derived once per directory and catalog id", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-filefor-memo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 6; i += 1) {
    await saveProfile(dir, { schema: 1, catalogId: `m${i}`, createdAt: "x", tasks: { code: { settings: { temperature: 0.2 } } } });
  }
  resetFileForCache();

  const before = fileForComputations();
  const first = await loadProfile(dir, "m0", {});
  assert.ok(first);
  assert.equal(fileForComputations(), before + 1, "first lookup builds the path");
  const after = fileForComputations();
  const second = await loadProfile(dir, "m0", {});
  assert.deepEqual(second, first);
  assert.equal(fileForComputations(), after, "a repeated id reuses the path");
  await loadProfile(dir, "m1", {});
  assert.equal(fileForComputations(), after + 1, "a different id builds its own path");

  await assert.rejects(() => loadProfile(dir, "../escape", {}), /profile name is invalid/);
  assert.equal(fileForComputations(), after + 1, "invalid ids are still refused without caching");
});
