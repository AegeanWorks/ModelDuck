import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTextCheck, plainTextComputations } from "../benchmarks/suite.mjs";

test("repeated replies are cleaned once", () => {
  const before = plainTextComputations();
  const exact = { type: "exact", value: "42" };
  evaluateTextCheck(exact, "The answer is 42");
  const afterFirst = plainTextComputations();
  evaluateTextCheck(exact, "The answer is 42");
  assert.equal(plainTextComputations(), afterFirst, "same reply reuses the cleaned text");
  assert.ok(afterFirst > before, "the first check cleaned the reply");
});

test("verdicts stay identical across cached and fresh replies", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "**the quick brown fox**").passed, true);
});
