import assert from "node:assert/strict";
import test from "node:test";

import { buildChatMatrix, modelMatrix, parseShardSpec, shardMatrix } from "../benchmarks/matrix.mjs";

test("parseShardSpec accepts i/n and rejects junk", () => {
  assert.deepEqual(parseShardSpec("2/4"), { index: 2, total: 4 });
  assert.deepEqual(parseShardSpec(" 1 / 3 "), { index: 1, total: 3 });
  for (const bad of ["", "2", "0/3", "4/3", "a/b", "1/0"]) {
    assert.throws(() => parseShardSpec(bad), /Bad shard/, JSON.stringify(bad));
  }
});

test("shards cover every variant exactly once", () => {
  const matrix = modelMatrix();
  const total = 3;
  const shards = [1, 2, 3].map((index) => shardMatrix(matrix, index, total));
  const all = shards.flat();
  assert.equal(all.length, matrix.length);
  assert.equal(new Set(all.map((spec) => spec.id)).size, matrix.length);
  assert.deepEqual(
    all.map((spec) => spec.id).sort(),
    matrix.map((spec) => spec.id).sort(),
  );
});

test("one model's reload variants stay in the same shard", () => {
  const matrix = modelMatrix();
  const total = 3;
  const byCatalog = new Map();
  for (let index = 1; index <= total; index += 1) {
    const ids = new Set(shardMatrix(matrix, index, total).map((spec) => spec.id));
    for (const spec of matrix) {
      if (!ids.has(spec.id)) continue;
      const key = spec.catalogId;
      if (!byCatalog.has(key)) byCatalog.set(key, index);
      assert.equal(byCatalog.get(key), index, `${spec.id} split across shards`);
    }
  }
});

test("sharding is deterministic and keeps matrix order", () => {
  const matrix = modelMatrix();
  const first = shardMatrix(matrix, 1, 2).map((spec) => spec.id);
  const second = shardMatrix(matrix, 1, 2).map((spec) => spec.id);
  assert.deepEqual(first, second);
  const order = new Map(matrix.map((spec, at) => [spec.id, at]));
  const positions = first.map((id) => order.get(id));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("a single shard (1/1) is the whole matrix", () => {
  const matrix = modelMatrix({ full: true });
  assert.deepEqual(
    shardMatrix(matrix, 1, 1).map((spec) => spec.id),
    matrix.map((spec) => spec.id),
  );
});

test("chat variants (one shared model file) still split across shards", () => {
  const matrix = buildChatMatrix();
  assert.ok(matrix.length > 3, "chat matrix has several variants on one file");
  const shards = [1, 2, 3].map((index) => shardMatrix(matrix, index, 3));
  for (const shard of shards) assert.ok(shard.length > 0, "no shard is empty");
  const all = shards.flat();
  assert.equal(all.length, matrix.length);
  assert.equal(new Set(all.map((spec) => spec.id)).size, matrix.length);
});
