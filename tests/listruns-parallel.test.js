import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listRuns, listRunsReadCount, startRun } from "../src/tune-runs.js";

test("listRuns gathers every valid run and keeps newest first", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-listruns-par-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recs = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await startRun(dir, { profileId: "p", model: "m", request: {}, pid: 424242, now: new Date(1000 + i * 1000) });
    await r.finish({ outcome: "complete" });
    recs.push(r.id);
  }
  const before = listRunsReadCount();
  const runs = await listRuns(dir, { isAlive: () => true });
  assert.equal(runs.length, 12);
  assert.equal(listRunsReadCount(), before + 12);
  assert.deepEqual(runs.map((r) => r.id), [...recs].reverse(), "newest first");
  assert.equal((await listRuns(dir, { isAlive: () => true })).length, 12);
});
