import assert from "node:assert/strict";
import test from "node:test";

import { monteCarloDrawCount } from "../benchmarks/stats.mjs";
import { Measurements, createRungAccumulator, derivedUpdateComputations, leanScoreComputations, lightFinalizeComputations, paired, pairedClustered, rangedMeasureComputations, round, roundCacheStats, rungAccumulateComputations, score, scoreFromAccumulator, scoreSequential, sequentialAccumulateComputations } from "../benchmarks/tune-measure.mjs";
import { createSweepEvidenceCache, tune } from "../benchmarks/tune.mjs";

/**
 * Statistical regression tests (V2): seeded simulations through the real
 * `tune()`, small enough for `npm test`. They guard the decision behavior —
 * error control under no difference, power for a real gain, and the S5 rule —
 * not exact rates, which belong to the larger `power.mjs` study.
 */

// Deterministic LCG: the same seed always replays the same answers.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// 48 fully discriminating items (base pass 0.5): a gain shifts every item's
// pass chance by `gain` points. Smaller than the full tune, but big enough
// that a ten-point gain is usually provable — unlike 12 items, where S1's
// power gap makes even a real gain indistinguishable from noise.
const SIM_ITEMS = 48;

function simulator({ gain = 0, seed = 1 }) {
  const random = rng(seed);
  // Freeze the noise up front so both values face the same items.
  const noise = Array.from({ length: SIM_ITEMS }, () => random());
  return async (settings) => ({
    prompts: noise.map((draw, index) => {
      const shift = settings.level === "good" ? gain / 100 : 0;
      return { id: `s-${index}`, passed: draw < 0.5 + shift ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: `s-${index}` };
    }),
  });
}

