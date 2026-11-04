import assert from "node:assert/strict";
import test from "node:test";

import { compareRuns, losslessCeilingGate } from "../benchmarks/stats.mjs";
import {
  NEEDLE_CHAIN_IDS,
  compareNeedleChains,
  scoreNeedleChain,
} from "../benchmarks/context-curve.mjs";
import {
  recommendCatalog,
  recommendModels,
  totalBytesWithReserve,
} from "../src/recommend.js";
import { MODEL_CATALOG, QUANT_HONESTY_NOTES } from "../src/model-catalog.js";
import { RUNTIME_RESERVE_BYTES, kvBytesPerToken } from "../src/memory-fit.js";

// IDEA-1617: Q8_0 lossless gate — Q8_0 cataloged, benchmarks/stats.mjs mcnemar ready.

test("Q8_0 ceiling gate warns when no ceiling variant was measured", () => {
  const result = {
    models: [
      { variantId: "qwen-0.5b-q4-f16", quant: "Q4_K_M", kvCache: "f16" },
      { variantId: "qwen-0.5b-q4-kv8", quant: "Q4_K_M", kvCache: "q8_0" },
    ],
  };
  const gate = losslessCeilingGate(result);
  assert.equal(gate.hasCeiling, false);
  assert.equal(gate.verdict, "warn");
  assert.ok(gate.reasons.join("; ").includes("Q8_0"));
});

test("an F16 lossless claim without Q8_0 fails the ceiling gate", () => {
  const result = {
    models: [{ variantId: "qwen-0.5b-q4-f16", quant: "Q4_K_M", kvCache: "f16", lossless: true }],
  };
  const gate = losslessCeilingGate(result);
  assert.equal(gate.verdict, "fail");
  assert.ok(gate.reasons.join("; ").includes("Q8_0"));
});

test("a measured Q8_0 ceiling passes the gate", () => {
  const result = {
    models: [
      { variantId: "qwen-0.5b-q4-f16", quant: "Q4_K_M", kvCache: "f16" },
      { variantId: "qwen-0.5b-q8-f16", quant: "Q8_0", kvCache: "f16" },
    ],
  };
  const gate = losslessCeilingGate(result);
  assert.equal(gate.verdict, "pass");
  assert.equal(gate.hasCeiling, true);
  assert.equal(gate.ceilingVariantId, "qwen-0.5b-q8-f16");
});

const item = (id, ok) => ({ id, category: "recall", passed: ok ? 1 : 0, total: 1, error: null });
const run = (variants) => ({
  models: Object.entries(variants).map(([variantId, results]) => ({
    variantId,
    quant: "Q4_K_M",
    prompts: results.map(([id, ok]) => item(id, ok)),
  })),
});

test("compareRuns reports the ceiling without moving the existing verdict", () => {
  const ids = Array.from({ length: 40 }, (_v, index) => `i${index}`);
  const baseline = run({ v: ids.map((id) => [id, true]) });
  const current = run({ v: ids.map((id, index) => [id, index !== 3]) });
  const result = compareRuns(current, baseline);
  assert.equal(result.verdict, "warn");
  assert.equal(result.ceiling.hasCeiling, false);
  assert.equal(result.ceiling.verdict, "warn");
});

test("compareRuns with enforceCeiling fails a lossless claim with no ceiling", () => {
  const baseline = run({ v: [["a", true], ["b", true]] });
  const current = {
    models: [{ variantId: "v", quant: "Q4_K_M", kvCache: "f16", lossless: true, prompts: [item("a", true), item("b", true)] }],
  };
  const relaxed = compareRuns(current, baseline);
  assert.equal(relaxed.verdict, "pass");
  const enforced = compareRuns(current, baseline, { enforceCeiling: true });
  assert.equal(enforced.verdict, "fail");
  assert.ok(enforced.reasons.some((reason) => reason.includes("Q8_0")));
});

// IDEA-1504: code-needle chain scoring on affordable needles.

test("needle chain passes when every affordable needle passes", () => {
  const outcomes = { "recall-long-4k": 1, "recall-long-8k": 1, "recall-long-16k": 1 };
  const chain = scoreNeedleChain(outcomes);
  assert.deepEqual(chain.ids, [...NEEDLE_CHAIN_IDS]);
  assert.equal(chain.chainPassed, true);
  assert.equal(chain.verdict, "pass");
  assert.equal(chain.brokenAt, null);
  assert.equal(chain.prefix, 3);
});

test("needle chain fails at the first broken affordable needle", () => {
  const outcomes = { "recall-long-4k": 1, "recall-long-8k": 0, "recall-long-16k": 1 };
  const chain = scoreNeedleChain(outcomes);
  assert.equal(chain.chainPassed, false);
  assert.equal(chain.verdict, "fail");
  assert.equal(chain.brokenAt, "recall-long-8k");
  assert.equal(chain.prefix, 1);
});

