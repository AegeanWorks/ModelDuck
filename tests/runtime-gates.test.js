import assert from "node:assert/strict";
import test from "node:test";

import { slotClamp, vramFitsModel } from "../src/engine.js";
import { templateCompat } from "../src/model-registry.js";

// IDEA-1084: sequences share one window.
test("slotClamp divides the remainder across slots", () => {
  assert.equal(slotClamp(512, 2048, 1), 512);
  assert.equal(slotClamp(512, 500, 2), 250);
  assert.equal(slotClamp(512, 0, 2), 0);
});

// IDEA-1159: the flip needs measured VRAM.
test("vramFitsModel refuses what does not fit and abstains when blind", () => {
  assert.equal(vramFitsModel({ freeBytes: 8e9, modelBytes: 2e9 }).fits, true);
  assert.equal(vramFitsModel({ freeBytes: 1e9, modelBytes: 2e9 }).fits, false);
  assert.equal(vramFitsModel({ freeBytes: null, modelBytes: 2e9 }).fits, null);
});

// IDEA-1093/1228: template resolution names the fallback and the rename risk.
test("templateCompat flags missing templates and private names", () => {
  const missing = templateCompat({ fileName: "model.gguf", chatTemplate: false });
  assert.equal(missing.status, "fallback");
  assert.equal(missing.warnings.length, 1);
  const renamed = templateCompat({ fileName: "_model.gguf", chatTemplate: true });
  assert.equal(renamed.status, "model");
  assert.equal(renamed.warnings.length, 1);
  const clean = templateCompat({ fileName: "model.gguf", chatTemplate: true });
  assert.deepEqual(clean.warnings, []);
});
