import assert from "node:assert/strict";
import test from "node:test";

import { noEntryShortcutCount, resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";

const check = { type: "jsTests", entry: "solve", cases: [{ args: [2, 3], expect: 5 }, { args: [4, 5], expect: 9 }] };

test("code that cannot mention the entry is judged in-process", async () => {
  resetJavaScriptTestCache();
  const before = noEntryShortcutCount();
  const result = await runJavaScriptTests("```js\nfunction other(a,b){ return a+b; }\nconst x = 1;\n```", check);
  assert.equal(noEntryShortcutCount(), before + 1);
  assert.deepEqual(result, [
    { type: "jsTests", passed: false, unreadable: true, detail: "solve(2,3): function not found" },
    { type: "jsTests", passed: false, unreadable: true, detail: "solve(4,5): function not found" },
  ]);
});

test("a check with setup or dynamic constructs still takes the child path", async () => {
  resetJavaScriptTestCache();
  const before = noEntryShortcutCount();
  await runJavaScriptTests("```js\nconst x = 1;\n```", { ...check, setup: "var helper = 1;" });
  await runJavaScriptTests("```js\nglobalThis.other = 1;\n```", check);
  assert.equal(noEntryShortcutCount(), before, "setup and dynamic definitions are excluded");
});

test("valid code still takes the child path", async () => {
  resetJavaScriptTestCache();
  const before = noEntryShortcutCount();
  const result = await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  assert.equal(noEntryShortcutCount(), before);
  assert.deepEqual(result.map((item) => item.passed), [true, true]);
});
