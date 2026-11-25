import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Measurements, spreadCheapestRows, verifyRestore, verifyRestoreByFamily } from "../benchmarks/tune-measure.mjs";
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

test("a run with no answers does not take one of the newest-run slots", async (t) => {
  const dir = await savedRun(t, { ...WORLD, tunerVersion: 10 }, [{ settings: GPU, seed: 42, item: "old", passed: 1, total: 1, text: "a" }]);
  // The tune that is starting has already recorded its (still empty) run.
  const starting = await startRun(dir, { profileId: "p", model: "m.gguf", request: {}, fingerprint: { ...WORLD, tunerVersion: 11 }, now: new Date("2026-11-14T10:00:00Z") });
  assert.ok(starting);
  assert.deepEqual(items(await cachedAnswers(dir, { profileId: "p", fingerprint: { ...WORLD, tunerVersion: 11 }, limitRuns: 1 })), ["old"]);
});

test("saved groups that share a slot are merged, not first-wins, and fresh answers still win", async () => {
  // A v11 run at 8 threads asked only a few items; the v10 run at 12 threads holds the rest.
  // On full GPU offload both are one slot, so the second restore must add its items.
  let calls = 0;
  const evaluate = async (_settings, ids) => { calls += ids.length; return { prompts: ids.map((id) => ({ id, passed: 0, total: 1, text: "fresh" })) }; };
  const measurements = new Measurements(evaluate, 100);
  assert.equal(measurements.restore({ ...GPU, threads: 8 }, 42, [{ item: "refill", passed: 1, total: 1, text: "v11" }]), true);
  assert.equal(measurements.restore({ ...GPU, threads: 12 }, 42, [
    { item: "a", passed: 1, total: 1, text: "v10 a" },
    { item: "refill", passed: 0, total: 1, text: "older" },
  ]), true, "the second group adds the items the first lacks");
  const out = await measurements.measure({ ...GPU, threads: 8 }, ["a", "refill"], 42);
  assert.equal(calls, 0, "both items replay");
  assert.deepEqual(out.prompts.map((prompt) => prompt.text), ["v10 a", "v11"], "the first restore keeps the items it has");
  await measurements.measure({ ...GPU, threads: 8 }, ["b"], 42);
  assert.equal(measurements.restore(GPU, 42, [{ item: "b", passed: 1, total: 1, text: "saved b" }]), false, "a fresh answer is never replaced");
  assert.equal((await measurements.measure(GPU, ["b"], 42)).prompts[0].text, "fresh");
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
  let firstMismatchCalls = 0;
  const firstDiffers = async (_settings, ids) => {
    firstMismatchCalls += ids.length;
    return { prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: "changed" })) };
  };
  const rejected = await verifyRestore(groups, firstDiffers, { sample: 4 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.checked, 1, "one mismatch already rejects every saved answer");
  assert.equal(firstMismatchCalls, 1, "the remaining probes cannot change the decision");
  assert.deepEqual(await verifyRestore([], same), { ok: true, checked: 0, mismatched: [] });
});

test("family verification judges only raw-text mismatches", async () => {
  const groups = [{ settings: GPU, seed: 42, rows: [{ item: "code-1", passed: 1, total: 1, text: "saved", ms: 1 }] }];
  let rawCalls = 0;
  let judgeCalls = 0;
  const captured = [];
  const evaluate = async () => { throw new Error("the judged evaluator must not run"); };
  evaluate.raw = async (_settings, ids) => {
    rawCalls += 1;
    return { prompts: ids.map((id) => ({ id, text: "saved", ms: 1, digest: id })) };
  };
  evaluate.judge = async (id, row) => {
    judgeCalls += 1;
    return { ...row, passed: 1, total: 1 };
  };
  const same = await verifyRestoreByFamily(groups, evaluate, { familyOf: () => "code", onAnswer: (answer) => captured.push(answer) });
  assert.equal(rawCalls, 1);
  assert.equal(judgeCalls, 0, "identical text already has the saved verdict");
  assert.equal(same.ok, true);
  assert.deepEqual(same.stale, []);
  assert.deepEqual(captured, [], "matching raw rows are not needed for stale-family prefetch");

  evaluate.raw = async (_settings, ids) => {
    rawCalls += 1;
    return { prompts: ids.map((id) => ({ id, text: "changed", ms: 2, digest: id })) };
  };
  const changed = await verifyRestoreByFamily(groups, evaluate, { familyOf: () => "code", onAnswer: (answer) => captured.push(answer) });
  assert.equal(judgeCalls, 1, "a mismatch is fully judged for stale-family evidence");
  assert.deepEqual(changed.stale, ["code"]);
  assert.deepEqual(changed.groups, []);
  assert.equal(captured[0].row.text, "changed");
  assert.equal(captured[0].row.passed, 1);

  evaluate.raw = async (_settings, ids) => ({ prompts: ids.map((id) => ({ id, text: "saved", ms: 1, digest: id })) });
  const malformed = [{ settings: GPU, seed: 42, rows: [{ item: "code-1", passed: "1", total: 1, text: "saved", ms: 1 }] }];
  const strict = await verifyRestoreByFamily(malformed, evaluate, { familyOf: () => "code" });
  assert.equal(judgeCalls, 2, "a malformed saved verdict is judged rather than inferred");
  assert.deepEqual(strict.stale, ["code"]);
});

