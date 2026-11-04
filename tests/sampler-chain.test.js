import assert from "node:assert/strict";
import test from "node:test";

import { chainOrder, chainSteps, orderedSamplerKeys, samplerOptions, SAMPLER_ORDER } from "../src/sampler-chain.js";
import { applyPreset } from "../src/config.js";

// IDEA-1520: single canonical ordered sampler chain (subsumes 1380/1523).
test("IDEA-1520: canonical order is temp->topP->topK->minP->repeat->dry->seed", () => {
  assert.deepEqual([...SAMPLER_ORDER.slice(0, 5)], ["temperature", "topP", "topK", "minP", "repeatPenalty"]);
  assert.deepEqual(chainOrder(), ["temperature", "topP", "topK", "minP", "repeatPenalty", "dryStrength", "seed"]);
  assert.deepEqual(orderedSamplerKeys(), ["temperature", "topP", "topK", "minP", "repeatPenalty", "dryRepeatPenalty", "seed"]);
});

test("IDEA-1520: sampler options keep canonical key order regardless of input order", () => {
  const shuffled = { seed: 7, minP: 0.05, topK: 40, topP: 0.9, temperature: 0.7, repeatPenalty: 1.1, repeatPenaltyTokens: 64, penalizeNewLine: true, dryStrength: 0, dryBase: 1.75, dryAllowedLength: 4 };
  const options = samplerOptions(shuffled);
  assert.deepEqual(Object.keys(options), ["temperature", "topP", "topK", "minP", "repeatPenalty", "dryRepeatPenalty", "seed"]);
  const steps = chainSteps(shuffled);
  assert.deepEqual(steps.map((step) => step.name), chainOrder());
  // Greedy keeps the chain shape with disabled blocks.
  const greedy = samplerOptions({ temperature: 0, topP: 1, topK: 40, minP: 0, repeatPenalty: 1, dryStrength: 0, seed: -1 });
  assert.equal(greedy.repeatPenalty, false);
  assert.equal(greedy.dryRepeatPenalty, false);
  assert.equal(greedy.seed, undefined);
});

test("IDEA-1520: presets map onto the chain and both engine paths share it", async () => {
  const balanced = applyPreset("balanced", {});
  const options = samplerOptions(balanced);
  assert.deepEqual(Object.keys(options), orderedSamplerKeys());
  assert.equal(options.topK, 40);
  // Both engine paths spread the same helper: check the source once.
  const { readFile } = await import("node:fs/promises");
  const engine = await readFile(new URL("../src/engine.js", import.meta.url), "utf8");
  const uses = engine.match(/samplerOptions\(effectiveSettings\)/g) ?? [];
  assert.equal(uses.length, 2, "chat and completion paths both use the canonical chain");
  assert.ok(engine.includes("IDEA-1520"), "the order is documented where it is applied");
});
