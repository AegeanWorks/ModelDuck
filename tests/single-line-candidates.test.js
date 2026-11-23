import assert from "node:assert/strict";
import test from "node:test";

import { answerCandidateLineSplits, evaluateTextCheck } from "../benchmarks/suite.mjs";

test("a single-line reply is not split into lines", () => {
  const before = answerCandidateLineSplits();
  evaluateTextCheck({ type: "exact", value: "42" }, "The answer is 42");
  assert.equal(answerCandidateLineSplits(), before, "no newline means no split");
  evaluateTextCheck({ type: "exact", value: "42" }, "first line\nAnswer: 42");
  assert.equal(answerCandidateLineSplits(), before + 1, "a multi-line reply still splits");
});

test("verdicts stay identical for single- and multi-line replies", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "unrelated first line\nThe answer is the quick brown fox").passed, true);
  assert.equal(evaluateTextCheck(exact, "The answer is the slow turtle").passed, false);
  const oneOf = { type: "oneOf", values: ["alpha", "beta", "gamma"] };
  assert.equal(evaluateTextCheck(oneOf, "Answer: beta").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "header\nAnswer: gamma").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "Answer: delta").passed, false);
});
