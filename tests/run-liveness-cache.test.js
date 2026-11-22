import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import test from "node:test";

import { listRuns, startRun } from "../src/tune-runs.js";

test("one liveness check per distinct pid when listing many runs", async (t) => {
  const dir = await mkdtemp(os.tmpdir() + "/md-run-liveness-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 40; i += 1) {
    await startRun(dir, { profileId: `p${i}`, model: "m.gguf", request: {}, pid: 424242 });
  }
  let calls = 0;
  const isAlive = (pid) => { calls += 1; assert.equal(pid, 424242); return true; };
  const runs = await listRuns(dir, { isAlive });
  assert.equal(runs.length, 40);
  assert.equal(calls, 1, `expected one liveness probe for 40 runs on one pid, got ${calls}`);
});

test("distinct pids are each checked", async (t) => {
  const dir = await mkdtemp(os.tmpdir() + "/md-run-liveness-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await startRun(dir, { profileId: "a", model: "m.gguf", request: {}, pid: 111 });
  await startRun(dir, { profileId: "b", model: "m.gguf", request: {}, pid: 222 });
  const seen = new Set();
  const isAlive = (pid) => { seen.add(pid); return true; };
  assert.equal((await listRuns(dir, { isAlive })).length, 2);
  assert.deepEqual([...seen].sort(), [111, 222]);
});
