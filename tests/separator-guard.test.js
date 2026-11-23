import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTextCheck, givenNumberSeparatorRuns } from "../benchmarks/suite.mjs";

test("the thousands-separator regex only runs when a comma is present", () => {
  const before = givenNumberSeparatorRuns();
  evaluateTextCheck({ type: "number", value: "42" }, "The answer is 42");
  assert.equal(givenNumberSeparatorRuns(), before, "no comma means no separator work");
  evaluateTextCheck({ type: "number", value: "1234" }, "Answer: 1,234");
  assert.equal(givenNumberSeparatorRuns(), before + 1);
});

test("number verdicts stay identical with and without separators", () => {
  const check = { type: "number", value: "1234" };
  assert.equal(evaluateTextCheck(check, "Answer: 1,234").passed, true);
  assert.equal(evaluateTextCheck(check, "The answer is 1234").passed, true);
  assert.equal(evaluateTextCheck(check, "Answer: 1,235").passed, false);
  assert.equal(evaluateTextCheck({ type: "number", value: "3.14" }, "the value is $3.14").passed, true);
  assert.equal(evaluateTextCheck({ type: "number", value: "42" }, "no number here").passed, false);
});
