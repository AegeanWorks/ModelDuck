import assert from "node:assert/strict";
import test from "node:test";

import { JAVASCRIPT_TEST_CACHE_LIMIT } from "../benchmarks/suite.mjs";

test("the judge cache holds a full tuning wave of repeated answers", () => {
  // A quick pass asks hundreds of answers and repeats them across load variants;
  // a 512-entry bound evicted the first ones and paid a fresh sandbox spawn.
  assert.ok(JAVASCRIPT_TEST_CACHE_LIMIT >= 2048,
    `judge cache bound is ${JAVASCRIPT_TEST_CACHE_LIMIT}; repeated tuning answers must not be evicted`);
});
