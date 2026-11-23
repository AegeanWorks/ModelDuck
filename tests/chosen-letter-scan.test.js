import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTextCheck, namedLetterScanCount } from "../benchmarks/suite.mjs";

test("choice checks run the named-letter scan once per reply", () => {
  const before = namedLetterScanCount();
  evaluateTextCheck({ type: "choice", value: "b" }, "The answer is B");
  assert.equal(namedLetterScanCount(), before + 1);
});

test("choice verdicts stay identical across label shapes", () => {
  const check = { type: "choice", value: "b" };
  for (const reply of ["B", "(B)", "B)", "Answer: B", "Option B", "the answer is (B)", "I think the answer is B"]) {
    assert.equal(evaluateTextCheck(check, reply).passed, true, `should read B from ${reply}`);
  }
  for (const reply of ["A", "C", "B or C", "no letter"]) {
    assert.equal(evaluateTextCheck(check, reply).passed, false, `should not read B from ${reply}`);
  }
  // Last named letter wins when several appear.
  assert.equal(evaluateTextCheck(check, "Option A and then Answer: B").passed, true);
  assert.equal(evaluateTextCheck({ type: "choice", value: "a" }, "Option A and then Answer: B").passed, false);
});
