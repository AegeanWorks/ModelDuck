import assert from "node:assert/strict";
import test from "node:test";

import { kvShapeFromMetadata } from "../src/memory-fit.js";

const reference = (m) => {
  const layers = Number(m?.block_count);
  const heads = Number(m?.attention?.head_count);
  const kvHeads = Number(m?.attention?.head_count_kv ?? heads);
  const keyLength = Number(m?.attention?.key_length);
  const headDim = keyLength || Number(m?.embedding_length) / heads;
  const shape = { layers, kvHeads, headDim };
  return Object.values(shape).every((v) => Number.isFinite(v) && v > 0) ? shape : null;
};

test("kvShapeFromMetadata matches the reference across metadata shapes", () => {
  const cases = [
    {},
    { block_count: 32, attention: { head_count: 8, head_count_kv: 4, key_length: 128 } },
    { block_count: 12, attention: { head_count: 6 }, embedding_length: 2048 },
    { block_count: 0, attention: { head_count: 8, key_length: 128 } },
    { block_count: 4, attention: { head_count: 0, key_length: 0 }, embedding_length: 0 },
    { block_count: 4, attention: { head_count: 2, head_count_kv: -1, key_length: 64 } },
  ];
  for (const metadata of cases) {
    assert.deepEqual(kvShapeFromMetadata(metadata), reference(metadata));
  }
});
