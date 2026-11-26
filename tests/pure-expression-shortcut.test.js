import assert from "node:assert/strict";
import test from "node:test";

import {
  pureShortcutCount,
  resetJavaScriptTestCache,
  runJavaScriptTests,
  sandboxSpawnCount,
} from "../benchmarks/suite.mjs";

const check = {
  type: "jsTests",
  entry: "solve",
  cases: [
    { args: [2, 3], expect: 5 },
    { args: [4, 5], expect: 9 },
  ],
};

const details = (result) => result.map((item) => item.detail);

test("a single-return arithmetic function is judged in process", async () => {
  resetJavaScriptTestCache();
  const beforePure = pureShortcutCount();
  const beforeSpawn = sandboxSpawnCount();
  const result = await runJavaScriptTests("```js\nfunction solve(a, b) { return a + b; }\n```", check);
  assert.deepEqual(result.map((item) => item.passed), [true, true]);
  assert.equal(result.every((item) => !item.unreadable), true);
  assert.equal(pureShortcutCount(), beforePure + 1);
  assert.equal(sandboxSpawnCount(), beforeSpawn, "no child is spawned for a provably pure function");
});

test("the in-process verdict matches the sandbox for coercion and comparison", async () => {
  const source = "function solve(a, b) { return a > b ? a - b : a / b; }";
  const cases = {
    type: "jsTests",
    entry: "solve",
    cases: [
      { args: ["1", "2"], expect: 0.5 },
      { args: [6, 3], expect: 3 },
    ],
  };
  resetJavaScriptTestCache();
  const sandboxed = await runJavaScriptTests(source, cases);
  resetJavaScriptTestCache();
  const inProcess = await runJavaScriptTests(source, cases);
  assert.deepEqual(inProcess, sandboxed);
  assert.deepEqual(details(inProcess), [
    'solve("1","2"): ok',
    "solve(6,3): ok",
  ]);
});

test("calls, globals, updates, assignments and sandbox bindings keep the child path", async () => {
  const sources = [
    "function solve(a, b) { return Math.max(a, b); }",
    "function solve(a, b) { return Number(a) + b; }",
    "function solve(a, b) { return a++; }",
    "function solve(a, b) { return a = b; }",
    "function solve(a, b) { return arguments[0] + b; }",
    "function solve(a, b) { return __os ? a + b : 0; }",
    "function solve(a, b) { return [a + b][0]; }",
  ];
  for (const source of sources) {
    resetJavaScriptTestCache();
    const beforePure = pureShortcutCount();
    const beforeSpawn = sandboxSpawnCount();
    await runJavaScriptTests(source, check);
    assert.equal(pureShortcutCount(), beforePure, `no shortcut for ${source}`);
    assert.equal(sandboxSpawnCount(), beforeSpawn + 1, `sandbox still judges ${source}`);
  }
});

test("setup and harness checks never take the pure path", async () => {
  for (const extra of [
    { setup: "var factor = 2;" },
    { harness: "if (factor !== 2) throw new Error('setup');" },
  ]) {
    resetJavaScriptTestCache();
    const beforePure = pureShortcutCount();
    await runJavaScriptTests("function solve(a, b) { return a + b; }", { ...check, ...extra, setup: extra.setup ?? "", harness: extra.harness ?? "" });
    assert.equal(pureShortcutCount(), beforePure);
  }
});

test("a repeated answer still uses the existing verdict cache", async () => {
  resetJavaScriptTestCache();
  const source = "function solve(a, b) { return a + b; }";
  const first = await runJavaScriptTests(source, check);
  const beforePure = pureShortcutCount();
  const beforeSpawn = sandboxSpawnCount();
  const second = await runJavaScriptTests(source, check);
  assert.deepEqual(second, first);
  assert.equal(pureShortcutCount(), beforePure);
  assert.equal(sandboxSpawnCount(), beforeSpawn);
});
