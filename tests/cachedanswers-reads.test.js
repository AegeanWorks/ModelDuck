import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { answersFile, cachedAnswers, cachedAnswersBytesReadCount, cachedAnswersReadCount, createTuneHistoryCache, itemOutcomes, startRun } from "../src/tune-runs.js";

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

const BUDGET_FP = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12, modelFile: "m", modelSize: 1, cpu: "c", platform: "p", arch: "a" };
const budgetItems = (groups) => groups.flatMap((group) => group.rows.map((row) => row.item));

test("restore budget includes the crossing run and keeps newest-first precedence", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-restore-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let r = 0; r < 5; r += 1) {
    const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: BUDGET_FP, now: new Date(1000 + r * 1000) });
    const count = r === 1 ? 2 : 1;
    await rec.answers(Array.from({ length: count }, (_, i) => ({ item: `run${r}-${i}`, seed: 42, settings: { temperature: 0.1 }, passed: 1, total: 1 })));
    await rec.finish({ outcome: "complete" });
  }
  const readsBefore = cachedAnswersReadCount();
  const bytesBefore = cachedAnswersBytesReadCount();
  const groups = await cachedAnswers(dir, {
    profileId: "p",
    fingerprint: BUDGET_FP,
    restoreBudget: { limitRows: 4, maxBytes: 1024 ** 2, maxFiles: 4 },
  });
  assert.equal(cachedAnswersReadCount(), readsBefore + 4, "the fourth file crosses the row target and is included");
  assert.ok(cachedAnswersBytesReadCount() - bytesBefore <= 1024 ** 2, "the byte cap includes every selected file");
  assert.deepEqual(budgetItems(groups), ["run4-0", "run3-0", "run2-0", "run1-0"]);
});

test("restore budget enforces file, byte and row caps", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-restore-caps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [];
  for (let r = 0; r < 3; r += 1) {
    const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: BUDGET_FP, now: new Date(1000 + r * 1000) });
    await rec.answers([{ item: `run${r}`, seed: 42, settings: {}, passed: 1, total: 1, text: "x".repeat(1000) }]);
    await rec.finish({ outcome: "complete" });
    records.push(rec);
  }
  const newestFile = answersFile(dir, records[2].id);
  const newestBytes = (await stat(newestFile)).size;
  const options = { profileId: "p", fingerprint: BUDGET_FP, restoreBudget: { limitRows: 100, maxBytes: 1024 ** 2, maxFiles: 2 } };
  let before = cachedAnswersReadCount();
  let groups = await cachedAnswers(dir, options);
  assert.equal(cachedAnswersReadCount(), before + 2, "maxFiles is hard");
  assert.equal(budgetItems(groups).length, 2);

  before = cachedAnswersReadCount();
  groups = await cachedAnswers(dir, { ...options, restoreBudget: { ...options.restoreBudget, maxBytes: newestBytes } });
  assert.equal(cachedAnswersReadCount(), before + 1, "a crossing file is refused by the byte cap");
  assert.deepEqual(budgetItems(groups), ["run2"]);

  before = cachedAnswersReadCount();
  groups = await cachedAnswers(dir, { ...options, restoreBudget: { ...options.restoreBudget, maxBytes: 1 } });
  assert.equal(cachedAnswersReadCount(), before, "no file is read when none fits");
  assert.deepEqual(groups, []);

  before = cachedAnswersReadCount();
  groups = await cachedAnswers(dir, { ...options, restoreBudget: { ...options.restoreBudget, limitRows: 1 } });
  assert.equal(cachedAnswersReadCount(), before + 1, "the first crossing file is enough for one row");
  assert.deepEqual(budgetItems(groups), ["run2"]);

  before = cachedAnswersReadCount();
  groups = await cachedAnswers(dir, { ...options, restoreBudget: { ...options.restoreBudget, limitRows: 0 } });
  assert.equal(cachedAnswersReadCount(), before, "a zero row cap reads no files");
  assert.deepEqual(groups, []);
});

