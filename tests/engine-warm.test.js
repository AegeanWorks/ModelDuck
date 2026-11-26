import assert from "node:assert/strict";
import test from "node:test";
import { LlamaEngine } from "../src/engine.js";
import { RoutedEngine } from "../src/engine-router.js";

const registry = { findById: () => null, list: () => [] };

test("warming the runtime imports it once, ahead of the first load", async () => {
  let imports = 0;
  const engine = new LlamaEngine({ registry, loadRuntime: async () => { imports += 1; return {}; } });
  await engine.warmRuntime();
  assert.equal(imports, 1);
});

test("a runtime that is not installed does not fail the warm-up", async () => {
  const engine = new LlamaEngine({ registry, loadRuntime: async () => { throw new Error("Cannot find package"); } });
  await assert.doesNotReject(engine.warmRuntime());
});

test("the routed engine warms the in-process runtime", async () => {
  let imports = 0;
  const inProcess = new LlamaEngine({ registry, loadRuntime: async () => { imports += 1; return {}; } });
  const routed = new RoutedEngine({ inProcess, resolve: () => null, fallback: true });
  await routed.warmRuntime();
  assert.equal(imports, 1);
});
