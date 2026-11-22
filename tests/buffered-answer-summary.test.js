import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ANSWER_SUMMARY_READ_MODE, startRun, summarizeAnswers } from "../src/tune-runs.js";

async function withAnswers(lines, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-buffered-summary-"));
  try {
    const run = await startRun(dir, { profileId: "p", model: "m.gguf", request: {} });
    // startRun awaits its first save; append the raw lines directly so the
    // summary sees exactly what a finished answers.jsonl contains.
    await writeFile(path.join(dir, `${run.id}.answers.jsonl`), lines);
    return await fn(dir, run.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the answer summary uses a single buffered read", () => {
  assert.equal(ANSWER_SUMMARY_READ_MODE, "buffered");
});

test("buffered reading keeps CRLF, truncated lines and unreadable examples", async () => {
  const rows = [
    { item: "a", passed: 1, total: 1, ms: 10, outputTokens: 5 },
    { item: "b", passed: 0, total: 1, ms: 20, outputTokens: 7, unreadable: true, text: "no function here" },
    { item: "c", passed: 0, total: 1, ms: 30, outputTokens: 9, error: "boom" },
    { item: "d", passed: 0, total: 1, ms: 40, outputTokens: 1 },
  ];
  // CRLF separators, a malformed middle line and a cut-off final line.
  const raw = `${JSON.stringify(rows[0])}\r\nnot-json\r\n${JSON.stringify(rows[1])}\r\n${JSON.stringify(rows[2])}\r\n${JSON.stringify(rows[3])}\r\n${JSON.stringify({ item: "cut" }).slice(0, 12)}`;
  await withAnswers(raw, async (dir, id) => {
    const summary = await summarizeAnswers(dir, id);
    assert.equal(summary.answers, 4);
    assert.equal(summary.right, 25);
    assert.equal(summary.errors, 1);
    assert.equal(summary.wrong, 1);
    assert.equal(summary.unreadable, 1);
    assert.deepEqual(summary.unreadableExamples, [{ item: "b", text: "no function here" }]);
    assert.deepEqual(summary.ms, { median: 20, p90: 40 });
    assert.deepEqual(summary.outputTokens, { mean: 5.5 });
  });
});

test("an empty or missing answers file still summarises to nothing", async () => {
  await withAnswers("", async (dir, id) => {
    assert.deepEqual(await summarizeAnswers(dir, id), { answers: 0, right: null, errors: 0, wrong: 0, unreadable: 0, unreadableExamples: [], ms: null, outputTokens: null });
    assert.deepEqual(await summarizeAnswers(dir, "missing-run"), { answers: 0, right: null, errors: 0, wrong: 0, unreadable: 0, unreadableExamples: [], ms: null, outputTokens: null });
  });
});