async function sweep({ gain, seed }) {
  const evaluate = simulator({ gain, seed });
  const { sweeps } = await tune({
    evaluate,
    base: { temperature: 0 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { math: [[...Array.from({ length: SIM_ITEMS }, (_, i) => `s-${i}`)]] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [{ name: "level", patches: [{ level: "base" }, { level: "good" }] }],
    options: { seeds: [42], passes: 1 },
  });
  return sweeps.find((sweep) => sweep.axis === "level").winner.level;
}

test("under no difference, wrong changes stay controlled (V2)", async () => {
  let wrong = 0;
  const sims = 60;
  for (let seed = 1; seed <= sims; seed += 1) {
    if ((await sweep({ gain: 0, seed })) === "good") wrong += 1;
  }
  assert.ok(wrong / sims <= 0.2, `no-difference wrong-change rate ${wrong}/${sims} exceeds the 20% guard`);
});

test("a real ten-point gain is usually chosen (V2)", async () => {
  let wins = 0;
  const sims = 60;
  for (let seed = 1; seed <= sims; seed += 1) {
    if ((await sweep({ gain: 10, seed })) === "good") wins += 1;
  }
  assert.ok(wins / sims >= 0.5, `+10pt detection ${wins}/${sims} collapsed below the 50% guard`);
});

test("paired() uses seed fractions a majority vote cannot see (S2)", async () => {
  const { paired } = await import("../benchmarks/tune-measure.mjs");
  const ids = ["a", "b", "c", "d", "e"];
  const stats = (fracs) => ({
    fractions: Object.fromEntries(ids.map((id, index) => [id, fracs[index]])),
    majority: new Map(ids.map((id, index) => [id, fracs[index] >= 0.5])),
  });
  // Every item lost one of three seeds: majorities never move, fractions go 5-0.
  const { b, c, pValue } = paired(stats([1, 1, 1, 1, 1]), stats([0.67, 0.67, 0.67, 0.67, 0.67]));
  assert.deepEqual([b, c], [5, 0]);
  assert.equal(pValue, 0.0625, "majority McNemar would say p=1 here");
});

test("partial credit is a finer paired signal than all-or-nothing (G6)", async () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const run = async (passed) => {
    const measurements = new Measurements(async (settings, itemIds) => ({
      prompts: itemIds.map((id) => ({ id, passed, total: 4, ms: 10, outputTokens: 5, digest: `${id}:${passed}` })),
    }), 1000);
    return score(measurements, { temperature: 0 }, ids, [42]);
  };
  // Every item goes from 2/4 checks to 3/4: no all-or-nothing flip anywhere.
  const before = await run(2);
  const after = await run(3);
  assert.equal(before.rate, 0, "headline rate stays all-or-nothing");
  assert.equal(after.rate, 0);
  const { b, c, pValue } = paired(before, after);
  assert.deepEqual([b, c], [0, 8]);
  assert.ok(pValue < 0.05, `uniform partial gains are significant (p=${pValue})`);
});

test("clustered flips count once per cluster, not once per item (S4)", async () => {
  const ids = ["f-1", "f-2", "f-3", "f-4", "f-5", "g-1", "g-2", "g-3"];
  const stats = (losers) => ({
    credit: Object.fromEntries(ids.map((id) => [id, losers.includes(id) ? 0 : 1])),
    fractions: Object.fromEntries(ids.map((id) => [id, losers.includes(id) ? 0 : 1])),
    majority: new Map(ids.map((id) => [id, !losers.includes(id)])),
  });
  const item = paired(stats([]), stats(["f-1", "f-2", "f-3", "f-4", "f-5"]));
  assert.deepEqual([item.b, item.c], [5, 0]);
  assert.ok(item.pValue < 0.1, `item-level McNemar is optimistic (p=${item.pValue})`);
  // All five losses share one function: a single cluster moved.
  const clustered = pairedClustered(stats([]), stats(["f-1", "f-2", "f-3", "f-4", "f-5"]), (id) => id.split("-")[0]);
  assert.deepEqual([clustered.b, clustered.c], [5, 0], "b/c stay item-level for display");
  assert.equal(clustered.clusters, 1);
  assert.equal(clustered.pValue, 1, "one cluster moving proves nothing");
  // The same five losses spread over five clusters stay significant.
  const spread = pairedClustered(
    stats([]),
    stats(["f-1", "f-2", "f-3", "f-4", "f-5"]),
    (id) => id,
  );
  assert.equal(spread.pValue, item.pValue, "one item per cluster reduces to the item test");
});

test("a sweep evidence cache repeats neither Monte Carlo draws nor object identity", () => {
  const ids = Array.from({ length: 24 }, (_, i) => `s-${i}`);
  const before = {
    credit: Object.fromEntries(ids.map((id) => [id, 0])),
    majority: new Map(ids.map((id) => [id, false])),
  };
  const after = {
    credit: Object.fromEntries(ids.map((id, i) => [id, (i % 7 + 1) / 10])),
    majority: new Map(ids.map((id, i) => [id, (i % 7 + 1) / 10 >= 0.5])),
  };
  const evidence = createSweepEvidenceCache((id) => id);
  const drawsBefore = monteCarloDrawCount();
  const first = evidence(before, after);
  assert.equal(monteCarloDrawCount(), drawsBefore + 24 * 10000, "the first comparison performs the seeded test");
  assert.strictEqual(evidence(before, after), first, "the chosen comparison reuses the same evidence object");
  assert.equal(monteCarloDrawCount(), drawsBefore + 24 * 10000, "the repeated comparison performs no draws");

  const reverse = evidence(after, before);
  assert.deepEqual([reverse.b, reverse.c], [first.c, first.b], "direction remains part of the cache key");
  assert.equal(monteCarloDrawCount(), drawsBefore + 48 * 10000, "the reverse comparison is computed once");
});

test("round reuses exact results for repeated values without changing them", () => {
  const before = roundCacheStats();
  const expected = [round(33.333), round(33.333, 2), round(NaN), round(-0), round(0), round(1.005)];
  const actual = [round(33.333), round(33.333, 2), round(NaN), round(-0), round(0), round(1.005)];
  assert.deepEqual(actual.map(String), expected.map(String));
  const after = roundCacheStats();
  assert.ok(after.hits > before.hits, "repeated values hit the cache");
  assert.ok(after.builds > before.builds, "new values and widths are still computed");
  assert.equal(round(33.333), Number((33.333).toFixed(1)));
  assert.equal(round(1.005, 2), Number((1.005).toFixed(2)));
});

test("scoreSequential accumulates each newly measured item once", async () => {
  const ids = Array.from({ length: 12 }, (_value, index) => `i${index}`);
  const measurements = new Measurements(async (_settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 5, tokensPerSecond: 2, digest: id })),
    memoryBytes: 100,
  }), 100);
  const before = sequentialAccumulateComputations();
  const stats = await scoreSequential(measurements, { temperature: 0 }, ids, [42], { lookAt: [4, 8], shouldStop: () => false });
  assert.ok(sequentialAccumulateComputations() > before, "new rows use the accumulate path");
  assert.equal(stats.items, 12);
  assert.equal(stats.rate, 100);
  assert.equal(measurements.reusedRows, 12, "the four and eight item prefixes are still served from the cache");
});

