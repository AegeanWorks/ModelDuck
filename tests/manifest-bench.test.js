import assert from "node:assert/strict";
import test from "node:test";

import { needsEmptyRetry } from "../src/engine.js";
import { buildGenerationManifest, digest, manifestSummary } from "../src/generation-manifest.js";
import { subsetInterval } from "../benchmarks/stats.mjs";

// IDEA-1229: the manifest attests the allocation, and the summary keeps it.
test("allocation block survives the manifest and its summary", () => {
  const manifest = buildGenerationManifest({
    model: { id: "m" },
    originalSystemPrompt: "hi",
    messages: [],
    promptText: "hello",
    settings: {},
    allocation: { allocatedContext: 2048, requestedContext: 4096, backend: "cpu", gpuLayers: 0, fallback: null },
  });
  assert.equal(manifest.allocation.allocatedContext, 2048);
  assert.equal(manifestSummary(manifest).allocatedContext, 2048);
  assert.equal(manifestSummary(manifest).requestedContext, 4096);
  assert.equal(manifestSummary(manifest).allocationGpuLayers, 0);
  assert.equal(manifestSummary(manifest).allocationBackend, "cpu");
});

// IDEA-1323: NFC-identical text digests identically.
test("digest is NFC-stable", () => {
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  assert.notEqual(composed, decomposed);
  assert.equal(digest({ text: composed }), digest({ text: decomposed }));
});

// IDEA-1232: a subset of the matrix claims less than the full run.
test("subsetInterval tightens toward the population and flags calibration", () => {
  const full = subsetInterval(8, 10, 10);
  assert.equal(full.calibration, false);
  const partial = subsetInterval(8, 10, 100);
  assert.equal(partial.calibration, true);
  assert.ok(partial.low <= 80 && 80 <= partial.high);
  // Degenerate inputs fall back to the plain Wilson interval, uncalibrated.
  assert.equal(subsetInterval(0, 0, 100).calibration, false);
  assert.equal(subsetInterval(5, 10, 5).calibration, false, "a subset larger than the population is not a subset");
  assert.equal(subsetInterval(5, 0, 100).calibration, false);
});

// IDEA-1161/1265: the retry fires only on empty constrained output.
test("needsEmptyRetry contracts the empty shared outcome", () => {
  assert.equal(needsEmptyRetry({ text: "", grammarUsed: {}, aborted: false }), true);
  assert.equal(needsEmptyRetry({ text: "  ", grammarUsed: {}, aborted: false }), true);
  assert.equal(needsEmptyRetry({ text: null, grammarUsed: {}, aborted: false }), true);
  assert.equal(needsEmptyRetry({ text: undefined, grammarUsed: {}, aborted: false }), true);
  assert.equal(needsEmptyRetry({ text: "hi", grammarUsed: {}, aborted: false }), false);
  assert.equal(needsEmptyRetry({ text: "", grammarUsed: null, aborted: false }), false);
  assert.equal(needsEmptyRetry({ text: "", grammarUsed: {}, aborted: true }), false);
});
