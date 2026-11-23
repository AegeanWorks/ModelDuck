import assert from "node:assert/strict";
import test from "node:test";

import { resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";

const check = { type: "jsTests", entry: "solve", cases: [{ args: [2, 3], expect: 6 }, { args: [4, 5], expect: 20 }] };
const text = "```js\nfunction solve(a, b) { return a * b; }\n```";

test("judge cache hits reuse the stored result objects", async () => {
  resetJavaScriptTestCache();
  await runJavaScriptTests(text, check); // miss: fills the cache
  const second = await runJavaScriptTests(text, check);
  const third = await runJavaScriptTests(text, check);
  assert.deepEqual(third, second);
  assert.equal(third[0], second[0], "the stored verdict objects are reused, not cloned");
  assert.notEqual(third, second, "a fresh array is still returned");
});

test("a caller mutating the returned array cannot corrupt the cache", async () => {
  resetJavaScriptTestCache();
  const first = await runJavaScriptTests(text, check);
  first.pop();
  first.push({ type: "jsTests", passed: false, detail: "tamper" });
  const second = await runJavaScriptTests(text, check);
  assert.equal(second.length, 2);
  assert.equal(second[1].passed, true);
});
