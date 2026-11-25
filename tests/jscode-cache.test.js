import assert from "node:assert/strict";
import test from "node:test";

import { javascriptTestCacheStats, resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";

const check = { type: "jsTests", entry: "solve", cases: [{ args: [2, 3], expect: 6 }, { args: [4, 5], expect: 20 }] };
const code = "function solve(a, b) { return a * b; }";
const variants = [code, "```js\n" + code + "\n```", "Here:\n\n```javascript\n" + code + "\n```\nDone."];

test("formatting variants of the same code share one verification", async () => {
  resetJavaScriptTestCache();
  const results = [];
  for (const text of variants) results.push(await runJavaScriptTests(text, check));
  const stats = javascriptTestCacheStats();
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.equal(results[0].every((row) => row.passed), true);
  assert.equal(stats.misses, 1, "only one child verification");
  assert.equal(stats.codeHits, 2, "the other two formats reuse the code verdict");
});

test("identical concurrent checks share one in-flight child verdict", async () => {
  resetJavaScriptTestCache();
  const [first, second] = await Promise.all([
    runJavaScriptTests(code, check),
    runJavaScriptTests(code, check),
  ]);
  assert.deepEqual(first, second);
  const stats = javascriptTestCacheStats();
  assert.equal(stats.misses, 1, "concurrent duplicates do not spawn two children");
  assert.equal(stats.hits, 1, "the waiting caller records the same cache hit as a sequential caller");
});

test("concurrent formatting variants share one in-flight code verdict", async () => {
  resetJavaScriptTestCache();
  const [first, second] = await Promise.all([
    runJavaScriptTests(variants[0], check),
    runJavaScriptTests(variants[1], check),
  ]);
  assert.deepEqual(first, second);
  const stats = javascriptTestCacheStats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.codeHits, 1, "the formatting variant records a code-verdict hit");
  assert.equal(stats.hits, 1);
});

test("different code still gets its own verdict", async () => {
  resetJavaScriptTestCache();
  const first = await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  const second = await runJavaScriptTests("```js\nfunction solve(a, b) { return a * b; }\n```", check);
  assert.notDeepEqual(first, second);
  assert.equal(javascriptTestCacheStats().misses, 2);
});
