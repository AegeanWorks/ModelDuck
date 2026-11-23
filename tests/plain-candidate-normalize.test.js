import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTextCheck, fenceStripCount } from "../benchmarks/suite.mjs";

test("plain candidates are not re-checked for code fences", () => {
  const before = fenceStripCount();
  evaluateTextCheck({ type: "exact", value: "the answer" }, "The answer is the answer");
  // One strip for the reply in plainText, one for the expected value; none for
  // the already-plain candidate strings.
  assert.equal(fenceStripCount(), before + 2);
});

test("verdicts stay identical for fenced and plain answers", () => {
  const exact = { type: "exact", value: "the quick brown fox" };
  assert.equal(evaluateTextCheck(exact, "```\nThe answer is the quick brown fox.\n```").passed, true);
  assert.equal(evaluateTextCheck(exact, "The answer is the quick brown fox.").passed, true);
  const oneOf = { type: "oneOf", values: ["alpha", "beta", "gamma"] };
  assert.equal(evaluateTextCheck(oneOf, "Answer: beta").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "```\nAnswer: beta\n```").passed, true);
  assert.equal(evaluateTextCheck(oneOf, "Answer: delta").passed, false);
});
