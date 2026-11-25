import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cachedAnswers, cachedAnswersReadCount, createTuneHistoryCache, itemOutcomes, itemOutcomesReadCount, startRun, tuneRunReadCount } from "../src/tune-runs.js";

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

test("a shared answer cache avoids duplicate reads and refreshes an appended file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-tune-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12 };
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp, now: new Date(1000 + i * 1000) });
    await rec.answers([{ item: `run${i}`, seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 }]);
    await rec.finish({ outcome: "complete" });
    records.push(rec);
  }

  const cache = createTuneHistoryCache();
  const outcomeBefore = itemOutcomesReadCount();
  const cachedBefore = cachedAnswersReadCount();
  const summaryBefore = tuneRunReadCount();
  const outcomes = await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache: cache });
  assert.equal(itemOutcomesReadCount(), outcomeBefore + 5, "the first reader opens every answer file");
  assert.equal(tuneRunReadCount(), summaryBefore + 5, "the first reader opens every summary");
  assert.ok(outcomes.counts.run0);
  const groups = await cachedAnswers(dir, { profileId: "p", fingerprint: fp, historyCache: cache });
  assert.equal(cachedAnswersReadCount(), cachedBefore, "the second reader reuses all three selected texts");
  assert.equal(tuneRunReadCount(), summaryBefore + 5, "the second reader reuses every summary");
  assert.deepEqual(groups[0].rows.map((row) => row.item), ["run4", "run3", "run2"]);
  const stats = cache.stats();
  assert.equal(stats.answers.size, 5);
  assert.equal(stats.answers.hits, 3);
  assert.equal(stats.answers.misses, 5);
  assert.equal(stats.answers.evictions, 0);
  assert.equal(stats.summaries.size, 5);
  assert.equal(stats.summaries.hits, 5);
  assert.equal(stats.summaries.misses, 5);

  await appendFile(path.join(dir, `${records[4].id}.answers.jsonl`), `${JSON.stringify({ item: "appended", seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 })}\n`);
  await records[4].update({ outcome: "stopped" });
  const summaryMid = tuneRunReadCount();
  const refreshed = await cachedAnswers(dir, { profileId: "p", fingerprint: fp, historyCache: cache });
  assert.equal(cachedAnswersReadCount(), cachedBefore + 1, "a changed stamp rereads only that file");
  assert.equal(tuneRunReadCount(), summaryMid + 1, "a rewritten summary is reread once");
  assert.deepEqual(refreshed[0].rows.map((row) => row.item), ["run4", "appended", "run3", "run2"]);
  cache.clear();
  const cleared = cache.stats();
  assert.equal(cleared.answers.size, 0, "the tune releases cached answer text before generation");
  assert.equal(cleared.answers.bytes, 0);
  assert.equal(cleared.summaries.size, 0);
  assert.equal(cleared.summaries.bytes, 0);
});

test("retained parsed rows are reused, cloned and refreshed after an append", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-tune-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12 };
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp, now: new Date(1000 + i * 1000) });
    await rec.answers([
      { item: `run${i}-a`, seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 },
      { item: `run${i}-b`, seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 },
    ]);
    await rec.finish({ outcome: "complete" });
    records.push(rec);
  }
  const cache = createTuneHistoryCache();
  await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache: cache, retainRuns: 4, retainMinRows: 0 });
  const options = { profileId: "p", fingerprint: fp, historyCache: cache, restoreBudget: { limitRows: 100, maxBytes: 1024 ** 2, maxFiles: 4 } };
  const first = await cachedAnswers(dir, options);
  assert.deepEqual(first[0].rows.map((row) => row.item), ["run4-a", "run4-b", "run3-a", "run3-b", "run2-a", "run2-b", "run1-a", "run1-b"]);
  assert.deepEqual(cache.stats().rows, { size: 4, rows: 8, hits: 4, misses: 4, evictions: 0 });
  const smallRunCache = createTuneHistoryCache();
  await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache: smallRunCache, retainRuns: 4 });
  assert.equal(smallRunCache.stats().rows.size, 0, "tiny files stay on the streaming path by default");
  first[0].rows[0].item = "mutated";
  const second = await cachedAnswers(dir, options);
  assert.equal(second[0].rows[0].item, "run4-a", "cached rows cannot be mutated by a caller");
  assert.equal(cache.stats().rows.hits, 8);

  const readsBeforeAppend = cachedAnswersReadCount();
  await appendFile(path.join(dir, `${records[4].id}.answers.jsonl`), `${JSON.stringify({ item: "appended", seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 })}\n`);
  await records[4].update({ outcome: "stopped" });
  const refreshed = await cachedAnswers(dir, options);
  assert.equal(refreshed[0].rows[2].item, "appended");
  assert.equal(cachedAnswersReadCount(), readsBeforeAppend + 1, "only the changed file is reread and streamed");
});

test("the history cache enforces its answer byte and entry bounds", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-tune-cache-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12 };
  const records = [];
  for (let i = 0; i < 3; i += 1) {
    const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp, now: new Date(1000 + i * 1000) });
    await rec.answers([{ item: `run${i}`, seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1, text: "x".repeat(100) }]);
    await rec.finish({ outcome: "complete" });
    records.push(rec);
  }
  const cache = createTuneHistoryCache({ maxBytes: 250, maxEntries: 2 });
  await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache: cache });
  const stats = cache.stats().answers;
  assert.ok(stats.bytes <= 250, `cached ${stats.bytes} bytes`);
  assert.ok(stats.size <= 2, `cached ${stats.size} files`);

  const sequential = createTuneHistoryCache({ maxBytes: 10_000, maxEntries: 2 });
  for (let i = 0; i < records.length; i += 1) {
    await sequential.read(path.join(dir, `${records[i].id}.answers.jsonl`), i);
  }
  assert.equal(sequential.stats().answers.size, 2);
  assert.equal(sequential.stats().answers.evictions, 1, `the oldest entry is evicted at the bound: ${JSON.stringify(sequential.stats())}`);

  const parsed = createTuneHistoryCache({ maxParsedFiles: 2, maxParsedRows: 3 });
  await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache: parsed, retainRuns: 4, retainMinRows: 0 });
  const rowStats = parsed.stats().rows;
  assert.ok(rowStats.size <= 2, `cached ${rowStats.size} parsed files`);
  assert.ok(rowStats.rows <= 3, `cached ${rowStats.rows} parsed rows`);
});
