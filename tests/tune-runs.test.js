import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { answerPaceByProfile, answersFile, itemOutcomes, listRuns, loadRun, startRun, summarizeAnswers } from "../src/tune-runs.js";

async function runsDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const REQUEST = { stages: ["prompt"], tasks: ["code"], only: null, force: false };

test("a tune run keeps its summary and every answer, and ends with its outcome", async (t) => {
  const dir = await runsDir(t);
  const run = await startRun(dir, { profileId: "qwen2.5-coder-1.5b-instruct-q4", model: "coder.gguf", request: REQUEST, fingerprint: { suiteVersion: 11 }, expectedAnswers: 480, now: new Date("2026-10-31T17:00:00Z") });
  await run.answers([
    { settings: { systemPrompt: "A" }, seed: 42, item: "code-1", passed: 1, total: 1, ms: 120, outputTokens: 30 },
    { settings: { systemPrompt: "A" }, seed: 42, item: "code-2", passed: 0, total: 1, ms: 140, outputTokens: 33 },
  ]);
  await run.update({ answers: 2, sweeps: [{ axis: "systemPrompt" }] });
  await run.finish({ outcome: "done", now: new Date("2026-10-31T17:10:00Z") });

  const saved = await loadRun(dir, run.id);
  assert.equal(saved.outcome, "done");
  assert.equal(saved.durationMs, 10 * 60_000);
  assert.deepEqual(saved.request, REQUEST);
  assert.equal(saved.expectedAnswers, 480);
  assert.deepEqual(saved.sweeps, [{ axis: "systemPrompt" }]);
  const lines = (await readFile(answersFile(dir, run.id), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.item, line.passed]), [["code-1", 1], ["code-2", 0]]);
});

test("measured pace comes from recent run summaries with a low/high range", async (t) => {
  const dir = await runsDir(t);
  const slow = await startRun(dir, { profileId: "a", model: "a.gguf", request: REQUEST, now: new Date("2026-10-31T10:00:00Z"), pid: 111 });
  await slow.update({ answers: 100 });
  await slow.finish({ outcome: "done", now: new Date("2026-10-31T10:10:00Z") });
  const fast = await startRun(dir, { profileId: "a", model: "a.gguf", request: REQUEST, now: new Date("2026-10-31T11:00:00Z"), pid: 222 });
  await fast.update({ answers: 200 });
  await fast.finish({ outcome: "done", now: new Date("2026-10-31T11:05:00Z") });
  const paces = await answerPaceByProfile(dir);
  assert.deepEqual(paces.get("a"), { secondsPerAnswer: 1.5, low: 1.5, high: 6, samples: 2 });
});

test("runs are listed newest first, and one whose process died while running shows as interrupted", async (t) => {
  const dir = await runsDir(t);
  const older = await startRun(dir, { profileId: "a", model: "a.gguf", request: REQUEST, now: new Date("2026-10-30T10:00:00Z"), pid: 111 });
  await older.finish({ outcome: "stopped", error: "could not load", now: new Date("2026-10-30T10:01:00Z") });
  await startRun(dir, { profileId: "b", model: "b.gguf", request: REQUEST, now: new Date("2026-10-31T10:00:00Z"), pid: 222 });
  const runs = await listRuns(dir, { isAlive: (pid) => pid !== 222 });
  assert.deepEqual(runs.map((run) => [run.profileId, run.outcome]), [["b", "interrupted"], ["a", "stopped"]]);
  assert.equal(runs[1].error, "could not load");
  assert.equal(runs[0].sweeps, undefined, "the listing leaves out the details");
});

test("a run id that could leave the folder is refused", async (t) => {
  const dir = await runsDir(t);
  await assert.rejects(loadRun(dir, "../profiles/x"), (error) => error.code === "tune_run_bad_id");
  assert.throws(() => answersFile(dir, "..\\secret"), (error) => error.code === "tune_run_bad_id");
  assert.equal(await loadRun(dir, "2026-01-01T00-00-00-000Z-1"), null, "an unknown run is simply missing");
});

test("a run's answers are summarised: how many, how many right, errors, typical and slow times, tokens", async (t) => {
  const dir = await runsDir(t);
  const run = await startRun(dir, { profileId: "a", model: "a.gguf", request: REQUEST });
  const ms = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  await run.answers(ms.map((time, index) => ({ settings: {}, seed: 42, item: `i-${index}`, passed: index < 7 ? 1 : 0, total: 1, ms: time, outputTokens: 20 + index, error: index === 9 ? "load failed" : null })));
  await run.finish({ outcome: "done" });
  const summary = await summarizeAnswers(dir, run.id);
  assert.equal(summary.answers, 10);
  assert.equal(summary.right, 70, "7 of 10 checks passed");
  assert.equal(summary.errors, 1);
  assert.equal(summary.ms.median, 500);
  assert.equal(summary.ms.p90, 900);
  assert.equal(summary.outputTokens.mean, 24.5);
  assert.deepEqual(await summarizeAnswers(dir, "2026-01-01T00-00-00-000Z-1"), { answers: 0, right: null, errors: 0, wrong: 0, unreadable: 0, unreadableExamples: [], ms: null, outputTokens: null }, "a run without answers summarises to nothing");
});

