import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/errors.js";
import { BASELINE_SCHEMA, TUNER_VERSION, baselineEntry, comparability, compareToBaseline, presetSettings, requireBaselineModels } from "../benchmarks/tune-baseline.mjs";

const IDENTITY = { suiteVersion: 8, taskHash: "abc", nodeLlamaCpp: "3.22.2", tunerVersion: TUNER_VERSION };
const PROFILE = {
  catalogId: "qwen",
  fingerprint: { ...IDENTITY, cpu: "CPU" },
  load: { settings: { threads: 8 } },
  tasks: {
    code: { settings: { temperature: 0.1 }, stats: { rate: 75, items: 24, latencyMs: 900, ci95: { low: 1, high: 2 } } },
    comprehension: { settings: { temperature: 0 }, stats: { rate: 50, items: 21, latencyMs: 2000 } },
  },
  sweeps: [{ big: true }],
};

const baseline = () => ({ schema: BASELINE_SCHEMA, ...IDENTITY, models: { qwen: baselineEntry(PROFILE) } });

test("a baseline entry keeps settings and rates, not the sweep log", () => {
  const entry = baselineEntry(PROFILE);
  assert.deepEqual(entry.load, { threads: 8 });
  assert.deepEqual(entry.tasks.code, { settings: { temperature: 0.1 }, rate: 75, items: 24, latencyMs: 900, outcomes: null });
  assert.equal("sweeps" in entry, false);
});

test("a saved profile contributes tuned task settings and leaves untuned tasks at defaults", () => {
  const preset = presetSettings(PROFILE, ["code", "comprehension", "recall"]);
  assert.deepEqual(preset.load, { threads: 8 });
  assert.deepEqual(preset.tasks.code.settings, { temperature: 0.1 });
  assert.deepEqual(preset.tasks.comprehension.settings, { temperature: 0 });
  assert.deepEqual(preset.tasks.recall.settings, {});
  const missing = presetSettings(null, ["code"]);
  assert.deepEqual(missing, { load: {}, tasks: { code: { settings: {} } } });
});

test("a baseline is comparable only on the same suite, items and runtime", () => {
  assert.deepEqual(comparability(baseline(), IDENTITY), []);
  assert.deepEqual(comparability(baseline(), { ...IDENTITY, suiteVersion: 9, nodeLlamaCpp: "3.23.0" }).sort(), ["nodeLlamaCpp", "suiteVersion"]);
  assert.deepEqual(comparability({ ...baseline(), schema: 99 }, IDENTITY), ["schema"]);
});

test("a drop of more than one item fails the gate; one item or a gain does not", () => {
  const current = { qwen: { code: { rate: 70.9, items: 24, latencyMs: 950 }, comprehension: { rate: 42.8, items: 21, latencyMs: 1500 } } };
  const result = compareToBaseline(baseline(), current);
  assert.equal(result.passed, false);
  const code = result.rows.find((row) => row.task === "code");
  const comprehension = result.rows.find((row) => row.task === "comprehension");
  assert.equal(code.regression, false, "4.1 pts is within one 24-item step");
  assert.equal(comprehension.regression, true, "7.2 pts is more than one 21-item step");
  assert.equal(comprehension.latencyDeltaMs, -500);
});

test("a task or model missing from the current run is reported, not silently passed", () => {
  const result = compareToBaseline(baseline(), { qwen: { code: { rate: 75, items: 24, latencyMs: 900 } } });
  assert.equal(result.passed, false);
  assert.equal(result.rows.find((row) => row.task === "comprehension").missing, true);
});

test("a paired loss fails only when significant after Holm; noise does not (V1)", () => {
  const ids = Array.from({ length: 24 }, (_, i) => `code-${i}`);
  const outcomes = (flips) => Object.fromEntries(ids.map((id, i) => [id, flips.includes(i) ? 0 : 1]));
  const base = { schema: BASELINE_SCHEMA, ...IDENTITY, models: { qwen: { load: {}, tasks: { code: { settings: {}, rate: 100, items: 24, latencyMs: 100, outcomes: outcomes([]) } } } } };
  const noisy = compareToBaseline(base, { qwen: { code: { rate: 95.8, items: 24, latencyMs: 100, outcomes: outcomes([0]) } } });
  assert.equal(noisy.rows[0].regression, false, "a single flip is noise");
  assert.deepEqual(noisy.rows[0].regressed, ["code-0"]);
  const real = compareToBaseline(base, { qwen: { code: { rate: 75, items: 24, latencyMs: 100, outcomes: outcomes([0, 1, 2, 3, 4, 5]) } } });
  assert.equal(real.rows[0].regression, true);
  assert.equal(real.passed, false);
});

