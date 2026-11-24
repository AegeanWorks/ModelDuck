import assert from "node:assert/strict";
import test from "node:test";

import { speedItems, speedItemsComputations, resetSpeedItemsCache } from "../benchmarks/tasks.mjs";
import { expectedAnswers, estimateTune, DEFAULT_STEPS } from "../benchmarks/tune-grid.mjs";

test("speedItems is derived once per prompt set and gives each caller its own array", () => {
  resetSpeedItemsCache();
  const first = speedItems();
  const before = speedItemsComputations();
  const second = speedItems();
  assert.deepEqual(second, first);
  assert.notEqual(second, first, "callers cannot mutate the cached list");
  assert.equal(speedItemsComputations(), before, "no rebuild");
  second.push("tamper");
  assert.deepEqual(speedItems(), first, "the cached list is untouched");
});

test("tune estimates reuse the same speed workload", () => {
  resetSpeedItemsCache();
  expectedAnswers(DEFAULT_STEPS);
  const before = speedItemsComputations();
  estimateTune(DEFAULT_STEPS);
  expectedAnswers(DEFAULT_STEPS);
  assert.equal(speedItemsComputations(), before, "estimates build the workload at most once");
});
