import assert from "node:assert/strict";
import test from "node:test";

import { outputLimitComputations, resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";

const check = { type: "jsTests", entry: "solve", cases: [{ args: [2, 3], expect: 5 }, { args: [4, 5], expect: 9 }] };
const text = "```js\nfunction solve(a, b) { return a + b; }\n```";

test("the byte limit is computed once per static case array", async () => {
  resetJavaScriptTestCache();
  const before = outputLimitComputations();
  await runJavaScriptTests(`${text} // 1`, check);
  const afterFirst = outputLimitComputations();
  await runJavaScriptTests(`${text} // 2`, check);
  assert.equal(outputLimitComputations(), afterFirst, "the same cases array reuses its limit");
  assert.ok(afterFirst > before, "the first judge computed the limit");
});