test("sequential scoring updates derived per-item objects once per new item", async () => {
  const ids = Array.from({ length: 12 }, (_value, index) => `i${index}`);
  const measurements = new Measurements(async (_settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 5, tokensPerSecond: 2, digest: id })),
    memoryBytes: 100,
  }), 100);
  const before = derivedUpdateComputations();
  const stats = await scoreSequential(measurements, { temperature: 0 }, ids, [42], { lookAt: [4, 8], shouldStop: () => false });
  assert.equal(derivedUpdateComputations(), before + 3, "one update per reached look");
  assert.deepEqual(stats.outcomes, Object.fromEntries(ids.map((id) => [id, 1])));
  assert.deepEqual(stats.fractions, Object.fromEntries(ids.map((id) => [id, 1])));
  assert.deepEqual([...stats.majority], ids.map((id) => [id, true]));
});

test("intermediate looks omit solved and interval", async () => {
  const ids = Array.from({ length: 8 }, (_value, index) => `i${index}`);
  const measurements = new Measurements(async (_settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 5, tokensPerSecond: 2, digest: id })),
    memoryBytes: 100,
  }), 100);
  let intermediate = null;
  const stats = await scoreSequential(measurements, { temperature: 0 }, ids, [42], {
    lookAt: [4],
    stopSignalOnly: true,
    shouldStop: (value, point) => {
      if (point === 4) intermediate = Object.keys(value).sort();
      return false;
    },
  });
  assert.deepEqual(intermediate, ["credit", "fractions", "majority"], "the guard only receives paired evidence");
  assert.equal(stats.solved, 8);
  assert.ok(stats.ci95.low < 100 && stats.ci95.high <= 100);
});

test("scoreSequential can skip unused summaries at intermediate looks", async () => {
  const ids = Array.from({ length: 12 }, (_value, index) => `i${index}`);
  const measurements = new Measurements(async (_settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 5, tokensPerSecond: 2, digest: id })),
    memoryBytes: 100,
  }), 100);
  const before = lightFinalizeComputations();
  const stops = [];
  const stats = await scoreSequential(measurements, { temperature: 0 }, ids, [42], {
    lookAt: [4, 8],
    stopSignalOnly: true,
    shouldStop: (value, point) => {
      stops.push({ point, hasCredit: Boolean(value.credit) });
      return false;
    },
  });
  assert.equal(lightFinalizeComputations(), before + 2, "the two intermediate looks used the light path");
  assert.deepEqual(stops.map((entry) => entry.hasCredit), [true, true]);
  assert.equal(stats.latencyMs, 10, "the final report still has every summary");
  assert.equal(stats.rate, 100);

  const stopped = await scoreSequential(measurements, { temperature: 0 }, ids, [42], {
    lookAt: [4, 8],
    stopSignalOnly: true,
    shouldStop: (_value, point) => point === 8,
  });
  assert.equal(stopped.partial, true);
  assert.equal(stopped.latencyMs, 10, "a stopped report is rebuilt in full");
});

