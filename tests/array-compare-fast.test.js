import assert from "node:assert/strict";
import test from "node:test";

import { ARRAY_COMPARE_MODE, sameStringArray } from "../benchmarks/tune-grid.mjs";

test("array equality uses element-wise comparison", () => {
  assert.equal(ARRAY_COMPARE_MODE, "elementwise");
});

test("element-wise equality matches JSON.stringify for step arrays", () => {
  const cases = [
    [[], [], true],
    [["a", "b"], ["a", "b"], true],
    [["a", "b"], ["b", "a"], false],
    [["a", "b"], ["a"], false],
    [["a", "b"], ["a", "c"], false],
    [["a:b", "c'd"], ["a:b", "c'd"], true],
    [["<html>", "x"], ["<html>", "y"], false],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(sameStringArray(left, right), expected);
    assert.equal(sameStringArray(left, right), JSON.stringify(left) === JSON.stringify(right), `mismatch for ${JSON.stringify(left)} / ${JSON.stringify(right)}`);
  }
});
