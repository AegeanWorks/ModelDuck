import assert from "node:assert/strict";
import test from "node:test";

import { resetJavaScriptTestCache, runJavaScriptTests, syntaxShortcutCount } from "../benchmarks/suite.mjs";

const check = { type: "jsTests", entry: "solve", cases: [{ args: [2, 3], expect: 5 }, { args: [4, 5], expect: 9 }] };

test("a syntax-error answer is judged in-process without a child", async () => {
  resetJavaScriptTestCache();
  const before = syntaxShortcutCount();
  const result = await runJavaScriptTests("Here is my answer: the result is 42.", check);
  assert.equal(syntaxShortcutCount(), before + 1);
  assert.deepEqual(result, [
    { type: "jsTests", passed: false, unreadable: true, detail: "solve(2,3): did not run (syntax or runtime error)" },
    { type: "jsTests", passed: false, unreadable: true, detail: "solve(4,5): did not run (syntax or runtime error)" },
  ]);
});

test("a named but malformed function keeps the same verdict", async () => {
  resetJavaScriptTestCache();
  const result = await runJavaScriptTests("function solve(a,b) { return a b; }", check);
  assert.ok(result.every((item) => !item.passed && item.unreadable === false && item.detail.includes("did not run")));
});

test("valid code still takes the child path", async () => {
  resetJavaScriptTestCache();
  const before = syntaxShortcutCount();
  const result = await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  assert.equal(syntaxShortcutCount(), before, "no in-process shortcut for valid code");
  assert.deepEqual(result.map((item) => item.passed), [true, true]);
});
