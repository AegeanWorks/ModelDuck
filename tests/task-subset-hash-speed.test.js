import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PROMPTS, SUITE_VERSION } from "../benchmarks/suite.mjs";
import { HOLDOUT_SHARE, taskPrompts, TASK_RUNGS, TASKS } from "../benchmarks/tasks.mjs";
import { resetTaskSubsetHash, taskSubsetHash, taskSubsetHashComputations } from "../benchmarks/tasks.mjs";

test("the memoized hash is byte-identical to the original definition hash", () => {
  resetTaskSubsetHash();
  const definition = {
    suiteVersion: SUITE_VERSION,
    rungs: TASK_RUNGS,
    holdout: HOLDOUT_SHARE,
    tasks: TASKS.map((task) => ({ id: task.id, items: taskPrompts(task.id, PROMPTS) })),
  };
  const expected = createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
  assert.equal(taskSubsetHash(), expected);
});

test("the frozen suite is hashed once and reused", () => {
  resetTaskSubsetHash();
  assert.equal(taskSubsetHashComputations(), 0);
  const first = taskSubsetHash();
  assert.equal(taskSubsetHashComputations(), 1);
  for (let i = 0; i < 20; i += 1) assert.equal(taskSubsetHash(), first);
  assert.equal(taskSubsetHashComputations(), 1);
});

test("a different prompt array still gets its own hash", () => {
  resetTaskSubsetHash();
  const standard = taskSubsetHash();
  assert.equal(taskSubsetHash(PROMPTS), standard, "the same array is the same suite");
  const custom = taskSubsetHash([]);
  assert.notEqual(custom, standard);
  assert.equal(taskSubsetHashComputations(), 2);
  assert.equal(taskSubsetHash([]), custom, "each distinct array is memoized");
});
