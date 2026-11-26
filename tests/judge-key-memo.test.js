import assert from "node:assert/strict";
import test from "node:test";

import { jsTestCheckKeyComputations, jsTestKeyComputations, resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";

const check = { type: "jsTests", entry: "solve", cases: [{ args: [2, 3], expect: 6 }] };
const text = "```js\nfunction solve(a, b) { return a * b; }\n```";

test("repeated judge calls reuse the constructed cache key", async () => {
  resetJavaScriptTestCache();
  const first = await runJavaScriptTests(text, check);
  const afterFirst = jsTestKeyComputations();
  const second = await runJavaScriptTests(text, check);
  assert.deepEqual(second, first);
  assert.equal(jsTestKeyComputations(), afterFirst, "same arguments must not rebuild the key");
});

test("the check portion of a judge key is serialized once per check", async () => {
  resetJavaScriptTestCache();
  const before = jsTestCheckKeyComputations();
  await runJavaScriptTests(text, check);
  await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  assert.equal(jsTestCheckKeyComputations(), before + 1, "the same check object must not be serialized twice");
});

test("a different check or text still gets its own key and verdict", async () => {
  resetJavaScriptTestCache();
  const first = await runJavaScriptTests(text, check);
  const afterFirst = jsTestKeyComputations();
  const other = await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  assert.equal(jsTestKeyComputations(), afterFirst + 1, "different text rebuilds the key");
  assert.notDeepEqual(other, first);
  const otherCheck = { ...check, cases: [{ args: [2, 3], expect: 5 }] };
  await runJavaScriptTests(text, otherCheck);
  assert.equal(jsTestKeyComputations(), afterFirst + 2, "a different check rebuilds the key");
});
