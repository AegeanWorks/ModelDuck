import assert from "node:assert/strict";
import test from "node:test";

import { shardFiles } from "../scripts/test-parallel.mjs";

const files = ["a.test.js", "b.test.js", "c.test.js", "d.test.js", "e.test.js"];

test("shardFiles covers every file exactly once", () => {
  const shards = shardFiles(files, 3);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
});

test("shardFiles is deterministic", () => {
  assert.deepEqual(shardFiles(files, 2), shardFiles(files, 2));
});

test("more shards than files leaves empty shards", () => {
  const shards = shardFiles(["only.test.js"], 4);
  assert.equal(shards.flat().length, 1);
  assert.equal(shards.filter((shard) => shard.length).length, 1);
});

test("single shard keeps the sorted input order", () => {
  assert.deepEqual(shardFiles(files, 1), [files]);
});
