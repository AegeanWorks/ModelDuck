import assert from "node:assert/strict";
import test from "node:test";

import { recommend, smokeLookupCount } from "../benchmarks/recommend.mjs";

function result(lostIds = []) {
  const base = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, passed: 3, total: 3 }));
  const smokeBase = base.slice(0, 30);
  const fast = smokeBase.map((p) => ({ ...p, passed: lostIds.includes(p.id) ? 2 : 3 }));
  return {
    suiteVersion: 1,
    models: [
      { variantId: "m-f16", key: "m", catalogId: "m", label: "M · f16", items: { total: 60, rate: 90 }, prompts: base, tokensPerSecond: 20 },
      { variantId: "m-fast", key: "m", catalogId: "m", label: "M · fast", items: { total: 30, rate: 90 }, prompts: fast, tokensPerSecond: 40 },
    ],
  };
}

test("smoke comparison builds one id map rather than rescanning", () => {
  const before = smokeLookupCount();
  recommend(result());
  assert.equal(smokeLookupCount(), before + 30, "one map of 30 variant prompts");
});

test("a smoke variant that lost a base item is not recommended", () => {
  const kept = recommend(result());
  assert.equal(kept.speedTuning?.variantId, "m-fast", "all items kept: faster variant wins");
  const lost = recommend(result(["p3"]));
  assert.equal(lost.speedTuning, null, "one lost item: no speed tuning");
});
