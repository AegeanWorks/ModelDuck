import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readShippedPresets, resetShippedPresetCache } from "../src/preset-match.js";

test("shipped presets are read concurrently and keep sorted order", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-preset-par-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const catalogId = `m${`${i}`.padStart(2, "0")}`;
    ids.push(catalogId);
    await writeFile(path.join(dir, `${catalogId}.modelduck-profile.json`), JSON.stringify({
      kind: "modelduck-profile", schema: 1, catalogId, createdAt: `x${i}`,
      tasks: { code: { settings: { temperature: i / 100 } } },
    }));
  }

  const real = fs.promises.readFile;
  let inFlight = 0;
  let maxInFlight = 0;
  fs.promises.readFile = async (...args) => {
    if (String(args[0]).endsWith(".modelduck-profile.json")) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    }
    try {
      return await real(...args);
    } finally {
      if (String(args[0]).endsWith(".modelduck-profile.json")) inFlight -= 1;
    }
  };
  t.after(() => { fs.promises.readFile = real; });

  resetShippedPresetCache();
  const presets = await readShippedPresets(dir);
  assert.deepEqual(presets.map((recipe) => recipe.catalogId), ids, "sorted recipe list unchanged");
  assert.ok(maxInFlight > 1, `preset reads overlapped (max ${maxInFlight})`);

  const cached = await readShippedPresets(dir);
  assert.deepEqual(cached, presets, "the cached list is unchanged");
});
