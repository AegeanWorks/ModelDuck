import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PROMPTS } from "../benchmarks/suite.mjs";
import { createEvaluator } from "../benchmarks/tune-evaluate.mjs";
import { MAX_PARALLEL, PROBE_ITEMS, chooseParallel, itemNeed, parseParallel, probeItemIds, probeParallel, slotWidth } from "../benchmarks/tune-parallel.mjs";
import { answerRow } from "../benchmarks/tune-job.mjs";
import { cachedAnswers, startRun } from "../src/tune-runs.js";

// --- how wide may one call be -------------------------------------------------

test("a slot gets its share of the 16K context floor, so width is bounded by the largest item", () => {
  assert.equal(slotWidth({ parallel: 3, contextSize: 4096, need: 1500 }), 3, "16384 / 3 = 5461 holds 1500");
  assert.equal(slotWidth({ parallel: 3, contextSize: 4096, need: 6000 }), 2, "16384 / 2 = 8192 holds 6000");
  assert.equal(slotWidth({ parallel: 3, contextSize: 4096, need: 16000 }), 1, "only the whole context holds it");
  assert.equal(slotWidth({ parallel: 3, contextSize: 32768, need: 10000 }), 3, "a larger context raises the width");
});

test("width never exceeds what was asked and falls back to 1 on bad input", () => {
  assert.equal(slotWidth({ parallel: 1, contextSize: 16384, need: 10 }), 1);
  assert.equal(slotWidth({ parallel: 0, contextSize: 16384, need: 10 }), 1);
  assert.equal(slotWidth({ parallel: "x", contextSize: "y", need: "z" }), 1);
  assert.equal(slotWidth({ parallel: 99, contextSize: 16384, need: 10 }), MAX_PARALLEL);
});

test("an item's need counts its prompt, the system prompt and the answer budget", () => {
  assert.equal(itemNeed({ prompt: "x".repeat(3000), maxTokens: 100 }, { systemPrompt: "y".repeat(300), maxTokens: null }), 1200);
  assert.equal(itemNeed({ prompt: "x".repeat(300) }, { systemPrompt: "", maxTokens: 50 }), 150, "the setting's answer budget wins over the item's");
});

// --- how wide the tune asks for ----------------------------------------------

test("auto and numeric requests are capped by the cores and the hard maximum", () => {
  assert.deepEqual(chooseParallel({ requested: 4, logicalCores: 16 }), { n: 4, reason: null });
  assert.equal(chooseParallel({ requested: 4, logicalCores: 4 }).n, 2, "each answer keeps at least two cores");
  assert.equal(chooseParallel({ requested: "auto", logicalCores: 8 }).n, 4);
  assert.equal(chooseParallel({ requested: "auto", logicalCores: 64 }).n, MAX_PARALLEL);
  const single = chooseParallel({ requested: 3, logicalCores: 1 });
  assert.equal(single.n, 1);
  assert.match(single.reason, /core/);
  assert.equal(chooseParallel({ requested: 1, logicalCores: 16 }).n, 1);
});

test("the flag accepts auto or a whole number from 1 to the maximum and refuses the rest", () => {
  assert.equal(parseParallel("auto"), "auto");
  assert.equal(parseParallel("3"), 3);
  assert.equal(parseParallel(undefined), 1);
  for (const bad of ["0", "-1", "2.5", "many", String(MAX_PARALLEL + 1)]) {
    assert.throws(() => parseParallel(bad), (error) => error.code === "tune_parallel_invalid", `refuses ${bad}`);
  }
});

// --- the determinism probe ---------------------------------------------------

/**
 * An evaluator double whose digests and wall time depend on the width, so a
 * test can make parallel disagree or run slower. `msFor(width)` is how long one
 * call takes on the fake clock; a (re)load costs `loadMs` and must not count.
 */
function probeEvaluator({ digestFor = (id) => `d-${id}`, fail = null, msFor = (width) => (width > 1 ? 600 : 1000), loadMs = 5000 } = {}) {
  let now = 0;
  const clock = () => now;
  const calls = [];
  const loads = [];
  const evaluate = async (settings, ids, seed) => {
    calls.push({ width: evaluate.parallel, ids: [...ids], seed, temperature: settings.temperature });
    if (fail && evaluate.parallel > 1) throw new Error(fail);
    now += msFor(evaluate.parallel, settings);
    return { prompts: ids.map((id) => ({ id, passed: 1, total: 1, error: null, digest: digestFor(id, evaluate.parallel, settings) })) };
  };
  evaluate.parallel = 1;
  evaluate.setParallel = (n) => { evaluate.parallel = n; };
  evaluate.ensureLoaded = async () => { loads.push(evaluate.parallel); now += loadMs; };
  evaluate.calls = calls;
  evaluate.loads = loads;
  evaluate.clock = clock;
  return evaluate;
}

