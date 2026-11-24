import assert from "node:assert/strict";
import test from "node:test";

import { PROMPTS } from "../benchmarks/suite.mjs";
import { TASKS } from "../benchmarks/task-ids.mjs";
import { speedItems, taskPrompts } from "../benchmarks/tasks.mjs";

test("speedItems keeps the same round-robin selection", () => {
  // Reference: the original shift-based deal over family buckets.
  const bucketKey = (p) => `${p.category}/${p.group ?? p.source?.dataset ?? "own"}`;
  const stratified = (prompts) => {
    const buckets = new Map();
    for (const p of prompts) {
      const key = bucketKey(p);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p.id);
    }
    const queues = [...buckets.values()];
    const order = [];
    while (order.length < prompts.length) {
      for (const queue of queues) if (queue.length) order.push(queue.shift());
    }
    return order;
  };
  const reference = () => {
    const order = (taskId) => stratified(taskPrompts(taskId, PROMPTS).filter((p) => !p.longContext));
    return [
      ...TASKS.map((task) => order(task.id)[0]),
      order("code")[1], order("comprehension")[1], order("recall")[1],
    ].filter((id) => typeof id === "string");
  };
  assert.deepEqual(speedItems(), reference());
});

test("speedItems does not shift bucket queues", () => {
  const real = Array.prototype.shift;
  let shifts = 0;
  Array.prototype.shift = function (...args) { shifts += 1; return real.apply(this, args); };
  let out;
  try {
    out = speedItems();
  } finally {
    Array.prototype.shift = real;
  }
  assert.equal(out.length, 6);
  assert.equal(shifts, 0, "round robin uses cursors, not Array.shift");
});
