import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTextCheck, normalizedValueCacheStats, resetNormalizedValueCache } from "../benchmarks/suite.mjs";

test("static expected values are normalized once", () => {
  resetNormalizedValueCache();
  const exact = { type: "exact", value: "the quick brown fox" };
  evaluateTextCheck(exact, "The answer is the quick brown fox.");
  const afterFirst = normalizedValueCacheStats().computes;
  evaluateTextCheck(exact, "The answer is the quick brown fox.");
  assert.equal(normalizedValueCacheStats().computes, afterFirst, "the same value is reused");
  assert.ok(normalizedValueCacheStats().hits >= 1, "the second lookup is a cache hit");
});

test("distinct expected values still get their own normalization", () => {
  resetNormalizedValueCache();
  evaluateTextCheck({ type: "exact", value: "alpha" }, "alpha");
  evaluateTextCheck({ type: "exact", value: "beta" }, "beta");
  assert.equal(normalizedValueCacheStats().computes, 2);
  const oneOf = { type: "oneOf", values: ["gamma", "delta"] };
  evaluateTextCheck(oneOf, "delta");
  assert.equal(normalizedValueCacheStats().computes, 4);
  assert.equal(evaluateTextCheck(oneOf, "delta").passed, true);
  assert.equal(evaluateTextCheck({ type: "exact", value: "alpha" }, "alpha").passed, true);
});
