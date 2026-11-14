import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { finishBaselineWork, prepareBaselineWork } from "../benchmarks/baseline-work.mjs";

async function root(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-baseline-work-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "gate-baseline-work");
}
const alive = () => true;
const dead = () => false;

test("a first baseline update starts in an empty work home with nothing saved", async (t) => {
  const dir = await root(t);
  const work = await prepareBaselineWork(dir, { pid: 7, isAlive: dead });
  assert.deepEqual(await readdir(work.home), []);
  assert.deepEqual(await readdir(work.savedRuns), []);
});

test("runs left by a killed update are moved aside for replay, and the next tune home starts clean", async (t) => {
  const dir = await root(t);
  const first = await prepareBaselineWork(dir, { pid: 7, isAlive: dead });
  await mkdir(path.join(first.home, "tune-runs"), { recursive: true });
  await mkdir(path.join(first.home, "profiles"), { recursive: true });
  await writeFile(path.join(first.home, "tune-runs", "run-a.json"), "{}");
  await writeFile(path.join(first.home, "tune-runs", "run-a.answers.jsonl"), "");
  await writeFile(path.join(first.home, "profiles", "m.json"), "{}");
  // The process was killed: finishBaselineWork never ran.
  const second = await prepareBaselineWork(dir, { pid: 8, isAlive: dead });
  assert.deepEqual((await readdir(second.savedRuns)).sort(), ["run-a.answers.jsonl", "run-a.json"]);
  assert.deepEqual(await readdir(second.home), [], "no profile or run of the killed attempt is left in the tune home");
  await mkdir(path.join(second.home, "tune-runs"), { recursive: true });
  await writeFile(path.join(second.home, "tune-runs", "run-b.json"), "{}");
  const third = await prepareBaselineWork(dir, { pid: 9, isAlive: dead });
  assert.deepEqual((await readdir(third.savedRuns)).sort(), ["run-a.answers.jsonl", "run-a.json", "run-b.json"], "saved runs accumulate");
});

test("another live baseline update owns the work folder", async (t) => {
  const dir = await root(t);
  await prepareBaselineWork(dir, { pid: 7, isAlive: dead });
  await assert.rejects(prepareBaselineWork(dir, { pid: 8, isAlive: alive }), (error) => error.code === "baseline_update_running");
  const taken = await prepareBaselineWork(dir, { pid: 8, isAlive: dead });
  assert.ok(taken.home, "a dead owner's folder is taken over");
});

test("a finished update removes the work folder", async (t) => {
  const dir = await root(t);
  const work = await prepareBaselineWork(dir, { pid: 7, isAlive: dead });
  await finishBaselineWork(work);
  await assert.rejects(readdir(dir), (error) => error.code === "ENOENT");
});
