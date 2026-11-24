import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { itemOutcomes, itemOutcomesReadCount, startRun } from "../src/tune-runs.js";

test("itemOutcomes reads each answer file once and keeps counts", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-ioreads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12 };
  for (let r = 0; r < 8; r += 1) {
    const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp, now: new Date(Date.now() + r * 1000) });
    await rec.answers([
      { item: "right", seed: 42, settings: { temperature: r % 2 ? 0.1 : 0.2 }, passed: 1, total: 1 },
      { item: "wrong", seed: 42, settings: { temperature: r % 2 ? 0.1 : 0.2 }, passed: 0, total: 1 },
    ]);
    await rec.finish({ outcome: "complete" });
  }
  const before = itemOutcomesReadCount();
  const result = await itemOutcomes(dir, { profileId: "p", fingerprint: fp });
  assert.equal(itemOutcomesReadCount(), before + 8, "all 8 answer files read once");
  assert.deepEqual(result.counts, {
    right: { right: 8, wrong: 0, seen: 8, settings: 2 },
    wrong: { right: 0, wrong: 8, seen: 8, settings: 2 },
  });
  assert.deepEqual([...result.saturated], ["right", "wrong"]);
});
