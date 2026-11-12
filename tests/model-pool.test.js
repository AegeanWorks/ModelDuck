import assert from "node:assert/strict";
import test from "node:test";

import { runPool } from "../benchmarks/model-pool.mjs";

// The gate measures its independent models through a bounded pool. Each model
// keeps its own engine and its own cache write, so the pool only bounds
// concurrency and preserves input order.

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test("runPool runs the requested number of workers at a time and drains in order", async () => {
  const gate = [];
  const waiting = new Map();
  const worker = (item) => {
    gate.push(`start:${item}`);
    const hold = deferred();
    waiting.set(item, hold);
    return hold.promise.then(() => {
      gate.push(`end:${item}`);
      return item.toUpperCase();
    });
  };

  // One microtask pair lets each released chain run its callback and the lane's claim.
  const settle = () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const all = runPool(["a", "b", "c", "d"], worker, 2);
  await settle(); // lanes have synchronously claimed their items
  assert.deepEqual(gate, ["start:a", "start:b"]); // exactly two lanes opened

  waiting.get("a").release();
  await settle();
  assert.deepEqual(gate, ["start:a", "start:b", "end:a", "start:c"]); // a lane freed, c began

  waiting.get("b").release();
  await settle();
  assert.deepEqual(gate, ["start:a", "start:b", "end:a", "start:c", "end:b", "start:d"]);

  waiting.get("c").release();
  waiting.get("d").release();
  const results = await all;
  assert.deepEqual(results, ["A", "B", "C", "D"]); // input order preserved, not completion order
  assert.deepEqual(gate, [
    "start:a", "start:b", "end:a", "start:c", "end:b", "start:d", "end:c", "end:d",
  ]);
});

test("runPool with width 1 is exactly the sequential loop", async () => {
  const gate = [];
  const results = await runPool([1, 2, 3], async (item) => {
    gate.push(item);
    return item * 2;
  }, 1);
  assert.deepEqual(results, [2, 4, 6]);
  assert.deepEqual(gate, [1, 2, 3]);
});

test("runPool never runs more workers than there are items and rejects when a worker throws", async () => {
  const gate = [];
  await assert.rejects(
    () => runPool(["x"], async (item) => { gate.push(item); throw new Error("boom"); }, 4),
    /boom/,
  );
  assert.deepEqual(gate, ["x"]); // width is capped at the item count
});

test("runPool clamps a non-numeric width back to one lane", async () => {
  const gate = [];
  await runPool([1, 2], async (item) => { gate.push(item); return item; }, "nan");
  assert.deepEqual(gate, [1, 2]); // one lane: strict order despite width garbage
});
