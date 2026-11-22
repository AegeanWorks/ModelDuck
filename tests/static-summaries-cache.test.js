import assert from "node:assert/strict";
import test from "node:test";

import { suiteSummary, suiteSummaryComputations } from "../benchmarks/tasks.mjs";
import { multistepSummary, multistepSummaryComputations } from "../benchmarks/multistep-items.mjs";
import { MULTISTEP_CHAINS } from "../benchmarks/multistep-items.mjs";
import { PROMPTS } from "../benchmarks/suite.mjs";

test("the default suite summary is built once", () => {
  const before = suiteSummaryComputations();
  const first = suiteSummary();
  assert.deepEqual(suiteSummary(), first);
  assert.equal(suiteSummaryComputations(), before + 1);
  assert.ok(suiteSummaryComputations() - before >= 1);
});

test("a custom prompt list still gets its own summary", () => {
  const subset = PROMPTS.slice(0, 1);
  const before = suiteSummaryComputations();
  const custom = suiteSummary(subset);
  assert.notDeepEqual(custom, suiteSummary());
  assert.equal(suiteSummaryComputations(), before + 1, "the custom list is computed once");
  assert.deepEqual(suiteSummary(subset), custom);
  assert.equal(suiteSummaryComputations(), before + 1, "reused on the next call");
});

test("the default multistep summary is built once", () => {
  const before = multistepSummaryComputations();
  const first = multistepSummary();
  assert.deepEqual(multistepSummary(), first);
  assert.equal(multistepSummaryComputations(), before + 1);
  const other = multistepSummary(MULTISTEP_CHAINS.slice(0, 1));
  assert.notDeepEqual(other, first);
});
