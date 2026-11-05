import assert from "node:assert/strict";
import test from "node:test";

import { slotClamp, vramFitsModel } from "../src/engine.js";
import { templateCompat } from "../src/model-registry.js";

// IDEA-1084: sequences share one window. slotClamp is the production shape:
// no Math.max wrapper at the call site, so what is tested is what ships.
test("slotClamp divides the remainder across slots", () => {
  assert.equal(slotClamp(512, 2048, 1), 512);
  assert.equal(slotClamp(512, 500, 2), 250);
  assert.equal(slotClamp(512, 0, 2), 0);
  // Progress is guaranteed while anything remains: fewer tokens than slots
  // still yields 1 instead of a 0-token cap the runtime would reject.
  assert.equal(slotClamp(512, 1, 8), 1);
  assert.equal(slotClamp(512, 7, 8), 1);
  // Junk sequence counts collapse to one slot instead of overbooking.
  assert.equal(slotClamp(512, 100, 0), 100);
  assert.equal(slotClamp(512, 100, "nope"), 100);
  assert.equal(slotClamp(0, 100, 8), 0, "no budget asked, no budget given");
});

// IDEA-1159: the flip needs measured VRAM.
test("vramFitsModel refuses what does not fit and abstains when blind", () => {
  assert.equal(vramFitsModel({ freeBytes: 8e9, modelBytes: 2e9 }).fits, true);
  assert.equal(vramFitsModel({ freeBytes: 1e9, modelBytes: 2e9 }).fits, false);
  assert.equal(vramFitsModel({ freeBytes: 1e9, modelBytes: 2e9, reserveBytes: 8e9 }).fits, false);
  assert.equal(vramFitsModel({ freeBytes: null, modelBytes: 2e9 }).fits, null);
  assert.equal(vramFitsModel({ freeBytes: undefined, modelBytes: 2e9 }).fits, null);
  assert.equal(vramFitsModel({ freeBytes: NaN, modelBytes: 2e9 }).fits, null);
  assert.equal(vramFitsModel({ freeBytes: 8e9, modelBytes: 0 }).fits, null, "a weightless model is not a fit verdict");
  assert.equal(vramFitsModel({ freeBytes: 8e9, modelBytes: -5 }).fits, null);
  assert.equal(vramFitsModel({}).fits, null);
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