test("a directional gate spends its alpha on the loss side: a moderate uniform regression fires", () => {
  // Five losses and no fixes (b=5, c=0) is a real regression a directional
  // exact McNemar must catch: P(X <= 0 | B(5, 0.5)) = 0.03125. The two-sided
  // test wastes half its alpha on the never-failing gain side (p = 0.0625)
  // and lets this escape today.
  const ids = Array.from({ length: 24 }, (_, i) => `code-${i}`);
  const outcomes = (flips) => Object.fromEntries(ids.map((id, i) => [id, flips.includes(i) ? 0 : 1]));
  const base = { schema: BASELINE_SCHEMA, ...IDENTITY, models: { qwen: { load: {}, tasks: { code: { settings: {}, rate: 100, items: 24, latencyMs: 100, outcomes: outcomes([]) } } } } };
  const lossy = compareToBaseline(base, { qwen: { code: { rate: 79.2, items: 24, latencyMs: 100, outcomes: outcomes([0, 1, 2, 3, 4]) } } });
  assert.equal(lossy.rows[0].regression, true, "five losses with no fixes is not noise");
  assert.equal(lossy.passed, false);
  assert.equal(lossy.rows[0].pValue, 0.0313, "the reported p is the one-sided loss-tail probability");
});

test("losses mixed with fixes fire only when the loss tail is improbable", () => {
  const ids = Array.from({ length: 24 }, (_, i) => `code-${i}`);
  // saved[i] = baseline pass state, now[i] = re-measured; discordant pairs are b (lost) / c (fixed).
  const saved = ids.map(() => true);
  saved[5] = false; // one item the baseline already failed, so a fix is possible
  const base = { schema: BASELINE_SCHEMA, ...IDENTITY, models: { qwen: { load: {}, tasks: { code: { settings: {}, rate: 95.8, items: 24, latencyMs: 100, outcomes: Object.fromEntries(ids.map((id, i) => [id, saved[i] ? 1 : 0])) } } } } };
  const nowBorderline = ids.map(() => true);
  nowBorderline[5] = true; // the one fix
  for (const index of [0, 1, 2, 3, 4]) nowBorderline[index] = false; // five losses, c = 1
  const borderline = compareToBaseline(base, { qwen: { code: { rate: 79.2, items: 24, latencyMs: 100, outcomes: Object.fromEntries(ids.map((id, i) => [id, nowBorderline[i] ? 1 : 0])) } } });
  assert.equal(borderline.rows[0].regression, false, "five losses with one fix (p = 0.109) stays tolerated noise");
  const nowDecisive = ids.map(() => true);
  for (const index of [0, 1, 2, 3, 4, 7, 8]) nowDecisive[index] = false; // seven losses, c = 1 (item 5 stays the sole fix)
  const decisive = compareToBaseline(base, { qwen: { code: { rate: 70.8, items: 24, latencyMs: 100, outcomes: Object.fromEntries(ids.map((id, i) => [id, nowDecisive[i] ? 1 : 0])) } } });
  assert.equal(decisive.rows[0].regression, true, "seven losses with one fix (p = 0.0352) fires");
});

test("a pure gain never fires the regression rule", () => {
  const ids = Array.from({ length: 24 }, (_, i) => `code-${i}`);
  const outcomes = (flips) => Object.fromEntries(ids.map((id, i) => [id, flips.includes(i) ? 0 : 1]));
  const base = { schema: BASELINE_SCHEMA, ...IDENTITY, models: { qwen: { load: {}, tasks: { code: { settings: {}, rate: 0, items: 24, latencyMs: 100, outcomes: outcomes(ids.map((_, i) => i)) } } } } };
  const gained = compareToBaseline(base, { qwen: { code: { rate: 79.2, items: 24, latencyMs: 100, outcomes: outcomes([]) } } });
  assert.equal(gained.rows[0].regression, false, "five fixes and no losses is a gain, never a regression");
});

test("requireBaselineModels rejects a baseline that lists no models", () => {
  for (const broken of [undefined, {}, { models: {} }]) {
    assert.throws(
      () => requireBaselineModels(broken),
      (error) => error instanceof AppError && error.code === "tune_baseline_empty" && Boolean(error.why) && Boolean(error.fix),
      `expected a clean rejection for ${JSON.stringify(broken)}`,
    );
  }
  // A real baseline passes through and returns its models, so the gate keeps today's shape.
  const baseline = { schema: BASELINE_SCHEMA, models: { m: { tasks: {} } } };
  assert.equal(requireBaselineModels(baseline), baseline.models);
});
