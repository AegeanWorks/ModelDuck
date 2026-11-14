import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Measurements, verifyRestore } from "../benchmarks/tune-measure.mjs";
import { cachedAnswers, startRun } from "../src/tune-runs.js";

const WORLD = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "3.22.2", modelFile: "m.gguf", modelSize: 100, cpu: "CPU", platform: "win32", arch: "x64" };
const GPU = { temperature: 0, gpuBackend: "vulkan", gpuLayers: "max", threads: 12 };

async function savedRun(t, fingerprint, rows) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-reuse-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = await startRun(dir, { profileId: "p", model: "m.gguf", request: {}, fingerprint, now: new Date("2026-11-13T10:00:00Z") });
  await run.answers(rows);
  await run.finish({ outcome: "done", now: new Date("2026-11-13T10:01:00Z") });
  return dir;
}
const items = (groups) => groups.flatMap((group) => group.rows.map((row) => row.item)).sort();

test("answers from another tuner version are reused, except timed ones", async (t) => {
  const dir = await savedRun(t, { ...WORLD, tunerVersion: 10 }, [
    { settings: GPU, seed: 42, item: "untimed", passed: 1, total: 1, text: "a" },
    { settings: { ...GPU, timed: true }, seed: 42, item: "timed", passed: 1, total: 1, text: "b" },
  ]);
  assert.deepEqual(items(await cachedAnswers(dir, { profileId: "p", fingerprint: { ...WORLD, tunerVersion: 11 } })), ["untimed"],
    "a decision-rule change keeps answers; timings from another tuner version are not replayed");
  assert.deepEqual(items(await cachedAnswers(dir, { profileId: "p", fingerprint: { ...WORLD, tunerVersion: 10 } })), ["timed", "untimed"],
    "the same tuner version reuses timed rows as before");
});

test("answers from another model file, size or CPU are never reused", async (t) => {
  const dir = await savedRun(t, { ...WORLD, tunerVersion: 10 }, [{ settings: GPU, seed: 42, item: "x", passed: 1, total: 1, text: "a" }]);
  for (const change of [{ modelSize: 101 }, { modelFile: "other.gguf" }, { cpu: "Other CPU" }, { suiteVersion: 19 }]) {
    assert.deepEqual(await cachedAnswers(dir, { profileId: "p", fingerprint: { ...WORLD, tunerVersion: 10, ...change } }), [], JSON.stringify(change));
  }
});

test("saved answers are read from several run folders", async (t) => {
  const first = await savedRun(t, { ...WORLD, tunerVersion: 10 }, [{ settings: GPU, seed: 42, item: "a", passed: 1, total: 1, text: "a" }]);
  const second = await savedRun(t, { ...WORLD, tunerVersion: 10 }, [{ settings: GPU, seed: 42, item: "b", passed: 1, total: 1, text: "b" }]);
  assert.deepEqual(items(await cachedAnswers([first, second], { profileId: "p", fingerprint: { ...WORLD, tunerVersion: 10 } })), ["a", "b"]);
});

test("on full GPU offload an untimed answer is reused whatever the thread count; timed or CPU answers are not", async () => {
  let calls = 0;
  const evaluate = async (_settings, ids) => { calls += ids.length; return { prompts: ids.map((id) => ({ id, passed: 0, total: 1, text: "fresh" })) }; };
  const measurements = new Measurements(evaluate, 100);
  measurements.restore(GPU, 42, [{ item: "x", passed: 1, total: 1, text: "stored" }]);
  const reused = await measurements.measure({ ...GPU, threads: 8 }, ["x"], 42);
  assert.equal(reused.prompts[0].text, "stored");
  assert.equal(calls, 0);
  await measurements.measure({ ...GPU, threads: 8, timed: true }, ["x"], 42);
  assert.equal(calls, 1, "a timed call measures: threads is what it times");
  const cpu = new Measurements(evaluate, 100);
  cpu.restore({ ...GPU, gpuBackend: "cpu", gpuLayers: 0 }, 42, [{ item: "x", passed: 1, total: 1, text: "stored" }]);
  await cpu.measure({ ...GPU, gpuBackend: "cpu", gpuLayers: 0, threads: 8 }, ["x"], 42);
  assert.equal(calls, 2, "on the CPU the thread count can change the text");
});

test("a spot-check re-asks a few stored answers live and refuses reuse on any difference", async () => {
  const groups = [
    { settings: GPU, seed: 42, rows: ["a", "b", "c", "d"].map((item) => ({ item, passed: 1, total: 1, text: `text ${item}` })) },
    { settings: { ...GPU, timed: true }, seed: 42, rows: [{ item: "t", passed: 1, total: 1, text: "timed" }] },
  ];
  const seen = [];
  const same = async (settings, ids) => { seen.push({ settings, ids }); return { prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: `text ${id}` })) }; };
  const ok = await verifyRestore(groups, same, { sample: 4 });
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 4);
  assert.ok(seen.every((call) => call.settings.timed !== true), "timed rows are never the evidence");
  assert.ok(seen.some((call) => call.settings.threads !== GPU.threads), "part of the check runs at another thread count");
  const differs = async (_settings, ids) => ({ prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: id === "c" ? "changed" : `text ${id}` })) });
  const bad = await verifyRestore(groups, differs, { sample: 4 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatched, ["c"]);
  assert.deepEqual(await verifyRestore([], same), { ok: true, checked: 0, mismatched: [] });
});
