import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { historyTrimAvoidanceCount, loadBenchmarkReport, resetBenchmarkReportCache } from "../src/benchmark-report.js";

const line = (o) => JSON.stringify(o);

test("blank history lines are detected without trimming each line", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-history-trim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = [line({ type: "run", uid: "r1", result: { phase: "model" } }), "", "  ", ""].join("\n");
  await writeFile(path.join(dir, "history.jsonl"), text);
  resetBenchmarkReportCache();
  const before = historyTrimAvoidanceCount();
  await loadBenchmarkReport({ benchmarkDir: dir });
  assert.ok(historyTrimAvoidanceCount() > before, "blank lines were skipped without trim()");
});

test("history parsing keeps the same runs and links across blank lines", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-history-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = [line({ type: "link", runUid: "r1", commit: { hash: "abc1234" } }),
    "", "  ",
    line({ type: "run", uid: "r1", result: { phase: "model", finishedAt: "x", overall: { score: 90 } } }), ""].join("\n");
  await writeFile(path.join(dir, "history.jsonl"), text);
  resetBenchmarkReportCache();
  const report = await loadBenchmarkReport({ benchmarkDir: dir });
  assert.equal(report.history.length, 1);
  assert.equal(report.history[0].commit.hash, "abc1234");
});
