import assert from "node:assert/strict";
import test from "node:test";

import { capFreeKeyOf, slotKeyComputations, slotKeyOf } from "../benchmarks/tune-measure.mjs";

const settings = { temperature: 0.1, maxTokens: 512, threads: 8, minP: 0.05, gpuLayers: "max", gpuBackend: "cpu" };

test("slot keys are built once per settings object and seed", () => {
  const before = slotKeyComputations();
  const first = slotKeyOf(settings, 42);
  assert.equal(slotKeyOf(settings, 42), first);
  assert.equal(slotKeyComputations(), before + 1, "one build for the (settings, seed) pair");

  assert.notEqual(slotKeyOf(settings, 7), first, "seed remains part of the key");
  assert.equal(slotKeyComputations(), before + 2);

  assert.equal(capFreeKeyOf(settings, 42), capFreeKeyOf(settings, 42));
  assert.equal(slotKeyComputations(), before + 3, "the cap-free key is built once too");
});

test("a different settings object still gets its own keys", () => {
  const before = slotKeyComputations();
  const other = { ...settings, temperature: 0.2 };
  assert.notEqual(slotKeyOf(other, 42), slotKeyOf(settings, 42));
  assert.equal(slotKeyComputations(), before + 1);
  assert.equal(slotKeyOf(settings, 42), slotKeyOf(settings, 42));
  assert.equal(slotKeyComputations(), before + 1);
});
