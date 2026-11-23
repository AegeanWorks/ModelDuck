import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTextCheck, numberScanCount } from "../benchmarks/suite.mjs";

test("number checks run the last-match scan once per reply", () => {
  const before = numberScanCount();
  evaluateTextCheck({ type: "number", value: "42" }, "The answer is 42");
  assert.equal(numberScanCount(), before + 1);
});

test("number verdicts stay identical across answer shapes", () => {
  const cases = [
    ["The answer is 42", "42", true],
    ["Answer: 1,234", "1234", true],
    ["the value is $3.14 and also 99", "99", true],
    ["Answer: -7.5", "-7.5", true],
    ["answer: 1 answer: 2", "2", true],
    ["no numbers here", "42", false],
    ["1 2 3 4 5 6 7 8 9 10", "10", true],
    ["0", "0", true],
  ];
  for (const [reply, value, expected] of cases) {
    assert.equal(evaluateTextCheck({ type: "number", value }, reply).passed, expected, `reply: ${reply}`);
  }
});