const PROBE = { items: ["a", "b", "c", "d"], settings: { temperature: 0 }, seed: 42 };

test("identical and faster answers keep the width; load time counts on neither side", async () => {
  const evaluate = probeEvaluator();
  const out = await probeParallel({ evaluate, width: 3, ...PROBE, clock: evaluate.clock });
  assert.equal(out.ok, true);
  assert.equal(out.matched, 4);
  assert.equal(out.total, 4);
  assert.deepEqual({ serialMs: out.serialMs, wideMs: out.wideMs }, { serialMs: 1000, wideMs: 600 }, "the 5 s loads are not timed");
  assert.equal(out.speedup, 1.67);
  assert.deepEqual(evaluate.loads, [3, 1], "each side is loaded at its own width before it is timed");
  assert.deepEqual(evaluate.calls.map((call) => call.width), [3, 1]);
  assert.equal(evaluate.parallel, 3, "the evaluator is left at the proven width");
});

test("identical but not clearly faster answers refuse parallel and say how fast each was", async () => {
  // Measured on a contended 10-core CPU with a 0.5B model: two at a time was no faster than one.
  const evaluate = probeEvaluator({ msFor: (width) => (width > 1 ? 16708 : 15567) });
  const out = await probeParallel({ evaluate, width: 2, ...PROBE, clock: evaluate.clock });
  assert.equal(out.ok, false);
  assert.equal(out.matched, 4, "the answers did match");
  assert.match(out.reason, /not faster/);
  assert.match(out.reason, /16\.7 s/);
  assert.match(out.reason, /15\.6 s/);
  assert.equal(evaluate.parallel, 1);
});

test("a gain below the minimum is refused, one above it is kept", async () => {
  const slight = probeEvaluator({ msFor: (width) => (width > 1 ? 900 : 1000) });
  assert.equal((await probeParallel({ evaluate: slight, width: 2, ...PROBE, clock: slight.clock })).ok, false, "10% is within noise");
  const clear = probeEvaluator({ msFor: (width) => (width > 1 ? 800 : 1000) });
  assert.equal((await probeParallel({ evaluate: clear, width: 2, ...PROBE, clock: clear.clock })).ok, true, "20% is kept");
});

test("one different digest refuses parallel, names the item and leaves the evaluator serial", async () => {
  const evaluate = probeEvaluator({ digestFor: (id, width) => (id === "c" && width > 1 ? "other" : `d-${id}`) });
  const out = await probeParallel({ evaluate, width: 3, ...PROBE, clock: evaluate.clock });
  assert.equal(out.ok, false);
  assert.equal(out.matched, 3);
  assert.deepEqual(out.mismatches, ["c"]);
  assert.match(out.reason, /c/);
  assert.equal(evaluate.parallel, 1);
});

test("a failed answer or a load error refuses parallel instead of throwing", async () => {
  const failing = probeEvaluator({ fail: "cannot allocate" });
  const out = await probeParallel({ evaluate: failing, width: 2, ...PROBE, clock: failing.clock });
  assert.equal(out.ok, false);
  assert.match(out.reason, /cannot allocate/);
  assert.equal(failing.parallel, 1);

  const wrapped = async (settings, ids) => {
    const prompts = ids.map((id) => ({ id, passed: 1, total: 1, error: null, digest: `d-${id}` }));
    if (wrapped.parallel > 1) prompts[0] = { ...prompts[0], error: "load failed: boom", digest: null };
    return { prompts };
  };
  wrapped.parallel = 1;
  wrapped.setParallel = (n) => { wrapped.parallel = n; };
  wrapped.ensureLoaded = async () => {};
  const second = await probeParallel({ evaluate: wrapped, width: 2, ...PROBE });
  assert.equal(second.ok, false);
  assert.match(second.reason, /boom/);
});

// The later stages sample (temperature above 0), so greedy agreement alone proves too little.
const SAMPLED = { temperature: 0.7, topP: 0.9 };

