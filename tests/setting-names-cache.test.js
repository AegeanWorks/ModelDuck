import assert from "node:assert/strict";
import test from "node:test";

import { settingNames, settingNamesComputations } from "../benchmarks/tune-grid.mjs";

test("the static setting-name array is built once", () => {
  const before = settingNamesComputations();
  const first = settingNames();
  const second = settingNames();
  assert.deepEqual(second, first);
  assert.equal(settingNamesComputations(), before + 1, "the fixed array is computed once");
  assert.notEqual(second, first, "a fresh array is returned to callers");
});

test("the cached names keep their stage order and expected content", () => {
  const names = settingNames();
  assert.equal(names[0], "device");
  for (const name of ["kvCache", "flashAttention", "useMmap", "batchSize", "threads", "checkpointing", "sampler", "maxTokens", "repeatPenalty", "dry", "penalizeNewLine", "topK", "systemPrompt", "reasoning", "promptRepeat"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.ok(!names.includes("contextSize"));
  names.push("tamper");
  assert.ok(!settingNames().includes("tamper"), "a caller cannot mutate the cached names");
});
