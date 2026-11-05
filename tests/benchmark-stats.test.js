import assert from "node:assert/strict";
import test from "node:test";

import { compareRuns, holm, itemSummary, mcnemarExact, signFlipPValue, wilson } from "../benchmarks/stats.mjs";

test("Wilson intervals match published values and stay inside 0-100", () => {
  assert.deepEqual(wilson(20, 21), { low: 77.3, high: 99.2 });
  assert.deepEqual(wilson(0, 10), { low: 0, high: 27.8 });
  assert.deepEqual(wilson(0, 0), { low: 0, high: 0 });
});

test("exact McNemar is symmetric and matches the binomial tail", () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(Number(mcnemarExact(0, 6).toFixed(4)), 0.0313);
  assert.equal(mcnemarExact(6, 0), mcnemarExact(0, 6));
  assert.equal(Number(mcnemarExact(2, 8).toFixed(4)), 0.1094);
});

test("Holm adjusts in step-down order and stays monotone", () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]).map((p) => Number(p.toFixed(2))), [0.03, 0.06, 0.06]);
});

test("the sign-flip test matches McNemar for uniform magnitudes (S2)", () => {
  assert.equal(signFlipPValue([]), 1, "no differences, no evidence");
  assert.equal(Number(signFlipPValue([1, 1, 1, 1, 1, 1, -1, -1]).toFixed(4)), Number(mcnemarExact(2, 6).toFixed(4)));
  assert.equal(Number(signFlipPValue([1, 1, 1, 1, 1, 1]).toFixed(4)), 0.0313);
  // Fractions: five items each lost one of three seeds. Majority sees 5-0 stay
  // put and says p=1; the flip test on 0.33s matches McNemar 5-0.
  assert.equal(Number(signFlipPValue([-0.33, -0.33, -0.33, -0.33, -0.33]).toFixed(4)), 0.0625);
});

test("the sign-flip test uses magnitudes a majority vote throws away (S2)", () => {
  // Three full flips plus two same-direction partials: majority McNemar sees
  // 3-0 and says p=0.25, but the magnitudes push the permutation p to 0.0625.
  const p = signFlipPValue([1, 1, 1, 0.33, 0.33]);
  assert.equal(Number(p.toFixed(4)), 0.0625);
  assert.ok(p < mcnemarExact(0, 3), "fractions beat the majority vote");
});

test("the sign-flip Monte Carlo is deterministic and bounded (S2)", () => {
  const diffs = Array.from({ length: 25 }, (_, index) => (index % 3 === 0 ? -0.5 : 0.25));
  const first = signFlipPValue(diffs);
  assert.equal(signFlipPValue(diffs), first, "the seeded draw replays exactly");
  assert.ok(first >= 0 && first <= 1);
});

const item = (id, ok, category = "code") => ({ id, category, passed: ok ? 1 : 0, total: 1, error: null });
const run = (variants) => ({
  models: Object.entries(variants).map(([variantId, results]) => ({ variantId, prompts: results.map(([id, ok]) => item(id, ok)) })),
});

test("item summary counts fully passed items with intervals per category", () => {
  const summary = itemSummary([item("a", true), item("b", false), item("c", true, "facts")]);
  assert.equal(summary.passed, 2);
  assert.equal(summary.byCategory.code.total, 2);
  assert.ok(summary.ci95.low < summary.rate && summary.rate < summary.ci95.high);
});

test("item summary keeps ModelDuck questions separate from public benchmarks", () => {
  const summary = itemSummary([
    item("own-1", true, "facts"),
    item("own-2", false, "code"),
    item("pub-1", true, "public-code"),
    { ...item("pub-2", false, "public-math"), source: { dataset: "GSM8K" } },
  ]);
  assert.deepEqual(summary.byOrigin.own, {
    passed: 1,
    total: 2,
    rate: 50,
    ci95: summary.byOrigin.own.ci95,
  });
  assert.equal(summary.byOrigin.public.passed, 1);
  assert.equal(summary.byOrigin.public.total, 2);
  assert.equal(summary.byDataset.GSM8K.total, 1);
  assert.equal(summary.byDataset.own.total, 2);
});

test("one flipped item warns instead of failing the gate", () => {
  const ids = Array.from({ length: 40 }, (_v, index) => `i${index}`);
  const baseline = run({ v: ids.map((id) => [id, true]) });
  const current = run({ v: ids.map((id, index) => [id, index !== 3]) });
  const result = compareRuns(current, baseline);
  assert.equal(result.verdict, "warn");
  assert.deepEqual(result.variants[0].regressed, ["i3"]);
});

test("a consistent decline fails as significant; a broad drop fails the floor", () => {
  const ids = Array.from({ length: 40 }, (_v, index) => `i${index}`);
  const baseline = run({ v: ids.map((id) => [id, true]), w: ids.map((id) => [id, true]) });
  const current = run({ v: ids.map((id, index) => [id, index >= 8]), w: ids.map((id) => [id, true]) });
  const result = compareRuns(current, baseline);
  assert.equal(result.verdict, "fail");
  assert.ok(result.variants.find((variant) => variant.variantId === "v").significantDecline);
  assert.ok(result.reasons.some((reason) => /floor/.test(reason)));
});

test("a variant that failed before answering is not counted as a regression", () => {
  const baseline = run({ v: [["a", true], ["b", true]] });
  const current = { models: [{ variantId: "v", prompts: [], failed: true }] };
  const result = compareRuns(current, baseline);
  assert.equal(result.verdict, "fail", "a run with no answers fails the gate instead of passing it");
  assert.deepEqual(result.variants, [], "the failed variant is still not paired as a regression");
  assert.deepEqual(result.failed, ["v"]);
  assert.match(result.reasons.join("; "), /v/);
  const allFailed = compareRuns(
    { models: [{ variantId: "v", prompts: [], failed: true }] },
    { models: [{ variantId: "v", prompts: [{ id: "a", passed: 1, total: 1 }] }] },
  );
  assert.equal(allFailed.verdict, "fail");
  assert.equal(allFailed.currentRate, 0);
});

test("improvements and new variants never fail the gate", () => {
  const baseline = run({ v: [["a", false], ["b", true]] });
  const current = run({ v: [["a", true], ["b", true]], extra: [["a", false]] });
  const result = compareRuns(current, baseline);
  assert.equal(result.verdict, "pass");
  assert.equal(result.variants.length, 1);
});

test("disjoint matrices warn instead of passing a vacuous gate", () => {
  const baseline = run({ v: [["a", true], ["b", true]] });
  const current = run({ w: [["a", true], ["b", true]] });
  const result = compareRuns(current, baseline);
  assert.equal(result.verdict, "warn");
  assert.match(result.reasons.join("; "), /No shared variants/);
});

test("a ceiling shortfall is reported even alongside minor regressions", () => {
  const ids = Array.from({ length: 40 }, (_v, index) => `i${index}`);
  const baseline = run({ v: ids.map((id) => [id, true]) });
  const current = run({ v: ids.map((id, index) => [id, index !== 3]) });
  const result = compareRuns(current, baseline, { enforceCeiling: true });
  assert.equal(result.verdict, "warn");
  assert.ok(result.reasons.some((reason) => /ceiling/.test(reason)), result.reasons.join("; "));
  assert.deepEqual(result.variants[0].regressed, ["i3"], "the pairwise regression is still reported");
});