test("with a sampled pass the probe checks both, in alternating order", async () => {
  const evaluate = probeEvaluator();
  const out = await probeParallel({ evaluate, width: 3, ...PROBE, sampled: SAMPLED, clock: evaluate.clock });
  assert.equal(out.ok, true);
  assert.deepEqual(evaluate.calls.map((call) => `${call.width}@${call.temperature}`), ["3@0", "1@0", "1@0.7", "3@0.7"], "wide goes first once and second once, so a cold first pass favours neither side");
  assert.equal(out.total, 8, "every item is compared greedy and sampled");
  assert.equal(out.matched, 8);
  assert.deepEqual([out.wideMs, out.serialMs], [1200, 2000], "each side's time covers both passes");
});

test("an answer that differs only when sampled refuses the width", async () => {
  const evaluate = probeEvaluator({ digestFor: (id, width, settings) => (id === "b" && width > 1 && settings.temperature > 0 ? "other" : `d-${id}`) });
  const out = await probeParallel({ evaluate, width: 2, ...PROBE, sampled: SAMPLED, clock: evaluate.clock });
  assert.equal(out.ok, false);
  assert.deepEqual(out.mismatches, ["b (sampled)"]);
  assert.match(out.reason, /1 of 8/);
  assert.equal(evaluate.parallel, 1);
});

test("a tune probes up to eight items", () => {
  assert.equal(PROBE_ITEMS, 8);
});

test("a probe with fewer than two items cannot prove anything and is refused", async () => {
  const evaluate = probeEvaluator();
  const out = await probeParallel({ evaluate, width: 3, items: ["a"], settings: {}, seed: 1 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /two/);
  assert.equal(evaluate.calls.length, 0, "nothing was asked");
});

test("probe items are the first rung's items that really share a context at the asked width", () => {
  const longItem = PROMPTS.filter((prompt) => prompt.longContext).sort((left, right) => right.prompt.length - left.prompt.length)[0];
  const ids = [longItem.id, "read-sumTo-1", "read-sumTo-2", "read-clamp-1", "needle", "code-palindrome"];
  const picked = probeItemIds({ ids, width: 3, limit: 4, settings: { contextSize: 4096, maxTokens: 96, systemPrompt: "" } });
  assert.equal(picked.length, 4, "capped at the limit");
  assert.ok(!picked.includes(longItem.id), "an item whose slot is too small is left out");
  assert.deepEqual(picked, ["read-sumTo-1", "read-sumTo-2", "read-clamp-1", "needle"], "suite order is kept");
  assert.deepEqual(probeItemIds({ ids: ["no-such-item"], width: 3, limit: 4, settings: {} }), [], "unknown ids are ignored");
});

// --- the evaluator chooses a width for each call ------------------------------

function sequenceEngine() {
  const engine = {
    loads: [], reconfigures: [],
    async load(options) { engine.loads.push(options); },
    async reconfigure(options) { engine.reconfigures.push(options); },
    async status() { return { memory: { cpuRam: 1, gpuVram: 0 } }; },
    async chat() { return { text: "0", stats: { ms: 5 } }; },
    dropSession() {},
  };
  return engine;
}

const SETTINGS = { contextSize: 4096, threads: 4, batchSize: 512, kvCache: "f16", temperature: 0, maxTokens: 64 };
const SHORT = ["read-sumTo-1", "read-sumTo-2", "read-clamp-1"];

test("short items share the parallel width; a long-context item gets the whole context", async () => {
  const longItem = PROMPTS.filter((prompt) => prompt.longContext).sort((left, right) => right.prompt.length - left.prompt.length)[0];
  assert.ok(longItem, "the suite has a long-context item");
  const engine = sequenceEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1", parallel: 3 });
  await evaluate(SETTINGS, SHORT, 42);
  assert.equal(engine.loads[0].sequences, 3);
  await evaluate(SETTINGS, [longItem.id], 42);
  assert.equal(engine.reconfigures.at(-1).sequences, 1, "a slot of 16384/3 cannot hold it, so the context is rebuilt with one slot");
  await evaluate(SETTINGS, SHORT, 7);
  assert.equal(engine.reconfigures.at(-1).sequences, 3, "short items return to the wide context");
  assert.equal(engine.loads.length, 1, "the model never reloads for a width change");
});

test("the width can be changed on a live evaluator and applies to the next call", async () => {
  const engine = sequenceEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  assert.equal(evaluate.parallel, 1);
  await evaluate(SETTINGS, SHORT, 42);
  assert.equal(engine.loads[0].sequences, 1);
  evaluate.setParallel(3);
  assert.equal(evaluate.parallel, 3);
  await evaluate(SETTINGS, SHORT, 42);
  assert.equal(engine.reconfigures.at(-1).sequences, 3);
});

test("a timed stage answers on one slot even when the tune runs wide", async () => {
  const engine = sequenceEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1", parallel: 3 });
  await evaluate({ ...SETTINGS, parallelism: 1, timed: true }, SHORT, 42);
  assert.equal(engine.loads[0].sequences, 1);
});

// --- answers from different widths are never mixed ----------------------------

test("saved answers are reused only by a tune of the same width; untagged ones count as serial", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-parallel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fingerprint = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "3.22.2", tunerVersion: 10 };
  const run = await startRun(dir, { profileId: "p", model: "p.gguf", request: {}, fingerprint, now: new Date("2026-11-13T10:00:00Z") });
  const settings = { temperature: 0 };
  await run.answers([
    { settings, seed: 42, item: "serial-1", passed: 1, total: 1 },
    { settings, seed: 42, item: "wide-1", passed: 1, total: 1, parallel: 3 },
    { settings, seed: 42, item: "wide-2", passed: 0, total: 1, parallel: 3 },
  ]);
  await run.finish({ outcome: "done", now: new Date("2026-11-13T10:01:00Z") });
  const ids = async (parallel) => (await cachedAnswers(dir, { profileId: "p", fingerprint, parallel })).flatMap((group) => group.rows.map((row) => row.item)).sort();
  assert.deepEqual(await ids(1), ["serial-1"]);
  assert.deepEqual(await ids(3), ["wide-1", "wide-2"]);
  assert.deepEqual(await ids(undefined), ["serial-1"], "the default is serial");
});

