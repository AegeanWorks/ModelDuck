import assert from "node:assert/strict";
import test from "node:test";

import { aggregateReproRuns, buildChatMatrix, DETERMINISM_LOCKDOWN, isNoiseFloorStable, modelMatrix, modelMatrixFor, reproVariant, withDeterministicRepro } from "../benchmarks/matrix.mjs";
import { DETERMINISM_LOCKDOWN as CONFIG_LOCKDOWN, isDeterministicRepro, withDeterminismLockdown } from "../src/config.js";

// IDEA-1627: determinism lockdown (batch-1 + triple-run noise-floor gate).
test("IDEA-1627: defaults stay fast (batch 512, flag off)", async () => {
  const { BENCHMARK_MATRIX, CORE_MODEL_MATRIX } = await import("../benchmarks/matrix.mjs");
  assert.ok(BENCHMARK_MATRIX.length > 0);
  // The base variants default to batch 512 for speed; sweeps/presets vary it
  // intentionally. The flag itself stays off unless requested.
  const base = BENCHMARK_MATRIX.find((spec) => spec.id === "qwen-0.5b-q4-f16");
  assert.equal(base.batchSize, 512, "base variant stays batch 512 for speed");
  assert.ok(BENCHMARK_MATRIX.every((spec) => spec.deterministicRepro !== true), "flag off by default");
  assert.ok(CORE_MODEL_MATRIX.every((spec) => spec.deterministicRepro !== true));
  assert.equal(DETERMINISM_LOCKDOWN.batchSize, 1);
  assert.equal(DETERMINISM_LOCKDOWN.runs, 3);
  assert.equal(DETERMINISM_LOCKDOWN.enabled, false);
  assert.equal(CONFIG_LOCKDOWN.batchSize, 1);
});

test("IDEA-1627: deterministic flag forces batch-1 with triple-run count", () => {
  const fast = modelMatrix();
  assert.ok(fast.every((spec) => spec.batchSize !== 1 || spec.deterministicRepro !== true));
  const repro = modelMatrix({ deterministic: true });
  assert.ok(repro.length > 0);
  assert.ok(repro.every((spec) => spec.batchSize === 1), "repro forces batch 1");
  assert.ok(repro.every((spec) => spec.deterministicRepro === true));
  assert.ok(repro.every((spec) => spec.reproRuns === 3));
  const single = modelMatrixFor("qwen2.5-0.5b-instruct-q4");
  assert.ok(single.length > 0 && single.every((spec) => spec.deterministicRepro !== true));
  const singleRepro = modelMatrixFor("qwen2.5-0.5b-instruct-q4", { deterministic: true });
  assert.ok(singleRepro.every((spec) => spec.batchSize === 1 && spec.reproRuns === 3));
  const one = reproVariant("repro-one", "qwen2.5-0.5b-instruct-q4");
  assert.equal(one.batchSize, 1);
  assert.equal(one.reproRuns, 3);
  assert.equal(withDeterministicRepro(fast).length, fast.length, "flag off returns the same matrix");
});

test("IDEA-1627: noise-floor gate only trusts tight triple runs", () => {
  const tight = isNoiseFloorStable([100, 101, 102]);
  assert.equal(tight.stable, true);
  assert.ok(tight.spreadPct <= 5);
  const noisy = isNoiseFloorStable([100, 150, 200]);
  assert.equal(noisy.stable, false);
  const single = isNoiseFloorStable([100]);
  assert.equal(single.stable, false);
});

test("IDEA-1627: config helper opts settings into batch-1 repro", () => {
  const base = { batchSize: 512 };
  assert.equal(isDeterministicRepro(base), false);
  const repro = withDeterminismLockdown(base);
  assert.equal(repro.batchSize, 1);
  assert.equal(isDeterministicRepro(repro), true);
  assert.equal(repro.deterministicRepro, true);
});

test("IDEA-1627: the repro wrapper also covers the chat phase", () => {
  const chat = buildChatMatrix();
  assert.ok(chat.length > 0);
  assert.ok(chat.every((spec) => spec.deterministicRepro !== true));
  const repro = withDeterministicRepro(chat, { enabled: true });
  assert.equal(repro.length, chat.length);
  assert.ok(repro.every((spec) => spec.batchSize === 1 && spec.deterministicRepro === true && spec.reproRuns === 3));
  assert.deepEqual(
    repro.map((spec) => spec.id),
    chat.map((spec) => spec.id),
    "wrapping preserves variant order",
  );
});

// IDEA-1627: a repro triple stands only when quality repeats and speed sits
// within the noise floor.
test("aggregateReproRuns gates quality repeats and the noise floor", () => {
  const steady = aggregateReproRuns([
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 100 },
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 102 },
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 101 },
  ]);
  assert.equal(steady.stable, true);
  assert.equal(steady.qualityStable, true);
  assert.deepEqual(steady.checks, [40, 40, 40]);

  const flaky = aggregateReproRuns([
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 100 },
    { checksPassed: 39, checksTotal: 40, tokensPerSecond: 101 },
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 100 },
  ]);
  assert.equal(flaky.stable, false);
  assert.equal(flaky.qualityStable, false);

  const noisy = aggregateReproRuns([
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 100 },
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 200 },
    { checksPassed: 40, checksTotal: 40, tokensPerSecond: 100 },
  ]);
  assert.equal(noisy.qualityStable, true);
  assert.equal(noisy.stable, false);
  assert.ok(noisy.spreadPct > 5);
});
