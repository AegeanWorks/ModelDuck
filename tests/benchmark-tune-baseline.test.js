import assert from "node:assert/strict";
import test from "node:test";

import { BASELINE_SCHEMA, TUNER_VERSION, baselineEntry, comparability, compareToBaseline, presetSettings } from "../benchmarks/tune-baseline.mjs";

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
