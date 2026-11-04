import assert from "node:assert/strict";
import test from "node:test";

import { isQuotaExceeded, Measurements, QUOTA_DEFAULT } from "../benchmarks/tune-measure.mjs";
import { DEFAULT_TUNE_OPTIONS, tune } from "../benchmarks/tune.mjs";

const ids = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);

// IDEA-1580: fixed-budget quotas cap tuning measurements.
test("IDEA-1580: quota helper and Measurements quota enforcement", async () => {
  assert.equal(QUOTA_DEFAULT, Infinity);
  assert.equal(isQuotaExceeded(5, Infinity), false);
  assert.equal(isQuotaExceeded(4, 5), false);
  assert.equal(isQuotaExceeded(5, 5), true);
  assert.equal(isQuotaExceeded(9, 5), true);
  assert.equal(DEFAULT_TUNE_OPTIONS.quota, Infinity);

  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })),
  });
  const capped = new Measurements(evaluate, 100000, () => {}, { quota: 4 });
  assert.equal(capped.exhausted, false);
  await capped.measure({ kind: "q" }, ids("m", 4), 42);
  assert.equal(capped.runs, 4);
  assert.equal(capped.quotaExceeded, true);
  assert.equal(capped.exhausted, true);
  const open = new Measurements(evaluate, 100000, () => {});
  assert.equal(open.quotaExceeded, false);
  assert.equal(open.exhausted, false);
});

test("IDEA-1580: a small quota stops the tune early with quotaExhausted", async () => {
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })),
  });
  const rungs = {
    load: [ids("mix", 8)],
    speed: [ids("speed", 6)],
    math: [ids("math", 12)],
  };
  const done = await tune({
    evaluate,
    base: { contextSize: 4096, kvCache: "f16", threads: 8, temperature: 0, maxTokens: 256 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs,
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [
      { name: "temperature", patches: [{ temperature: 0 }, { temperature: 0.6 }] },
      { name: "maxTokens", patches: [{ maxTokens: 128 }, { maxTokens: 256 }] },
    ],
    options: { seeds: [42], passes: 2, quota: 6, changeAlpha: Infinity },
  });
  assert.equal(done.quotaExhausted, true);
  assert.equal(done.budgetExhausted, true);
  assert.ok(done.runs <= 6 + 12, `runs ${done.runs} stays near the quota`);
});

test("IDEA-1580: no quota behaves as before (no quotaExhausted flag)", async () => {
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })),
  });
  const done = await tune({
    evaluate,
    base: { contextSize: 4096, kvCache: "f16", threads: 8, temperature: 0, maxTokens: 256 },
    tasks: [],
    stages: [],
    rungs: { load: [ids("mix", 4)] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    options: { seeds: [42], passes: 1 },
  });
  assert.equal(done.quotaExhausted ?? false, false);
});
