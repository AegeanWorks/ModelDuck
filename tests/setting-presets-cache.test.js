import assert from "node:assert/strict";
import test from "node:test";

import { settingPresets, settingPresetsComputations } from "../src/config.js";

test("the preset list is built once", () => {
  const before = settingPresetsComputations();
  const first = settingPresets();
  const second = settingPresets();
  assert.deepEqual(second, first);
  assert.equal(settingPresetsComputations(), before + 1);
  assert.notEqual(second, first, "a fresh array is returned to callers");
});

test("cached presets keep their content and cannot be mutated through the array", () => {
  const presets = settingPresets();
  assert.ok(presets.length > 0);
  assert.ok(presets.every((preset) => preset.id && preset.label && preset.settings));
  presets.pop();
  assert.equal(settingPresets().length, presets.length + 1);
});
