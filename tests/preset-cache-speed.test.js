import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readShippedPresets, resetShippedPresetCache, shippedPresetReads } from "../src/preset-match.js";

test("unchanged shipped presets are read once", async () => {
  resetShippedPresetCache();
  const first = await readShippedPresets();
  const reads = shippedPresetReads();
  assert.ok(reads > 0, "the first call must actually parse the presets");
  const second = await readShippedPresets();
  assert.equal(shippedPresetReads(), reads);
  assert.deepEqual(second, first);
});

test("a changed preset directory invalidates the cache", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-presets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetShippedPresetCache();
  assert.deepEqual(await readShippedPresets(dir), []);
  const before = shippedPresetReads();
  await writeFile(path.join(dir, "broken.modelduck-profile.json"), "not json");
  const second = await readShippedPresets(dir);
  assert.deepEqual(second, [], "an invalid file is still skipped");
  assert.ok(shippedPresetReads() > before, "a changed stamp must force a fresh read");
});
