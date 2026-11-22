import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { cpuTopology, resetSystemInfoCache, systemInfo } from "../src/system.js";

test("CPU topology is read once and reused by every systemInfo call", () => {
  resetSystemInfoCache();
  const first = cpuTopology();
  assert.equal(cpuTopology(), first);
  assert.equal(systemInfo().cpu, first.model);
  assert.equal(cpuTopology(), first);
});

test("systemInfo reads no CPU data after the first call", () => {
  resetSystemInfoCache();
  for (let i = 0; i < 5; i += 1) systemInfo();
  const start = performance.now();
  for (let i = 0; i < 20; i += 1) systemInfo();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2, `${elapsed.toFixed(2)} ms for 20 reads; uncached os.cpus() costs ~7 ms`);
});

test("live fields are still live", () => {
  const a = systemInfo();
  const b = systemInfo();
  assert.equal(typeof a.uptime, "number");
  assert.ok(b.uptime >= a.uptime);
  assert.equal(typeof a.totalMemory, "number");
  assert.equal(a.platform, process.platform);
});
