import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CACHED_ANSWERS_READ_MODE, ITEM_OUTCOMES_READ_MODE, cachedAnswers, itemOutcomes, startRun } from "../src/tune-runs.js";

test("itemOutcomes uses a single buffered read", () => {
  assert.equal(ITEM_OUTCOMES_READ_MODE, "buffered");
});

test("buffered item outcomes keep counts, saturation and row filtering", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-buffered-outcomes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "x", tunerVersion: 12 };
  const run = await startRun(dir, { profileId: "p", model: "m.gguf", request: {}, fingerprint: fp });

  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push({ item: "sat", passed: 1, total: 1, settings: { temperature: i < 3 ? 0.1 : 0.2 } });
  for (let i = 0; i < 6; i += 1) rows.push({ item: "mixed", passed: i < 3 ? 1 : 0, total: 1, settings: { temperature: i < 3 ? 0.1 : 0.2 } });
  rows.push({ item: "few", passed: 1, total: 1, settings: {} });
  rows.push({ item: "bad", passed: 1, total: 1, error: "boom", settings: {} });
  rows.push({ item: "zero", passed: 1, total: 0, settings: {} });
  const raw = `${rows.map((row) => JSON.stringify(row)).join("\r\n")}\r\nnot-json\r\n${JSON.stringify({ item: "cut" }).slice(0, 10)}`;
  await writeFile(path.join(dir, `${run.id}.answers.jsonl`), raw);

  const result = await itemOutcomes(dir, { profileId: "p", fingerprint: fp });
  assert.deepEqual([...result.saturated].sort(), ["sat"]);
  assert.deepEqual(result.counts.sat, { right: 6, wrong: 0, seen: 6, settings: 2 });
  assert.deepEqual(result.counts.mixed, { right: 3, wrong: 3, seen: 6, settings: 2 });
  assert.deepEqual(result.counts.few, { right: 1, wrong: 0, seen: 1, settings: 1 });
  assert.equal(result.counts.bad, undefined);
  assert.equal(result.counts.zero, undefined);
});

test("buffered cachedAnswers keep grouping, width filtering and the row cap", async (t) => {
  assert.equal(CACHED_ANSWERS_READ_MODE, "buffered");
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-buffered-cached-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fp = { suiteVersion: 18, taskHash: "h", tunerVersion: 12 };
  const rec = await startRun(dir, { profileId: "p", model: "m.gguf", request: {}, fingerprint: fp });
  const rows = [
    { item: "a", seed: 1, settings: { temperature: 0.1 }, passed: 1, total: 1, parallel: 1 },
    { item: "b", seed: 1, settings: { temperature: 0.1 }, passed: 1, total: 1, parallel: 1 },
    { item: "c", seed: 1, settings: { temperature: 0.1 }, passed: 1, total: 1, parallel: 1, error: "boom" },
    { item: "d", seed: 1, settings: { temperature: 0.1 }, passed: 1, total: 1, parallel: 2 },
  ];
  await rec.answers(rows);
  await rec.finish({ outcome: "complete" });

  const groups = await cachedAnswers(dir, { profileId: "p", fingerprint: fp, parallel: 1 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].seed, 1);
  assert.deepEqual(groups[0].settings, { temperature: 0.1 });
  assert.deepEqual(groups[0].rows.map((row) => row.item), ["a", "b"]);

  const capped = await cachedAnswers(dir, { profileId: "p", fingerprint: fp, parallel: 1, limitRows: 1 });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].rows.length, 1);
});