test("unaffordable needles stay out of the chain", () => {
  const outcomes = { "recall-long-4k": 1, "recall-long-8k": 1, "recall-long-16k": 0 };
  const chain = scoreNeedleChain(outcomes, { affordable: ["recall-long-4k", "recall-long-8k"] });
  assert.equal(chain.verdict, "pass");
  assert.equal(chain.total, 2);
});

test("a silent KV regression on an affordable needle fails the comparison", () => {
  const base = { "recall-long-4k": 1, "recall-long-8k": 1, "recall-long-16k": 1 };
  const candidate = { "recall-long-4k": 1, "recall-long-8k": 0, "recall-long-16k": 1 };
  const gate = compareNeedleChains(base, candidate);
  assert.equal(gate.verdict, "fail");
  assert.deepEqual(gate.regressed, ["recall-long-8k"]);
});

// IDEA-1623: fixed-total-bytes rule + Q5 overhead disclosure.

test("total bytes are fixed: weights plus KV plus the runtime reserve", () => {
  assert.equal(totalBytesWithReserve({ sizeBytes: 100, kvBytes: 50 }), 150 + RUNTIME_RESERVE_BYTES);
  assert.equal(totalBytesWithReserve({ sizeBytes: 0, kvBytes: 0 }), RUNTIME_RESERVE_BYTES);
  assert.equal(totalBytesWithReserve({ sizeBytes: -5, kvBytes: -5 }), RUNTIME_RESERVE_BYTES);
});

test("recommendModels memoryBytes respects the fixed-bytes rule", () => {
  const shape = { layers: 24, kvHeads: 2, headDim: 64 };
  const contextSize = 2048;
  const perToken = kvBytesPerToken(shape, "f16");
  const rows = recommendModels({
    models: [{ id: "shaped", name: "shaped", fileName: "shaped.gguf", profileId: "shaped", size: 200_000_000, kvShape: shape }],
    profiles: {},
    memory: { free: 4 * 1024 ** 3 },
    task: "code",
  });
  assert.equal(rows[0].memoryBytes, 200_000_000 + perToken * contextSize + RUNTIME_RESERVE_BYTES);

  const flat = recommendModels({
    models: [{ id: "flat", name: "flat", fileName: "flat.gguf", profileId: "flat", size: 1_000_000_000 }],
    profiles: {},
    memory: { free: 4 * 1024 ** 3 },
    task: "code",
  });
  assert.equal(flat[0].memoryBytes, 1_000_000_000 + RUNTIME_RESERVE_BYTES);
});

test("recommendCatalog totals are fixed bytes and Q5 discloses its overhead", () => {
  const rows = recommendCatalog({
    catalog: [{ id: "a", name: "A", size: 500_000_000 }],
    installed: [],
    memory: { free: 4 * 1024 ** 3 },
  });
  assert.equal(rows[0].totalBytes, 500_000_000 + RUNTIME_RESERVE_BYTES);

  const q5 = MODEL_CATALOG.find((model) => model.quant === "Q5_K_M");
  assert.ok(q5, "a Q5 entry is cataloged");
  const copy = `${q5.tagline ?? ""} ${q5.note ?? ""}`;
  assert.match(copy, /overhead|fixed bytes/i);
  assert.ok(copy.includes("522,186,592") && copy.includes("491,400,032"));
});

// IDEA-1618: Q4_K_M drift disclosure (docs-only catalog copy).

test("every Q4_K_M entry discloses expected drift", () => {
  const q4 = MODEL_CATALOG.filter((model) => model.quant === "Q4_K_M");
  assert.ok(q4.length > 0);
  for (const model of q4) {
    assert.match(`${model.tagline ?? ""} ${model.note ?? ""}`, /drift|lossy/i, model.id);
  }
  assert.match(`${QUANT_HONESTY_NOTES.q4Drift}`, /drift/i);
});

// IDEA-1621: imatrix disclosure (docs-only catalog copy).

test("the catalog distinguishes Q4 from Q2 imatrix value", () => {
  const text = JSON.stringify(MODEL_CATALOG);
  assert.match(text, /imatrix/i);
  const q4 = MODEL_CATALOG.filter((model) => model.quant === "Q4_K_M");
  assert.ok(q4.some((model) => /imatrix/i.test(model.note ?? "")), "a Q4 note names imatrix");
  assert.ok(q4.some((model) => /Q2/i.test(model.note ?? "")), "a Q4 note names Q2");
  assert.match(`${QUANT_HONESTY_NOTES.imatrix}`, /imatrix/i);
});
