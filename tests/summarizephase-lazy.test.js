import assert from "node:assert/strict";
import test from "node:test";

import { summarizePhase } from "../src/benchmark-report.js";

const ITEMS = { passed: 5, total: 6, rate: 83.3, ci95: null, byCategory: { c: { passed: 5 } }, byOrigin: { o: { passed: 5 } }, byDataset: { d: { passed: 5 } } };

function result({ withBreakdowns = true, tie = false } = {}) {
  const items = { passed: 5, total: 6, rate: 83.3, ci95: null };
  if (withBreakdowns) Object.assign(items, { byCategory: ITEMS.byCategory, byOrigin: ITEMS.byOrigin, byDataset: ITEMS.byDataset });
  return {
    phase: "model", suiteVersion: 18, testHash: "t", createdAt: "x", runtimeMs: 1000,
    models: Array.from({ length: 40 }, (_, i) => ({
      tokensPerSecond: tie ? 50 : i,
      memoryBytes: 1e9 + i, gpuVram: i * 10,
      prompts: [{ id: `p${i}`, category: "c", passed: 1, total: 1 }],
    })),
    overall: { score: 0.8, tokensPerSecond: 100, firstTokenMs: 12, checksPassed: 5, checksTotal: 6, items },
    tests: [{ id: "t1", passed: 1, total: 1, percent: 100 }],
  };
}

test("summarizePhase keeps phase fields, breakdowns and first-max representative", () => {
  const full = summarizePhase(result(), null);
  assert.equal(full.phase, "model");
  assert.deepEqual(full.items, ITEMS);
  // Highest tokensPerSecond is model 39; ties keep the first (index 0).
  assert.equal(full.memoryBytes, 1e9 + 39);
  assert.equal(summarizePhase(result({ tie: true }), null).memoryBytes, 1e9);

  const partial = summarizePhase(result({ withBreakdowns: false }), null);
  assert.ok(partial.items.byCategory);
  assert.ok(partial.items.byOrigin);
  assert.ok(partial.items.byDataset);
  assert.equal(summarizePhase(null, null), null);
});

test("summarizePhase neither sorts models nor derives used breakdowns", () => {
  const r = result();
  let sorts = 0;
  let flatMaps = 0;
  const counted = new Proxy(r.models, {
    get(target, prop, receiver) {
      if (prop === "sort") sorts += 1;
      if (prop === "flatMap") flatMaps += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  r.models = counted;
  const out = summarizePhase(r, null);
  assert.deepEqual(out.items, ITEMS);
  assert.equal(sorts, 0, "no full sort just to find the fastest model");
  assert.equal(flatMaps, 0, "no prompt derivation when breakdowns are present");
});
