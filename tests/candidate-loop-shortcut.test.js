import assert from "node:assert/strict";
import test from "node:test";

import { answerCandidateShortcuts, evaluateTextCheck } from "../benchmarks/suite.mjs";

test("a bare answer skips the general candidate construction", () => {
  const before = answerCandidateShortcuts();
  evaluateTextCheck({ type: "exact", value: "42" }, "42");
  assert.equal(answerCandidateShortcuts(), before + 1);
  evaluateTextCheck({ type: "exact", value: "42" }, "The answer is 42");
  assert.equal(answerCandidateShortcuts(), before + 1, "a lead-in is not a bare answer");
});

test("verdicts stay identical across lead-in, label and sentence shapes", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  for (const reply of [
    "the quick brown fox",
    "The answer is the quick brown fox.",
    "ANSWER IS the quick brown fox",
    "x: the quick brown fox",
    "The value is the quick brown fox",
    "The value is in the quick brown fox",
  ]) {
    assert.equal(evaluateTextCheck(exact, reply).passed, true, `failed for ${reply}`);
  }
  assert.equal(evaluateTextCheck(exact, "the slow turtle").passed, false);
  const oneOf = { type: "oneOf", values: ["alpha", "beta", "gamma"] };
  assert.equal(evaluateTextCheck(oneOf, "ANSWER IS gamma").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "label: beta").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "Answer: delta").passed, false);
});
