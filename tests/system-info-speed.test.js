import assert from "node:assert/strict";
import test from "node:test";

import { cpuReadCount, cpuTopology, resetSystemInfoCache, systemInfo } from "../src/system.js";

test("CPU topology is read once and reused by every systemInfo call", () => {
  resetSystemInfoCache();
  const first = cpuTopology();
  assert.equal(cpuTopology(), first);
  assert.equal(systemInfo().cpu, first.model);
  assert.equal(cpuTopology(), first);
});

test("systemInfo reads no CPU data after the first call", () => {
  resetSystemInfoCache();
  assert.equal(cpuReadCount(), 0);
  systemInfo();
  assert.equal(cpuReadCount(), 1);
  for (let i = 0; i < 20; i += 1) systemInfo();
  assert.equal(cpuReadCount(), 1, "os.cpus() must not be re-read on later calls");
});

test("live fields are still live", () => {
  const a = systemInfo();
  const b = systemInfo();
  assert.equal(typeof a.uptime, "number");
  assert.ok(b.uptime >= a.uptime);
  assert.equal(typeof a.totalMemory, "number");
  assert.equal(a.platform, process.platform);
});
