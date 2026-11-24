import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cachedAnswers, cachedAnswersReadCount, startRun } from "../src/tune-runs.js";

test("cachedAnswers reads only the newest runs and keeps their row order", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-careads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", modelFile: "m", modelSize: 1, cpu: "c", platform: "p", arch: "a" };
  for (let r = 0; r < 5; r += 1) {
    const rec = await startRun(dir, {
      profileId: "p", model: "m", request: {}, fingerprint: fp,
      now: new Date(1000 + r * 1000),
    });
    await rec.answers([{ item: `run${r}`, seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 }]);
    await rec.finish({ outcome: "complete" });
  }

  // Only the three newest runs (r=4,3,2) are selected; default limitRuns is 3.
  const before = cachedAnswersReadCount();
  const groups = await cachedAnswers(dir, { profileId: "p", fingerprint: fp });
  assert.equal(cachedAnswersReadCount(), before + 3, "only 3 answer files read");
  assert.equal(groups.length, 1, "one settings/seed group");
  assert.deepEqual(groups[0].rows.map((row) => row.item), ["run4", "run3", "run2"], "newest-first row order");

  // limitRows stops after the first accepted row, yet all chosen files are still read.
  const mid = cachedAnswersReadCount();
  const capped = await cachedAnswers(dir, { profileId: "p", fingerprint: fp, limitRows: 1 });
  assert.equal(cachedAnswersReadCount(), mid + 3, "still reads the 3 chosen files");
  assert.equal(capped[0].rows.length, 1, "early break keeps one row");
  assert.equal(capped[0].rows[0].item, "run4", "the newest row is kept");
});
