import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listRuns, listRunsReadCount, listRunsSummaryParses, resetRunSummaryCache, runSummaryCacheStats, startRun } from "../src/tune-runs.js";

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

test("listRuns parses unchanged summaries once, clones rows and keeps liveness live", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-listruns-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetRunSummaryCache();
  const request = { stages: ["sampling"], tasks: ["code"] };
  const older = await startRun(dir, { profileId: "p", model: "m", request, pid: 424242, now: new Date(1000) });
  const newer = await startRun(dir, { profileId: "p", model: "m", request, pid: 424242, now: new Date(2000) });
  await older.update({ sweeps: [{ axis: "temperature" }], result: { tasks: { code: { rate: 50 } } } });
  await newer.update({ answers: 3 });

  const parsesBefore = listRunsSummaryParses();
  const alive = await listRuns(dir, { isAlive: () => true });
  assert.equal(listRunsSummaryParses(), parsesBefore + 2, "the first listing parses both summaries");
  assert.equal(alive[0].sweeps, undefined, "large run details stay out of the listing");
  assert.equal(alive[0].result, undefined);
  alive[0].request.stages.push("mutated");

  const dead = await listRuns(dir, { isAlive: () => false });
  assert.equal(listRunsSummaryParses(), parsesBefore + 2, "unchanged summaries are not reparsed");
  assert.deepEqual(dead[0].request.stages, ["sampling"], "a caller cannot mutate the cached summary");
  assert.equal(dead[0].outcome, "interrupted", "process liveness is evaluated per listing");
  assert.ok(dead[0].durationMs >= alive[0].durationMs, "unfinished duration remains live");

  await newer.update({ answers: 7 });
  const changed = await listRuns(dir, { isAlive: () => true });
  assert.equal(listRunsSummaryParses(), parsesBefore + 3, "only the rewritten summary is reparsed");
  assert.equal(changed[0].answers, 7);
  const stats = runSummaryCacheStats();
  assert.equal(stats.size, 2);
  assert.equal(stats.hits, 3);
  assert.equal(stats.misses, 3);

  await writeFile(path.join(dir, `${older.id}.json`), "not-json");
  await writeFile(path.join(dir, `${older.id}.json.bak`), "also-bad");
  const quarantined = await listRuns(dir, { isAlive: () => true });
  assert.equal(listRunsSummaryParses(), parsesBefore + 4, "a changed corrupt summary still reaches the quarantine reader");
  assert.deepEqual(quarantined.map((run) => run.id), [newer.id], "a stale cached row cannot survive corruption");
  assert.equal(runSummaryCacheStats().size, 1);
  resetRunSummaryCache();
});
