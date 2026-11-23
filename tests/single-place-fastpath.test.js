import assert from "node:assert/strict";
import test from "node:test";

import { answerCandidatePlaceSets, evaluateTextCheck } from "../benchmarks/suite.mjs";

test("single-line replies skip the generic place-construction path", () => {
  const before = answerCandidatePlaceSets();
  evaluateTextCheck({ type: "exact", value: "42" }, "The answer is 42");
  assert.equal(answerCandidatePlaceSets(), before, "one string needs no dedup or filter");
  evaluateTextCheck({ type: "exact", value: "42" }, "first line\nAnswer: 42");
  assert.equal(answerCandidatePlaceSets(), before + 1, "multi-line replies still use the generic path");
});

test("verdicts stay identical across the two paths", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  assert.equal(evaluateTextCheck(exact, "header\nAnswer: the quick brown fox").passed, true);
  assert.equal(evaluateTextCheck(exact, "The answer is the slow turtle").passed, false);
  const oneOf = { type: "oneOf", values: ["alpha", "beta", "gamma"] };
  assert.equal(evaluateTextCheck(oneOf, "Answer: beta").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "header\nAnswer: gamma").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "Answer: delta").passed, false);
});