test("each answer carries the width its call really ran at", async () => {
  const engine = sequenceEngine();
  const evaluate = createEvaluator({ engine, modelId: "m1", parallel: 3 });
  const wide = await evaluate(SETTINGS, SHORT, 42);
  assert.deepEqual(wide.prompts.map((item) => item.width), [3, 3, 3]);
  const timed = await evaluate({ ...SETTINGS, parallelism: 1, timed: true }, SHORT, 42);
  assert.deepEqual(timed.prompts.map((item) => item.width), [1, 1, 1], "the speed stage answers one at a time");
});

test("a row is tagged with its call's width and its tune's width", () => {
  const settings = { temperature: 0 };
  const answer = (width) => ({ id: "x", passed: 1, total: 1, width });
  assert.deepEqual([answerRow(settings, 42, answer(3), 3).parallel, answerRow(settings, 42, answer(3), 3).tuneParallel], [3, 3]);
  const serialInWide = answerRow(settings, 42, answer(1), 3);
  assert.equal(serialInWide.parallel, undefined, "a serial call is untagged, as serial rows always were");
  assert.equal(serialInWide.tuneParallel, 3);
  const serial = answerRow(settings, 42, answer(1), 1);
  assert.equal("parallel" in serial || "tuneParallel" in serial, false, "a serial tune writes rows as before");
});

test("a serial tune reuses the serial answers of a wide tune; a wide tune keeps its own world", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-parallel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fingerprint = { suiteVersion: 18, taskHash: "h", nodeLlamaCpp: "3.22.2", tunerVersion: 10 };
  const run = await startRun(dir, { profileId: "p", model: "p.gguf", request: {}, fingerprint, now: new Date("2026-11-13T10:00:00Z") });
  const settings = { temperature: 0 };
  await run.answers([
    { settings, seed: 42, item: "speed-in-wide", passed: 1, total: 1, tuneParallel: 3 },
    { settings, seed: 42, item: "wide", passed: 1, total: 1, parallel: 3, tuneParallel: 3 },
    { settings, seed: 42, item: "narrowed", passed: 1, total: 1, parallel: 2, tuneParallel: 3 },
    { settings, seed: 42, item: "serial", passed: 1, total: 1 },
  ]);
  await run.finish({ outcome: "done", now: new Date("2026-11-13T10:01:00Z") });
  const ids = async (parallel) => (await cachedAnswers(dir, { profileId: "p", fingerprint, parallel })).flatMap((group) => group.rows.map((row) => row.item)).sort();
  assert.deepEqual(await ids(1), ["serial", "speed-in-wide"], "every serially answered row, whichever tune made it");
  assert.deepEqual(await ids(3), ["narrowed", "speed-in-wide", "wide"], "a width-3 tune reuses what width-3 tunes answered, as before");
});
