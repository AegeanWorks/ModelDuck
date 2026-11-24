import assert from "node:assert/strict";
import test from "node:test";

import { resetTypeWarningsCache, typeWarnings, typeWarningsComputations } from "../src/model-profiles.js";

const byType = {
  bugfix: { p: 0.01, right: 2, defaultRight: 8, items: 100 },
  format: { p: 0.4, right: 8, defaultRight: 8, items: 100 },
};
const profile = { tasks: { code: { stats: { byType } }, recall: { stats: { byType: { fact: { p: 0.001, right: 1, defaultRight: 5, items: 40 } } } } } };

test("typeWarnings is derived once per profile and task filter", () => {
  resetTypeWarningsCache();
  const full = typeWarnings(profile);
  const before = typeWarningsComputations();
  assert.equal(typeWarnings(profile), full, "same profile reuses the result");
  assert.deepEqual(typeWarnings(profile, "code"), { code: full.code }, "a filtered call has its own entry");
  assert.equal(typeWarnings(profile, "code"), typeWarnings(profile, "code"));
  assert.equal(typeWarningsComputations(), before + 1, "only the filtered call was new");
  assert.deepEqual(full.code, [{ type: "bugfix", items: 100, right: 2, defaultRight: 8, p: 0.01 }]);
  assert.deepEqual(typeWarnings(profile, "missing"), {});
});

test("typeWarnings still handles profiles without statistics", () => {
  resetTypeWarningsCache();
  assert.deepEqual(typeWarnings({ tasks: { code: {} } }), {});
  assert.deepEqual(typeWarnings(null), {});
});
