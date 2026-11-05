import assert from "node:assert/strict";
import test from "node:test";

import { isReproShard, mergedOutFile } from "../benchmarks/merge-shards.mjs";

test("a shard counts as repro from its tag or its content", () => {
  assert.equal(isReproShard({ tag: "core-repro", result: {} }), true);
  assert.equal(isReproShard({ tag: "core", result: { reproRun: true } }), true);
  assert.equal(
    isReproShard({ tag: "core", result: { models: [{ deterministicRepro: true }] } }),
    true,
  );
  assert.equal(isReproShard({ tag: "core", result: { models: [{}] } }), false);
  // Corrupt inputs classify as non-repro; main() rejects them earlier with
  // the "not a bench result" validation, so they never reach a merge.
  // null models are not crashes.
  assert.equal(isReproShard({ tag: "core", result: null }), false);
  assert.equal(isReproShard({ tag: "core", result: { models: null } }), false);
  assert.equal(isReproShard({ tag: "core", result: { models: [null] } }), false);
  assert.equal(isReproShard(), false);
});

test("merged output keeps repro runs out of the shared latest files", () => {
  assert.match(
    mergedOutFile({ phase: "model", tag: "core-repro", isRepro: true }),
    /latest-repro-merged-model-core-repro\.json$/,
  );
  assert.match(
    mergedOutFile({ phase: "chat", tag: "core", isRepro: false }),
    /latest-chat\.json$/,
  );
  assert.equal(mergedOutFile({ phase: "model", tag: "x", isRepro: false, out: "custom.json" }), "custom.json");
  assert.throws(
    () => mergedOutFile({ phase: "model", tag: "core-repro", isRepro: true, out: "results/latest-model.json" }),
    /Refusing to write a repro merge/,
  );
  assert.throws(
    () => mergedOutFile({ phase: "model", tag: "core-repro", isRepro: true, out: "results/latest.json" }),
    /Refusing to write a repro merge/,
  );
});
