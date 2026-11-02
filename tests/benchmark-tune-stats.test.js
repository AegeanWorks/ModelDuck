import assert from "node:assert/strict";
import test from "node:test";

import { Measurements, paired, pairedClustered, score } from "../benchmarks/tune-measure.mjs";
import { tune } from "../benchmarks/tune.mjs";

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
