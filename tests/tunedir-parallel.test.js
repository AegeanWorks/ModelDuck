import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cachedAnswers, itemOutcomes, startRun, tuneRunReadCount } from "../src/tune-runs.js";

test("run summaries are gathered in one parallel pass per reader", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-tunedir-par-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12 };
  for (let i = 0; i < 8; i += 1) {
    const r = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp, now: new Date(Date.now() + i * 1000) });
    await r.answers([{ item: "i0", seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 }]);
    await r.finish({ outcome: "complete" });
  }
  const before = tuneRunReadCount();
  const cached = await cachedAnswers(dir, { profileId: "p", fingerprint: fp });
  assert.equal(tuneRunReadCount(), before + 8, "cachedAnswers gathered all 8 summaries");
  assert.ok(cached.length > 0);
  const mid = tuneRunReadCount();
  const outcomes = await itemOutcomes(dir, { profileId: "p", fingerprint: fp });
  assert.equal(tuneRunReadCount(), mid + 8, "itemOutcomes gathered all 8 summaries");
  assert.ok(outcomes.counts.i0);
});