test("sequential scoring measures half-open rung ranges", async () => {
  const ids = Array.from({ length: 12 }, (_value, index) => `i${index}`);
  const measuredRanges = [];
  const measurements = new Measurements(async (_settings, itemIds) => {
    measuredRanges.push(itemIds.length);
    return {
      prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 5, tokensPerSecond: 2, digest: id })),
      memoryBytes: 100,
    };
  }, 100);
  const before = rangedMeasureComputations();
  const stats = await scoreSequential(measurements, { temperature: 0 }, ids, [42], { lookAt: [4, 8], shouldStop: () => false });
  assert.ok(rangedMeasureComputations() > before, "looks use the ranged measure path");
  assert.deepEqual(measuredRanges, [4, 4, 4], "only newly reached items are evaluated, not sliced prefixes");
  assert.equal(stats.rate, 100);
  assert.equal(measurements.reusedRows, 12, "reuse accounting still counts cached prefix items");
});

test("a rung accumulator reproduces separate scores at each growing rung", async () => {
  const ids = Array.from({ length: 12 }, (_value, index) => `i${index}`);
  const seen = [];
  const measurements = new Measurements(async (_settings, itemIds) => {
    seen.push(itemIds.slice());
    return {
      prompts: itemIds.map((id) => {
        const index = Number(id.slice(1));
        return { id, passed: index % 5 === 0 ? 0 : 1, total: 1, ms: 10 + index, outputTokens: 5, tokensPerSecond: 2, promptTokens: 8, firstTokenMs: 2, digest: id };
      }),
      memoryBytes: 100,
    };
  }, 100);
  const state = createRungAccumulator();
  const before = rungAccumulateComputations();
  const first = await scoreFromAccumulator(state, measurements, { temperature: 0 }, ids, 0, 4, [42]);
  const second = await scoreFromAccumulator(state, measurements, { temperature: 0 }, ids, 4, 12, [42]);
  assert.ok(rungAccumulateComputations() > before, "both rungs use the accumulator");
  const expectedFirst = await score(measurements, { temperature: 0 }, ids.slice(0, 4), [42]);
  const expectedSecond = await score(measurements, { temperature: 0 }, ids, [42]);
  const comparable = (stats) => {
    const { itemLatency: _l, itemTokens: _t, itemPrompt: _p, itemSpeed: _s, itemThroughput: _h, digests: _d, ...summary } = stats;
    return summary;
  };
  assert.deepEqual(comparable(first), comparable(expectedFirst));
  assert.deepEqual(comparable(second), comparable(expectedSecond));
  assert.deepEqual(seen.map((list) => list.length), [4, 8], "only new items are evaluated per rung");
});

test("lean scoring skips maps the tune never reads", async () => {
  const ids = Array.from({ length: 4 }, (_value, index) => `i${index}`);
  const measurements = new Measurements(async (_settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 5, tokensPerSecond: 2, promptTokens: 8, firstTokenMs: 2, digest: id })),
    memoryBytes: 100,
  }), 100);
  const before = leanScoreComputations();
  const full = await score(measurements, { temperature: 0 }, ids, [42]);
  const lean = await score(measurements, { temperature: 0 }, ids, [42], { lean: true });
  assert.equal(leanScoreComputations(), before + 1);
  assert.equal(full.itemThroughput.size, 4);
  assert.equal(full.digests.size, 4);
  assert.equal(lean.itemThroughput.size, 0);
  assert.equal(lean.digests.size, 0);
  const { itemLatency: _l, itemTokens: _t, itemPrompt: _p, itemSpeed: _s, itemThroughput: _h, digests: _d, majority: _m, ...a } = full;
  const { itemLatency: _l2, itemTokens: _t2, itemPrompt: _p2, itemSpeed: _s2, itemThroughput: _h2, digests: _d2, majority: _m2, ...b } = lean;
  assert.deepEqual(b, a);
});

