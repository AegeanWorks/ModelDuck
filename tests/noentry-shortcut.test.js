import assert from "node:assert/strict";
import test from "node:test";

import { noEntryShortcutCount, resetJavaScriptTestCache, runtimeShortcutCount, runJavaScriptTests } from "../benchmarks/suite.mjs";

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

test("provably unbound identifier arithmetic keeps the runtime-error verdict without a child", async () => {
  resetJavaScriptTestCache();
  const before = runtimeShortcutCount();
  for (const text of ["answer", "answer-0", "0+answer"]) {
    const result = await runJavaScriptTests(text, { ...check, harness: "if (helper !== 1) throw new Error('setup');" });
    assert.deepEqual(result, [
      { type: "jsTests", passed: false, unreadable: true, detail: "solve(2,3): did not run (syntax or runtime error)" },
      { type: "jsTests", passed: false, unreadable: true, detail: "solve(4,5): did not run (syntax or runtime error)" },
    ]);
  }
  assert.equal(runtimeShortcutCount(), before + 3);
});

test("setup-defined names, child globals and the requested entry keep the child path", async () => {
  resetJavaScriptTestCache();
  const before = runtimeShortcutCount();
  await runJavaScriptTests("answer", { ...check, setup: "var answer = 1;" });
  await runJavaScriptTests("Math-answer", check);
  await runJavaScriptTests("arguments-0", check);
  await runJavaScriptTests("__filename-0", check);
  await runJavaScriptTests("__os-0", check);
  await runJavaScriptTests("solve-0", check);
  assert.equal(runtimeShortcutCount(), before, "no shortcut is claimed when evaluation may succeed or bind the entry");
});

test("valid code still takes the child path", async () => {
  resetJavaScriptTestCache();
  const before = noEntryShortcutCount();
  const result = await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  assert.equal(noEntryShortcutCount(), before);
  assert.deepEqual(result.map((item) => item.passed), [true, true]);
});
