import assert from "node:assert/strict";
import test from "node:test";

import { typeWarnings } from "../src/model-profiles.js";

const byType = {
  bugfix: { p: 0.01, right: 2, defaultRight: 8, items: 100 },
  format: { p: 0.4, right: 8, defaultRight: 8, items: 100 },
};

test("typeWarnings with a task filter returns the same array as the full scan", () => {
  const profile = { tasks: { code: { stats: { byType } }, recall: { stats: { byType: { fact: { p: 0.001, right: 1, defaultRight: 5, items: 40 } } } } } };
  const full = typeWarnings(profile);
  assert.deepEqual(typeWarnings(profile, "code"), { code: full.code });
  assert.deepEqual(typeWarnings(profile, "recall"), { recall: full.recall });
  assert.deepEqual(typeWarnings(profile, "missing"), {});
  assert.deepEqual(typeWarnings(profile), full, "no filter still returns every task");
});

test("typeWarnings only reads stats for the requested task", () => {
  let statsReads = 0;
  const tasks = {};
  for (let i = 0; i < 12; i += 1) {
    const preset = {};
    Object.defineProperty(preset, "stats", {
      enumerable: true,
      get() { statsReads += 1; return { byType }; },
    });
    tasks[i === 0 ? "code" : `task${i}`] = preset;
  }
  const out = typeWarnings({ tasks }, "code");
  assert.deepEqual(out.code, [{ type: "bugfix", items: 100, right: 2, defaultRight: 8, p: 0.01 }]);
  assert.equal(statsReads, 1, "one task's statistics read, not twelve");
});
