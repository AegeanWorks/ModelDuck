import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketOf,
  bucketTable,
  checkComparable,
  curveTestHash,
  CURVE_DEFAULTS,
  CURVE_LOAD_KEYS,
  parseVariantSet,
  stampOf,
} from "../benchmarks/context-curve.mjs";

/**
 * Context-curve regression tests: parsing, bucketing and the harness-fixed
 * comparison guard. The live engine path is covered by the smoke run
 * (`--items`), not here — these stay hermetic like the other suite tests.
 */

test("parseVariantSet accepts name:key=value pairs on curve load keys", () => {
  const variant = parseVariantSet("q8:kvCache=q8,contextSize=8192,threads=10");
  assert.equal(variant.name, "q8");
  assert.deepEqual(variant.settings, { kvCache: "q8", contextSize: 8192, threads: 10 });
});

test("parseVariantSet rejects unknown keys and missing values", () => {
  const whyOf = (text) => {
    try {
      parseVariantSet(text);
    } catch (error) {
      return error.why;
    }
    return null;
  };
  assert.match(whyOf("bad") ?? "", /not name:key=value/);
  assert.match(whyOf("x:gpuLayers=4") ?? "", /allowed curve setting/);
  assert.throws(() => parseVariantSet("x:threads=many"), /Bad variant value/);
});

test("curve defaults stay on the CPU lane with greedy sampling", () => {
  assert.equal(CURVE_DEFAULTS.temperature, 0);
  assert.ok(!("gpuLayers" in CURVE_DEFAULTS) && !("gpuBackend" in CURVE_DEFAULTS));
  assert.ok(CURVE_LOAD_KEYS.includes("kvCache") && CURVE_LOAD_KEYS.includes("contextSize"));
});

test("bucketOf splits prompts at 2k and 8k", () => {
  assert.equal(bucketOf(100), "<2k");
  assert.equal(bucketOf(2047), "<2k");
  assert.equal(bucketOf(2048), "2-8k");
  assert.equal(bucketOf(8191), "2-8k");
  assert.equal(bucketOf(8192), "8k+");
  assert.equal(bucketOf(16000), "8k+");
  assert.equal(bucketOf(null), "unknown");
});

test("bucketTable groups outcomes by measured prompt length", () => {
  const stats = {
    outcomes: { short: 1, mid: 0, long: 1 },
    itemPrompt: new Map([["short", 100], ["mid", 5000], ["long", 16000]]),
  };
  const rows = bucketTable(stats);
  assert.deepEqual(rows.map((row) => row.bucket), ["<2k", "2-8k", "8k+"]);
  assert.deepEqual(rows.map((row) => [row.passed, row.items]), [[1, 1], [0, 1], [1, 1]]);
});

test("checkComparable passes when only load settings differ", () => {
  const base = {
    suiteVersion: 14,
    testHash: "abc",
    promptIds: ["a", "b"],
    runtime: { nodeLlamaCpp: "3.22.2", node: "22.0.0" },
    model: { size: 100, chatTemplateHash: "t" },
  };
  assert.equal(checkComparable([stampOf({ prompts: [], itemIds: ["b", "a"], suiteVersion: 14, testHash: "abc", runtime: base.runtime, model: base.model }), base]), true);
});

test("curveTestHash ignores load settings so variants stay comparable", () => {
  const shared = { suiteVersion: 17, prompts: [{ id: "b" }, { id: "a" }], itemIds: ["a", "b"], systemPrompt: "sys", seed: 42 };
  assert.equal(curveTestHash(shared), curveTestHash(shared));
  assert.notEqual(curveTestHash(shared), curveTestHash({ ...shared, seed: 43 }));
  // Load settings are not an input at all: no key carries them.
  assert.equal(curveTestHash({ ...shared, kvCache: "f16" }), curveTestHash({ ...shared, kvCache: "q8" }));
});

test("checkComparable refuses runtime, model and item drift", () => {
  const base = {
    suiteVersion: 14,
    testHash: "abc",
    promptIds: ["a"],
    runtime: { nodeLlamaCpp: "3.22.2", node: "22.0.0" },
    model: { size: 100, chatTemplateHash: "t" },
  };
  const drifted = (patch) => ({ ...base, ...patch });
  const driftWhy = (second) => {
    try {
      checkComparable([base, second]);
    } catch (error) {
      return error.why;
    }
    return null;
  };
  assert.match(driftWhy(drifted({ testHash: "zzz" })) ?? "", /testHash/);
  assert.match(driftWhy(drifted({ promptIds: ["a", "b"] })) ?? "", /item set/);
  assert.match(driftWhy(drifted({ runtime: { nodeLlamaCpp: "3.22.3", node: "22.0.0" } })) ?? "", /node-llama-cpp/);
  assert.match(driftWhy(drifted({ model: { size: 101, chatTemplateHash: "t" } })) ?? "", /model file size/);
  assert.match(driftWhy(drifted({ model: { size: 100, chatTemplateHash: "u" } })) ?? "", /chat template/);
});
