import assert from "node:assert/strict";
import test from "node:test";

import {
  axesBuildComputations, qualityAxes, resetAxesCache, speedAxes,
} from "../benchmarks/tune-grid.mjs";
import { promptAxes } from "../benchmarks/tune-grid.mjs";
import { DEFAULT_STEPS } from "../benchmarks/tune-grid.mjs";

test("axis builders are derived once per steps object and key", () => {
  resetAxesCache();
  const load = DEFAULT_STEPS.load;
  const prompt = DEFAULT_STEPS.prompt;
  const q = qualityAxes(load);
  const s = speedAxes({ logicalCores: 8 }, load);
  const p = promptAxes(prompt, "code");
  const before = axesBuildComputations();
  assert.equal(qualityAxes(load), q);
  assert.equal(speedAxes({ logicalCores: 8 }, load), s);
  assert.equal(promptAxes(prompt, "code"), p);
  assert.equal(axesBuildComputations(), before, "all three reuse their cached lists");
  assert.notEqual(speedAxes({ logicalCores: 16 }, load), s, "a different core count gets its own axes");
  assert.notEqual(promptAxes(prompt, "recall"), p, "a different task gets its own axes");
  assert.deepEqual(q.map((axis) => axis.name), ["kvCache"]);
  assert.ok(Object.isFrozen(q) && Object.isFrozen(s) && Object.isFrozen(p));
});

test("primitive prompt steps still build axes without caching", () => {
  resetAxesCache();
  const axes = promptAxes("code", "code");
  assert.ok(Array.isArray(axes) && axes.length > 0);
  assert.equal(axesBuildComputations(), 0, "uncacheable inputs are simply built");
});