test("cheapest restore probe selection preserves stable sort ranks across sizes and ties", () => {
  const expected = (list, count) => {
    const cheap = [...list].sort((left, right) => (Number(left.row.ms) || Infinity) - (Number(right.row.ms) || Infinity)).slice(0, Math.max(1, Math.ceil(list.length / 2)));
    const amount = Math.min(count, cheap.length);
    return Array.from({ length: amount }, (_value, index) => cheap[Math.floor(((index + 0.5) * cheap.length) / amount)]);
  };
  for (const size of [0, 1, 2, 3, 10, 63, 64, 65, 1000, 20000]) {
    const list = Array.from({ length: size }, (_value, index) => ({
      row: { ms: index % 13 === 0 ? undefined : (index * 37) % 17 },
      index,
    }));
    const before = JSON.stringify(list);
    for (const count of size >= 20000 ? [3] : [0, 1, 2, 3, 8]) {
      assert.deepEqual(spreadCheapestRows(list, count), expected(list, count), `size=${size}, count=${count}`);
    }
    assert.equal(JSON.stringify(list), before, "selection does not mutate saved rows");
  }
});

test("the check by family keeps the families that re-ask identically and drops only the stale one (ADR-185)", async () => {
  const rows = (prefix, count) => Array.from({ length: count }, (_v, i) => ({ item: `${prefix}-${i}`, passed: 1, total: 1, text: `text ${prefix}-${i}`, ms: 100 + i }));
  const groups = [{ settings: GPU, seed: 42, rows: [...rows("code", 10), ...rows("recall", 10), ...rows("read", 10)] }];
  const familyOf = (id) => id.split("-")[0];
  const asked = [];
  const liveAnswers = [];
  // The recall family changed under the current engine; the others did not.
  const evaluate = async (_settings, ids) => {
    asked.push(...ids);
    return {
      prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: id.startsWith("recall") ? "different" : `text ${id}` })),
      memoryBytes: 123,
      gpuVram: 45,
    };
  };
  const check = await verifyRestoreByFamily(groups, evaluate, {
    familyOf,
    perFamily: 2,
    onAnswer: (answer) => liveAnswers.push(answer),
  });
  assert.equal(check.ok, true, "two of three families verified");
  assert.deepEqual(check.stale, ["recall"]);
  assert.equal(check.checked, 5, "two probes for each kept family and one for the rejected family");
  assert.deepEqual(asked.filter((id) => id.startsWith("recall")), ["recall-1"], "a family stops at its first mismatch");
  assert.deepEqual(liveAnswers.map((answer) => answer.row.id), asked, "every executed probe exposes its exact live row");
  assert.ok(liveAnswers.every((answer) => answer.seed === 42 && answer.memoryBytes === 123 && answer.gpuVram === 45));
  assert.ok(liveAnswers.every((answer) => Object.hasOwn(answer, "settings")), "the exact probe settings travel with the row");
  assert.deepEqual(items(check.groups).filter((id) => id.startsWith("recall")), [], "the stale family is not replayed");
  assert.equal(items(check.groups).length, 20, "the verified families keep every saved answer");
  assert.ok(asked.every((id) => Number(id.split("-")[1]) < 5), "the cheapest half of each family is what gets re-asked");
  // Every family stale: nothing is reused, as with the all-or-nothing check.
  let allDifferCalls = 0;
  const allDiffer = async (_s, ids) => {
    allDifferCalls += ids.length;
    return { prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: "x" })) };
  };
  const none = await verifyRestoreByFamily(groups, allDiffer, { familyOf, perFamily: 2 });
  assert.equal(none.ok, false);
  assert.equal(none.checked, 3, "one failed probe rejects each family");
  assert.equal(allDifferCalls, 3, "no rejected family asks another answer");
  assert.deepEqual(none.groups, []);
  // A changed verdict counts like a changed text, timed rows are never the evidence, and an empty store is fine.
  const flips = async (_s, ids) => ({ prompts: ids.map((id) => ({ id, passed: id.startsWith("read") ? 0 : 1, total: 1, text: `text ${id}` })) });
  assert.deepEqual((await verifyRestoreByFamily(groups, flips, { familyOf, perFamily: 2 })).stale, ["read"]);
  const timedOnly = [{ settings: { ...GPU, timed: true }, seed: 42, rows: rows("code", 3) }];
  assert.deepEqual(await verifyRestoreByFamily(timedOnly, evaluate, { familyOf }), { ok: true, checked: 0, mismatched: [], stale: [], groups: [] });
  assert.deepEqual((await verifyRestoreByFamily([], evaluate, { familyOf })).groups, []);
});