test("inlined pass predicate matches stats.itemPassed on every shape", async () => {
  const prompts = [
    { id: "a", passed: 1, total: 1 },
    { id: "b", passed: 0, total: 1 },
    { id: "c", passed: 1, total: 2 },
    { id: "d", passed: 1, total: 1, error: "boom" },
    { id: "e", passed: 0, total: 0 },
  ];
  const measurements = new Measurements(async () => ({ prompts, memoryBytes: 100 }), 100);
  const stats = await score(measurements, { temperature: 0 }, prompts.map((p) => p.id), [42]);
  assert.deepEqual(stats.outcomes, { a: 1, b: 0, c: 0, d: 0, e: 0 });
});

test("score counts empty answers as give-ups beside truncation (lit §8)", async () => {
  const prompts = [
    { id: "a", passed: 1, total: 1, ms: 10, outputTokens: 12, text: "code", stopReason: "eogToken" },
    { id: "b", passed: 0, total: 1, ms: 10, outputTokens: 0, text: "", stopReason: "eogToken" },
    { id: "c", passed: 0, total: 1, ms: 10, outputTokens: 5, text: "x", stopReason: "maxTokens" },
    { id: "d", passed: 0, total: 1, error: "boom", ms: null },
  ];
  const measurements = new Measurements(async () => ({ prompts }), 100);
  const stats = await score(measurements, { temperature: 0 }, ["a", "b", "c", "d"], [42]);
  assert.equal(stats.giveUpRate, 33.3, "one empty answer of three answered");
  assert.equal(stats.truncationRate, 33.3, "errors stay out of both denominators");
});

test("restored answers are reused without calling evaluate (G8)", async () => {  let calls = 0;
  const measurements = new Measurements(async () => {
    calls += 1;
    return { prompts: [] };
  }, 1000);
  const rows = [
    { item: "a", passed: 1, total: 1, ms: 10, outputTokens: 5, digest: "a" },
    { item: "b", passed: 0, total: 1, ms: 12, outputTokens: 6, digest: "b" },
  ];
  assert.equal(measurements.restore({ temperature: 0 }, 42, rows), true);
  assert.equal(measurements.restore({ temperature: 0 }, 42, rows), false, "fresh measurements win over a restore");
  const stats = await score(measurements, { temperature: 0 }, ["a", "b"], [42]);
  assert.equal(calls, 0, "the restored slot answered without measuring");
  assert.equal(stats.rate, 50);
});

test("prefetched live rows keep measured-answer accounting and batch recording", async () => {
  const asked = [];
  const recorded = [];
  const measurements = new Measurements(async (settings, ids) => {
    asked.push([...ids]);
    return {
      prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: `fresh ${id}`, ms: 20, outputTokens: 4, stopReason: "eogToken" })),
      memoryBytes: 200,
      gpuVram: 300,
    };
  }, 100, (settings, seed, rows) => recorded.push({ settings, seed, ids: rows.map((row) => row.id) }));
  const settings = { temperature: 0 };
  const live = { id: "a", passed: 1, total: 1, text: "live a", ms: 7, outputTokens: 3, stopReason: "eogToken" };
  assert.equal(measurements.prefetch(settings, 42, [live], { memoryBytes: 100, gpuVram: 150 }), true);
  const measured = await measurements.measure(settings, ["a", "b"], 42);
  assert.deepEqual(asked, [["b"]], "only the row without live evidence reaches the model");
  assert.deepEqual(measured.prompts.map((row) => row.text), ["live a", "fresh b"]);
  assert.equal(measurements.runs, 2, "the live row still consumes one measured-answer slot");
  assert.equal(measurements.reusedRows, 0, "prefetched work is measured, not restored");
  assert.deepEqual(recorded, [{ settings, seed: 42, ids: ["a", "b"] }], "the original batch is recorded once");
  assert.equal(measured.memoryBytes, 200);
  assert.equal(measured.gpuVram, 300);
  await measurements.measure(settings, ["a"], 42);
  assert.equal(measurements.runs, 2, "a consumed live row is ordinary fresh cache state");
  assert.equal(recorded.length, 1);
});

