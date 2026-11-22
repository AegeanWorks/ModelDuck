import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { checkJavaScriptSyntax } from "../benchmarks/suite.mjs";

test("plain script syntax is checked in-process, without a child process per answer", async () => {
  const started = performance.now();
  for (let i = 0; i < 20; i += 1) {
    const verdict = await checkJavaScriptSyntax("function f(value) { return value + 1; }");
    assert.equal(verdict.passed, true);
    assert.equal(verdict.detail, "node --check");
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms for 20 checks; a spawn per answer takes ~1 s`);
});

test("a syntax error is still a syntax error", async () => {
  const verdict = await checkJavaScriptSyntax("function f( { return 1; }");
  assert.equal(verdict.passed, false);
  assert.equal(verdict.detail, "syntax error");
});

test("module syntax keeps the node --check path and still passes", async () => {
  const verdict = await checkJavaScriptSyntax("export const answer = 42;");
  assert.equal(verdict.passed, true);
});
