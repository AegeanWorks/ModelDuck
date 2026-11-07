import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importRecipe } from "../src/model-profiles.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESETS = path.join(HERE, "..", "benchmarks", "presets");

test("every committed preset recipe is importable and carries measured stats", async () => {
  const files = (await readdir(PRESETS)).filter((name) => name.endsWith(".modelduck-profile.json"));
  assert.ok(files.length > 0, "at least one measured preset is committed");
  for (const name of files) {
    const recipe = JSON.parse(await readFile(path.join(PRESETS, name), "utf8"));
    assert.equal(recipe.kind, "modelduck-profile", name);
    assert.equal(recipe.schema, 1, name);
    assert.equal(`${recipe.catalogId}.modelduck-profile.json`, name, "the file name names its model");
    const profile = importRecipe(recipe);
    assert.equal(profile.catalogId, recipe.catalogId);
    assert.ok(Object.keys(profile.tasks).length > 0, `${name} carries a task preset`);
    for (const preset of Object.values(profile.tasks)) {
      assert.ok(Number.isFinite(preset.stats?.rate), `${name} records a measured rate`);
      assert.ok(preset.stats.rate >= 0 && preset.stats.rate <= 100, `${name} rate is a percentage`);
      assert.ok(Number.isFinite(preset.stats.items) && preset.stats.items > 0, `${name} records its item count`);
    }
    // A recipe is settings and receipts only: no tensor, weight or binary payload.
    const text = JSON.stringify(recipe).toLowerCase();
    assert.ok(!/"(tensors?|weights|blob)"\s*:/.test(text), `${name} carries no model weights`);
  }
});