test("prefetched live rows respect exhausted budgets and win over saved rows", async () => {
  let calls = 0;
  const evaluate = async () => {
    calls += 1;
    return { prompts: [] };
  };
  const recorded = [];
  const settings = { temperature: 0 };
  const live = { id: "a", passed: 1, total: 1, text: "live", ms: 1 };
  const capped = new Measurements(evaluate, 1, (_settings, _seed, rows) => recorded.push(rows));
  capped.prefetch(settings, 42, [live]);
  capped.prefetch(settings, 42, [{ id: "b", passed: 1, total: 1, text: "later", ms: 1 }]);
  assert.equal((await capped.measure(settings, ["a"], 42)).prompts[0].text, "live");
  assert.equal(capped.runs, 1);
  assert.equal(await capped.measure(settings, ["b"], 42), null, "a pending row cannot bypass the run cap");
  assert.equal(capped.runs, 1);
  assert.equal(calls, 0);
  assert.equal(recorded.length, 1);

  const expired = new Measurements(evaluate, 100, () => {}, { deadline: 1, clock: () => 2 });
  expired.prefetch(settings, 42, [live]);
  assert.equal(await expired.measure(settings, ["a"], 42), null, "a pending row cannot bypass the deadline");
  assert.equal(expired.runs, 0);

  const freshWins = new Measurements(evaluate, 100);
  freshWins.prefetch(settings, 42, [live]);
  assert.equal(freshWins.restore(settings, 42, [{ id: "a", passed: 0, total: 1, text: "saved", ms: 9 }]), false);
  assert.equal((await freshWins.measure(settings, ["a"], 42)).prompts[0].text, "live");
  assert.equal(freshWins.runs, 1, "the pending fresh row is accounted when consumed");
});

test("prefetched rows preserve deadline chunks, all-live memory and cap-sibling precedence", async () => {
  const settings = { temperature: 0 };
  const ids = ["a", "b", "c", "d", "e", "f"];
  const rows = ids.map((id) => ({ id, passed: 1, total: 1, text: `live ${id}`, ms: 1 }));
  const batches = [];
  let calls = 0;
  const evaluate = async (_settings, asked) => {
    calls += 1;
    return { prompts: asked.map((id) => ({ id, passed: 1, total: 1, text: `fresh ${id}`, ms: 1 })) };
  };
  evaluate.parallel = 4;
  const chunked = new Measurements(evaluate, 100, (_settings, _seed, answers) => batches.push(answers.map((row) => row.id)), { deadline: 1000, clock: () => 0 });
  chunked.prefetch(settings, 42, rows, { memoryBytes: 111, gpuVram: 222 });
  const measured = await chunked.measure(settings, ids, 42);
  assert.equal(calls, 0);
  assert.equal(chunked.runs, 6);
  assert.deepEqual(batches, [["a", "b", "c", "d"], ["e", "f"]], "pending rows keep the original deadline chunk boundaries");
  assert.equal(measured.memoryBytes, 111);
  assert.equal(measured.gpuVram, 222, "an all-live chunk keeps the verification memory reading");

  const capped = new Measurements(evaluate, 4, () => {}, { deadline: 1000, clock: () => 0 });
  capped.prefetch(settings, 42, rows);
  assert.equal(await capped.measure(settings, ids, 42), null, "the next chunk still observes the run cap");
  assert.equal(capped.runs, 4);

  const sibling = new Measurements(async (current, asked) => ({
    prompts: asked.map((id) => ({ id, passed: 1, total: 1, text: "short", ms: 1, outputTokens: 10, stopReason: "eogToken" })),
  }), 100);
  await sibling.measure({ ...settings, maxTokens: 64 }, ["x"], 42);
  sibling.prefetch({ ...settings, maxTokens: 128 }, 42, [{ id: "x", passed: 1, total: 1, text: "live wide", ms: 2, outputTokens: 10, stopReason: "eogToken" }]);
  assert.equal((await sibling.measure({ ...settings, maxTokens: 128 }, ["x"], 42)).prompts[0].text, "live wide");
  assert.equal(sibling.runs, 2, "exact pending fresh evidence wins over a cap sibling");
});