test("uncached restore keeps the early row-cap parse break", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-restore-parse-cap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: BUDGET_FP });
  await rec.answers(Array.from({ length: 100 }, (_, i) => ({ item: `row-${i}`, seed: 42, settings: {}, passed: 1, total: 1 })));
  await rec.finish({ outcome: "complete" });
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => { parses += 1; return realParse(...args); };
  try {
    const groups = await cachedAnswers(dir, { profileId: "p", fingerprint: BUDGET_FP, limitRows: 3, historyCache: createTuneHistoryCache() });
    assert.equal(groups[0].rows.length, 3);
    assert.equal(parses, 5, "one summary plus three accepted rows and one look-ahead row are parsed");
  } finally {
    JSON.parse = realParse;
  }
});

test("restore budget preserves fingerprint, tuner-version and width filtering", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-restore-filter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = { temperature: 0 };
  const older = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: { ...BUDGET_FP, tunerVersion: 11 }, now: new Date(1000) });
  await older.answers([
    { item: "serial", settings, seed: 42, passed: 1, total: 1 },
    { item: "wide", settings, seed: 42, passed: 1, total: 1, parallel: 3 },
    { item: "old-timed", settings: { ...settings, timed: true }, seed: 42, passed: 1, total: 1 },
  ]);
  await older.finish({ outcome: "complete" });
  const wrong = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: { ...BUDGET_FP, modelSize: 2 }, now: new Date(2000) });
  await wrong.answers([{ item: "wrong-model", settings, seed: 42, passed: 1, total: 1 }]);
  await wrong.finish({ outcome: "complete" });
  const historyCache = createTuneHistoryCache();
  await itemOutcomes(dir, { profileId: "p", fingerprint: { ...BUDGET_FP, tunerVersion: 11 }, historyCache, retainRuns: 4, retainMinRows: 0 });
  const options = { profileId: "p", fingerprint: BUDGET_FP, historyCache, restoreBudget: { limitRows: 100, maxBytes: 1024 ** 2, maxFiles: 4 } };
  assert.deepEqual(budgetItems(await cachedAnswers(dir, { ...options, parallel: 1 })), ["serial"]);
  assert.deepEqual(budgetItems(await cachedAnswers(dir, { ...options, parallel: 3 })), ["wide"]);
  assert.deepEqual(await cachedAnswers(dir, { ...options, fingerprint: { ...BUDGET_FP, modelSize: 3 } }), []);
});

test("cachedAnswers reuses settings keys for parsed rows", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-careads-keys-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12, modelFile: "m", modelSize: 1, cpu: "c", platform: "p", arch: "a" };
  const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp });
  await rec.answers(Array.from({ length: 5 }, (_, index) => ({
    item: `item-${index}`, seed: 42, settings: { threads: index }, passed: 1, total: 1,
  })));
  await rec.finish({ outcome: "complete" });
  const historyCache = createTuneHistoryCache();
  await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache, retainRuns: 4, retainMinRows: 0 });
  const options = { profileId: "p", fingerprint: fp, historyCache };
  const first = await cachedAnswers(dir, options);
  const afterFirst = historyCache.stats().settingsKeys;
  assert.equal(afterFirst.computes, 5, "each distinct settings object is serialized once");
  const second = await cachedAnswers(dir, options);
  assert.deepEqual(second, first, "grouping output is unchanged");
  const afterSecond = historyCache.stats().settingsKeys;
  assert.equal(afterSecond.computes, afterFirst.computes, "reused rows do not re-serialize settings");
  assert.ok(afterSecond.hits >= 5, "reused settings keys record cache hits");
});

test("cachedAnswers settings key cache is bounded", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-careads-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12, modelFile: "m", modelSize: 1, cpu: "c", platform: "p", arch: "a" };
  const rec = await startRun(dir, { profileId: "p", model: "m", request: {}, fingerprint: fp });
  await rec.answers(Array.from({ length: 5 }, (_, index) => ({
    item: `item-${index}`, seed: 42, settings: { threads: index }, passed: 1, total: 1,
  })));
  await rec.finish({ outcome: "complete" });
  const historyCache = createTuneHistoryCache({ maxSettingsKeys: 2 });
  await itemOutcomes(dir, { profileId: "p", fingerprint: fp, historyCache, retainRuns: 4, retainMinRows: 0 });
  await cachedAnswers(dir, { profileId: "p", fingerprint: fp, historyCache });
  const stats = historyCache.stats().settingsKeys;
  assert.ok(stats.size <= 2, "the settings key cache stays within its bound");
  assert.ok(stats.evictions >= 3, "older keys are evicted");
});
