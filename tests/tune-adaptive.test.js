import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ADAPTIVE, ItemInformation, exactGainP, promisingChallengers } from "../benchmarks/tune-adaptive.mjs";

// Adaptive informative rungs (ADR-188): the search rung of a task is cut to the items that have told candidates apart
// per second of answer time, learned from the earlier sweeps of the same tune.

const ids = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
const candidate = (outcomes, ms = 100, extra = {}) => ({ outcomes, itemLatency: new Map(Object.keys(outcomes).map((id) => [id, ms])), ...extra });

test("exactGainP is the one-sided exact test on the discordant pairs", () => {
  assert.equal(exactGainP(0, 0), 1);
  assert.equal(exactGainP(0, 1), 0.5);
  assert.equal(exactGainP(0, 5), 1 / 32);
  assert.equal(exactGainP(5, 0), 1, "a challenger that only loses is nowhere near a gain");
  assert.ok(Math.abs(exactGainP(2, 5) - (21 + 7 + 1) / 128) < 1e-12, "P(X >= 5) with 7 discordant pairs");
});

test("a challenger is promising when it is ahead on the subset and the exact p is small enough", () => {
  const items = ids("a", 12);
  const incumbent = Object.fromEntries(items.map((id) => [id, 1]));
  const lost = (count) => Object.fromEntries(items.map((id, index) => [id, index < count ? 0 : 1]));
  const base = { incumbent: true, patch: { t: 0 }, stats: { outcomes: Object.fromEntries(items.map((id, index) => [id, index < 6 ? 0 : 1])) } };
  const gain = { patch: { t: 0.2 }, stats: { outcomes: Object.fromEntries(items.map((id, index) => [id, index < 6 ? 1 : 1])) } }; // wins 6, loses 0
  const loss = { patch: { t: 0.4 }, stats: { outcomes: lost(9) } }; // the incumbent had 6 failures; this one has 9
  const tie = { patch: { t: 0.6 }, stats: { outcomes: { ...base.stats.outcomes } } };
  const failed = { patch: { t: 0.8 }, stats: { outcomes: {}, failed: true } };
  const partial = { patch: { t: 1 }, stats: { outcomes: { ...incumbent }, partial: true } };
  const found = promisingChallengers([base, gain, loss, tie, failed, partial], 0.3);
  assert.deepEqual(found.map((entry) => entry.patch), [{ t: 0.2 }], "only the clear leader; ties, losers, failures and stopped values are not");
  assert.deepEqual(promisingChallengers([base, { patch: { t: 0.2 }, stats: { outcomes: { ...base.stats.outcomes, "a-0": 1 } } }], 0.3), [], "one extra win (p = 0.5) is not enough at 0.3");
  assert.deepEqual(promisingChallengers([base], 0.3), []);
});

test("nothing is cut before the warm-up sweeps are in, and nothing without enough items", () => {
  const info = new ItemInformation();
  const items = ids("a", 48);
  assert.equal(info.subset("code", items, { ...DEFAULT_ADAPTIVE }), null, "no sweeps yet");
  info.learn("code", items, [candidate(Object.fromEntries(items.map((id) => [id, 1]))), candidate(Object.fromEntries(items.map((id) => [id, 1])))]);
  assert.equal(info.sweeps("code"), 1);
  assert.equal(info.subset("code", items, { ...DEFAULT_ADAPTIVE }), null, "one sweep of two");
  info.learn("code", items, [candidate(Object.fromEntries(items.map((id) => [id, 1]))), candidate(Object.fromEntries(items.map((id) => [id, 1])))]);
  assert.ok(info.subset("code", items, { ...DEFAULT_ADAPTIVE }), "two sweeps are in");
  assert.equal(info.subset("code", ids("a", 10), { ...DEFAULT_ADAPTIVE }), null, "a rung smaller than minItems stays whole");
  assert.equal(info.subset("recall", items, { ...DEFAULT_ADAPTIVE }), null, "another task has no sweeps");
  // A sweep with a single candidate says nothing about disagreement.
  const lone = new ItemInformation();
  lone.learn("code", items, [candidate(Object.fromEntries(items.map((id) => [id, 1])))]);
  assert.equal(lone.sweeps("code"), 0);
});

test("the subset holds the items that disagreed, cheapest first, keeps the category pattern and adds a tripwire", () => {
  const items = [...ids("cheap", 8), ...ids("dear", 8), ...ids("quiet", 8)]; // 24 items in three categories
  const typeOf = (id) => id.split("-")[0];
  const info = new ItemInformation();
  const flipping = new Set(["cheap-1", "cheap-4", "dear-2", "dear-5", "dear-6"]);
  for (let sweep = 0; sweep < 3; sweep += 1) {
    const a = Object.fromEntries(items.map((id) => [id, 1]));
    const b = Object.fromEntries(items.map((id) => [id, flipping.has(id) ? 0 : 1]));
    const ms = (id) => (id.startsWith("dear") ? 4000 : 200);
    info.learn("code", items, [{ outcomes: a, itemLatency: new Map(items.map((id) => [id, ms(id)])) }, { outcomes: b, itemLatency: new Map(items.map((id) => [id, ms(id)])) }]);
  }
  const options = { ...DEFAULT_ADAPTIVE, budget: 0.3, tripwire: 0.6, minItems: 8, typeOf };
  const chosen = info.subset("code", items, options);
  assert.ok(chosen, "a subset is chosen");
  assert.deepEqual([...chosen.slice(0, 2)].sort(), ["cheap-1", "cheap-4"], "the cheap items that flip come first");
  assert.ok(chosen.indexOf("dear-2") > chosen.indexOf("cheap-4"), "a flipping item that costs 20x as much comes later");
  assert.equal(new Set(chosen).size, chosen.length, "no item twice");
  assert.ok(chosen.every((id) => items.includes(id)), "only items of the rung");
  assert.ok(chosen.length < items.length, "the rung shrinks");
  assert.ok(chosen.some((id) => id.startsWith("quiet")), "the tripwire admits some item that never flipped, so a change is noticed");
  assert.deepEqual(info.subset("code", items, options), chosen, "the same data gives the same subset");
});

test("the cost of an item with no timing falls back to the typical one and the subset never drops below minItems", () => {
  const items = ids("x", 40);
  const info = new ItemInformation();
  for (let sweep = 0; sweep < 2; sweep += 1) {
    info.learn("code", items, [{ outcomes: Object.fromEntries(items.map((id) => [id, 1])), itemLatency: new Map() }, { outcomes: Object.fromEntries(items.map((id) => [id, 1])), itemLatency: new Map() }]);
  }
  const chosen = info.subset("code", items, { ...DEFAULT_ADAPTIVE, budget: 0.01, tripwire: 0, minItems: 16 });
  assert.equal(chosen.length, 16, "a tiny budget still keeps the floor");
});