test("tune consumes prefetched live rows without changing run accounting", async () => {
  const itemIds = (count) => Array.from({ length: count }, (_value, index) => `math-${index}`);
  const args = {
    base: { temperature: 0, threads: 4 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { math: [itemIds(4)], final: { math: itemIds(8) } },
    hardware: { logicalCores: 8 },
    samplingAxes: () => [{ name: "temperature", patches: [{ temperature: 0 }] }],
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  };
  const firstCalls = [];
  const firstRows = [];
  const first = await tune({
    ...args,
    evaluate: async (settings, ids, seed) => {
      firstCalls.push({ settings, ids, seed });
      const prompts = ids.map((id) => ({ id, passed: 1, total: 1, text: `answer ${id}`, ms: 10, outputTokens: 10, digest: id }));
      firstRows.push(...prompts);
      return { prompts, memoryBytes: 100, gpuVram: 200 };
    },
  });
  const target = firstCalls.find((call) => call.ids.includes("math-0"));
  assert.ok(target, "the baseline tune measures math-0");
  const row = firstRows.find((answer) => answer.id === "math-0");
  const asked = [];
  const recorded = [];
  const second = await tune({
    ...args,
    prefetched: [{ settings: target.settings, seed: target.seed, row, memoryBytes: 100, gpuVram: 200 }],
    evaluate: async (settings, ids, seed) => {
      asked.push(...ids);
      return { prompts: ids.map((id) => ({ id, passed: 1, total: 1, text: `answer ${id}`, ms: 10, outputTokens: 10, digest: id })), memoryBytes: 100, gpuVram: 200 };
    },
    onAnswers: (_settings, _seed, answers) => recorded.push(...answers),
  });
  assert.equal(asked.length, firstCalls.reduce((sum, call) => sum + call.ids.length, 0) - 1, "exact live evidence skips one model answer");
  assert.equal(second.runs, first.runs, "the skipped model call still counts as measured work");
  assert.ok(recorded.some((answer) => answer.id === "math-0"), "the live row is still written to the run record");
  assert.equal(second.tasks.math.stats.rate, first.tasks.math.stats.rate);
  assert.deepEqual(second.tasks.math.settings, first.tasks.math.settings);
});

test("score on no items is a zero rate, not NaN", async () => {
  const measurements = new Measurements(async () => ({ prompts: [] }), 100);
  const stats = await score(measurements, { temperature: 0 }, [], [42]);
  assert.equal(stats.items, 0);
  assert.equal(stats.rate, 0, `empty input must not poison rate comparisons (got ${stats.rate})`);
  assert.equal(stats.solved, 0);
});

test("an answer that finished under a smaller token cap is reused under a larger one, and only that (ADR-182)", async () => {
  const asked = [];
  // "short" ends by itself after 40 tokens; "long" is cut at every cap; "odd" is cut by an abort.
  const answer = (id, cap) => {
    if (id === "short") return { id, passed: 1, total: 1, ms: 400, outputTokens: 40, stopReason: "eogToken", text: "done", digest: "s" };
    if (id === "odd") return { id, passed: 0, total: 1, ms: 5, outputTokens: 3, stopReason: "abort", digest: "o" };
    if (id === "bad") return { id, passed: 0, total: 1, ms: 5, outputTokens: 0, error: "load failed", digest: "b" };
    return { id, passed: cap >= 512 ? 1 : 0, total: 1, ms: cap * 10, outputTokens: cap, stopReason: "maxTokens", text: "x".repeat(cap), digest: `l${cap}` };
  };
  const recorded = [];
  const measurements = new Measurements(async (settings, itemIds, seed) => {
    asked.push({ cap: settings.maxTokens, ids: [...itemIds], seed });
    return { prompts: itemIds.map((id) => answer(id, settings.maxTokens)) };
  }, 1000, (settings, seed, rows) => recorded.push({ cap: settings.maxTokens, ids: rows.map((row) => row.id) }));
  const ids = ["short", "long", "odd", "bad"];
  const base = { temperature: 0.7, topP: 0.9 };
  await measurements.measure({ ...base, maxTokens: 64 }, ids, 42);
  assert.deepEqual(asked.at(-1).ids, ids, "nothing to reuse yet");
  const wide = await measurements.measure({ ...base, maxTokens: 512 }, ids, 42);
  assert.deepEqual(asked.at(-1), { cap: 512, ids: ["long", "odd", "bad"], seed: 42 }, "only the answer that finished is not asked again");
  assert.equal(wide.prompts[0].text, "done");
  assert.equal(wide.prompts[0].outputTokens, 40);
  assert.equal(wide.prompts[1].passed, 1, "the cut answer is measured at the new cap");
  assert.equal(measurements.reusedRows, 1);
  assert.equal(measurements.runs, 4 + 3, "a reused answer is not a measured one");
  assert.deepEqual(recorded.at(-1), { cap: 512, ids: ["long", "odd", "bad"] }, "the run record keeps only what the model answered");
  // A smaller or equal cap never reuses a larger one's answer; another seed or setting never reuses any.
  await measurements.measure({ ...base, maxTokens: 32 }, ["short"], 42);
  assert.deepEqual(asked.at(-1).ids, ["short"], "a smaller cap than the one that finished is measured");
  await measurements.measure({ ...base, maxTokens: 1024 }, ["short"], 7);
  assert.deepEqual(asked.at(-1), { cap: 1024, ids: ["short"], seed: 7 }, "another seed is another answer");
  await measurements.measure({ ...base, topP: 0.8, maxTokens: 1024 }, ["short"], 42);
  assert.deepEqual(asked.at(-1).ids, ["short"], "another sampler setting is another answer");
  // No cap at all (null) is the largest of all: an answer that finished stands for it.
  const before = asked.length;
  await measurements.measure({ ...base, maxTokens: null }, ["short"], 42);
  assert.equal(asked.length, before, "an answer that finished in 40 tokens also stands for no cap");
});

test("the order the caps are measured in does not matter: a finished answer serves every cap above its length (ADR-182)", async () => {
  const asked = [];
  const measurements = new Measurements(async (settings, itemIds) => {
    asked.push({ cap: settings.maxTokens, ids: [...itemIds] });
    return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 90, stopReason: "eogToken", digest: id })) };
  }, 1000);
  await measurements.measure({ temperature: 0, maxTokens: 512 }, ["a", "b"], 42);
  await measurements.measure({ temperature: 0, maxTokens: 128 }, ["a", "b"], 42);
  assert.equal(asked.length, 1, "90 tokens fit under 128: the 512 answer is also the 128 answer");
  await measurements.measure({ temperature: 0, maxTokens: 64 }, ["a", "b"], 42);
  assert.deepEqual(asked.at(-1), { cap: 64, ids: ["a", "b"] }, "under 64 the answer would have been cut, so it is measured");
  await measurements.measure({ temperature: 0, maxTokens: 90 }, ["a"], 42);
  assert.deepEqual(asked.at(-1), { cap: 90, ids: ["a"] }, "a cap equal to the length is not reused: the stop might have been the cap");
});
