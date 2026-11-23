import assert from "node:assert/strict";
import test from "node:test";

import { answerCandidatePlaces, evaluateTextCheck } from "../benchmarks/suite.mjs";

test("a single-line reply is examined as one distinct place", () => {
  const before = answerCandidatePlaces();
  evaluateTextCheck({ type: "exact", value: "x" }, "The answer is x");
  assert.equal(answerCandidatePlaces(), before + 1, "whole text, first line and last line are the same string");
});

test("dedup keeps the same verdicts for exact and oneOf checks", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "Answer: the slow turtle").passed, false);
  const oneOf = { type: "oneOf", values: ["alpha", "beta", "gamma"] };
  assert.equal(evaluateTextCheck(oneOf, "Answer: beta").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "Answer: delta").passed, false);
  // Distinct lines stay distinct candidates.
  assert.equal(evaluateTextCheck(exact, "unrelated first line\nThe answer is the quick brown fox").passed, true);
});
