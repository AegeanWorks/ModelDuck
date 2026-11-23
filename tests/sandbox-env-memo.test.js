import assert from "node:assert/strict";
import test from "node:test";

import { resetSandboxEnvCounter, sandboxEnv, sandboxEnvComputations } from "../benchmarks/sandbox.mjs";

test("the default sandbox env is built once", () => {
  resetSandboxEnvCounter();
  const before = sandboxEnvComputations();
  const first = sandboxEnv();
  const second = sandboxEnv();
  assert.deepEqual(second, first);
  assert.notEqual(second, first, "a fresh object is returned to callers");
  assert.equal(sandboxEnvComputations(), before + 1, "the default env is constructed once");
});

test("custom env and platform arguments still build a fresh value", () => {
  resetSandboxEnvCounter();
  const before = sandboxEnvComputations();
  const custom = sandboxEnv({ PATH: "C:\\bin", SystemRoot: "C:\\Windows" }, "win32");
  assert.equal(custom.SystemRoot, "C:\\Windows");
  assert.equal(sandboxEnvComputations(), before + 1);
  assert.deepEqual(sandboxEnv({ PATH: "x", HOME: "/home/me" }, "linux"), {});
  assert.equal(sandboxEnvComputations(), before + 2);
});