test("an unfinished run shows its answers and time so far, and the same outcome in the list and in full", async (t) => {
  const dir = await runsDir(t);
  let clock = Date.parse("2026-10-31T10:00:00Z");
  const run = await startRun(dir, { profileId: "a", model: "a.gguf", request: REQUEST, now: new Date(clock), pid: 333, clock: () => clock });
  clock += 20_000;
  await run.answers([{ item: "i-1", passed: 1, total: 1 }, { item: "i-2", passed: 0, total: 1 }]);
  const dead = { isAlive: () => false };
  const [listed] = await listRuns(dir, dead);
  const full = await loadRun(dir, run.id, dead);
  assert.equal(listed.answers, 2, "the count is saved while answers arrive");
  assert.equal(listed.durationMs, 20_000, "time so far for a run that never finished");
  assert.equal(listed.outcome, "interrupted");
  assert.equal(full.outcome, "interrupted", "the full record agrees with the list");
});

test("the answer summary counts wrong answers apart from replies that could not be read", async (t) => {
  const dir = await runsDir(t);
  const run = await startRun(dir, { profileId: "a", model: "a.gguf", request: REQUEST });
  await run.answers([
    { item: "i-1", passed: 1, total: 1, text: "B" },
    { item: "i-2", passed: 0, total: 1, unreadable: false, text: "Answer: A" },
    { item: "i-3", passed: 0, total: 1, unreadable: true, text: "I am not sure." },
    { item: "i-4", passed: 0, total: 1, error: "timed out" },
  ]);
  await run.finish({ outcome: "done" });
  const summary = await summarizeAnswers(dir, run.id);
  assert.equal(summary.wrong, 1);
  assert.equal(summary.unreadable, 1);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.unreadableExamples, [{ item: "i-3", text: "I am not sure." }], "a few unreadable replies are kept to look at");
});

test("per-item outcomes say which items no recorded setting has flipped", async (t) => {
  const dir = await runsDir(t);
  const cool = { temperature: 0 };
  const warm = { temperature: 0.7 };
  const first = await startRun(dir, { profileId: "m", model: "m.gguf", request: REQUEST, now: new Date("2026-01-01T00:00:00Z"), pid: 11 });
  await first.answers([
    { item: "i-1", passed: 1, total: 1, settings: cool },
    { item: "i-1", passed: 1, total: 1, settings: cool },
    { item: "i-1", passed: 1, total: 1, settings: warm },
    { item: "i-2", passed: 0, total: 1, settings: cool },
    { item: "i-3", passed: 0, total: 1, error: "timed out", settings: cool },
    { item: "i-4", passed: 1, total: 1, settings: cool },
  ]);
  await first.finish({ outcome: "done" });
  const second = await startRun(dir, { profileId: "m", model: "m.gguf", request: REQUEST, now: new Date("2026-01-01T00:01:00Z"), pid: 12 });
  await second.answers([
    { item: "i-1", passed: 1, total: 1, settings: warm },
    { item: "i-1", passed: 1, total: 1, settings: warm },
    { item: "i-1", passed: 1, total: 1, settings: warm },
    { item: "i-2", passed: 1, total: 1, settings: warm },
    { item: "i-4", passed: 1, total: 1, settings: warm },
    { item: "i-5", passed: 0, total: 1, settings: warm },
  ]);
  await second.finish({ outcome: "done" });
  const other = await startRun(dir, { profileId: "other", model: "o.gguf", request: REQUEST, now: new Date("2026-01-01T00:02:00Z"), pid: 13 });
  await other.answers([{ item: "i-1", passed: 0, total: 1, settings: cool }, { item: "i-5", passed: 1, total: 1, settings: cool }]);
  await other.finish({ outcome: "done" });

  const { saturated, counts } = await itemOutcomes(dir, { profileId: "m" });
  assert.ok(saturated.has("i-1"), "always right across two settings and six looks");
  assert.equal(saturated.has("i-4"), false, "two looks on one setting are not enough (S6)");
  assert.equal(saturated.has("i-2"), false, "one right and one wrong is discriminating");
  assert.equal(saturated.has("i-3"), false, "an error is not an outcome");
  assert.equal(saturated.has("i-5"), false, "one look is not enough to call it saturated");
  assert.equal(counts["i-1"].right, 6);
  assert.equal(counts["i-1"].wrong, 0, "the other model's answers are ignored");
  assert.equal(counts["i-1"].settings, 2);
  assert.equal(await itemOutcomes(dir, { profileId: "m", minObservations: 7 }).then((out) => out.saturated.has("i-1")), false, "six looks are under a minimum of seven");
});
