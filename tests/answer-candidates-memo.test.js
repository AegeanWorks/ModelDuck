import assert from "node:assert/strict";
import test from "node:test";

import { answerCandidateComputations, evaluateTextCheck } from "../benchmarks/suite.mjs";

test("the same reply is turned into candidates once", () => {
  const before = answerCandidateComputations();
  const exact = { type: "exact", value: "42" };
  const oneOf = { type: "oneOf", values: ["42", "43"] };
  evaluateTextCheck(exact, "The answer is 42");
  const afterFirst = answerCandidateComputations();
  evaluateTextCheck(oneOf, "The answer is 42");
  assert.equal(answerCandidateComputations(), afterFirst, "a second check reuses the candidates");
  assert.ok(afterFirst > before, "the first check computed them");
});

test("verdicts stay identical across cached and fresh replies", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "just forty two").passed, false);
});
