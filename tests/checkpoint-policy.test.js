import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettings } from "../src/config.js";
import { buildGenerationManifest } from "../src/generation-manifest.js";
import { deriveCheckpointPlan } from "../src/checkpoint-policy.js";

// IDEA-1087: one deterministic checkpoint plan with uniform coverage and a
// bounded checkpoint memory budget.
test("deriveCheckpointPlan scales the interval so checkpoints cover the context", () => {
  const plan = deriveCheckpointPlan({
    contextSize: 16384,
    checkpoints: true,
    checkpointMax: 32,
    checkpointInterval: 8192,
    checkpointMemoryMb: 64,
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.max, 32);
  assert.equal(plan.interval, 512); // 16384 / 32 checkpoints
  assert.equal(plan.memoryMb, 64);
});

test("deriveCheckpointPlan keeps the interval inside the 128..32768 clamp", () => {
  const tiny = deriveCheckpointPlan({
    contextSize: 1024,
    checkpoints: true,
    checkpointMax: 32,
    checkpointInterval: 8192,
    checkpointMemoryMb: 64,
  });
  assert.equal(tiny.interval, 128); // floor of the clamp
  const huge = deriveCheckpointPlan({
    contextSize: 4 * 1024 * 1024,
    checkpoints: true,
    checkpointMax: 8,
    checkpointInterval: 8192,
    checkpointMemoryMb: 64,
  });
  assert.equal(huge.interval, 32768); // ceiling of the clamp
});

test("deriveCheckpointPlan falls back to the configured interval without a context", () => {
  const plan = deriveCheckpointPlan({
    contextSize: null,
    checkpoints: true,
    checkpointMax: 32,
    checkpointInterval: 2048,
    checkpointMemoryMb: 64,
  });
  assert.equal(plan.interval, 2048);
});

test("deriveCheckpointPlan marks disabled checkpoints and caps the memory budget", () => {
  const disabled = deriveCheckpointPlan({
    contextSize: 16384,
    checkpoints: false,
    checkpointMax: 32,
    checkpointInterval: 8192,
    checkpointMemoryMb: 999,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.memoryMb, 256); // budget capped at 256 MiB
  const unlimited = deriveCheckpointPlan({
    contextSize: 16384,
    checkpoints: true,
    checkpointMax: 32,
    checkpointInterval: 8192,
    checkpointMemoryMb: 0,
  });
  assert.equal(unlimited.memoryMb, null); // 0 = unlimited
});

test("deriveCheckpointPlan is deterministic and clamps its inputs", () => {
  const first = deriveCheckpointPlan({ contextSize: 16384, checkpointMax: 0, checkpointMemoryMb: "abc" });
  const second = deriveCheckpointPlan({ contextSize: 16384, checkpointMax: 0, checkpointMemoryMb: "abc" });
  assert.deepEqual(first, second); // no clock, randomness or env: pure of the world
  assert.equal(first.max, 1); // invalid counts fall back inside the clamp
  assert.equal(first.memoryMb, 64); // non-numeric budgets fall back to the default
});

test("checkpointMemoryMb setting defaults to 64 and clamps to 0..256", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.checkpointMemoryMb, 64);
  assert.equal(normalizeSettings({ checkpointMemoryMb: 999 }).checkpointMemoryMb, 256);
  assert.equal(normalizeSettings({ checkpointMemoryMb: -3 }).checkpointMemoryMb, 0);
});

// IDEA-1087 + IDEA-1229: the manifest attests the checkpoint plan that served
// the reply, not just the ask.
test("generation manifests record the checkpoint plan in the allocation block", () => {
  const manifest = buildGenerationManifest({
    model: { id: "m" },
    originalSystemPrompt: "",
    effectiveSystemPrompt: "",
    messages: [],
    history: [],
    promptText: "hello",
    settings: {},
    runtimeVersion: "test",
    allocation: {
      allocatedContext: 16384,
      requestedContext: 16384,
      backend: "cpu",
      gpuLayers: 0,
      fallback: null,
      checkpoints: { enabled: true, max: 32, interval: 512, memoryMb: 64 },
    },
  });
  assert.deepEqual(manifest.allocation.checkpoints, {
    enabled: true,
    max: 32,
    interval: 512,
    memoryMb: 64,
  });
});
