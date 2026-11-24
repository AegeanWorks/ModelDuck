import assert from "node:assert/strict";
import test from "node:test";

import { parameterCount } from "../src/model-registry.js";

const reference = (info) => {
  let total = 0n;
  for (const tensor of info?.tensorInfo ?? []) {
    let elements = 1n;
    for (const dimension of tensor.dimensions ?? []) elements *= BigInt(dimension);
    total += elements;
  }
  return total;
};

test("parameterCount matches the BigInt reference on ordinary and edge shapes", () => {
  const cases = [
    { tensorInfo: [] },
    { tensorInfo: [{ dimensions: [2, 3, 4] }] },
    { tensorInfo: Array.from({ length: 400 }, () => ({ dimensions: [4096, 4096] })) },
    { tensorInfo: [{ dimensions: ["2048", 1024] }] },
    { tensorInfo: [{ dimensions: [Number.MAX_SAFE_INTEGER, 2] }] },
    { tensorInfo: [{ dimensions: [3, 4] }, { dimensions: [Number.MAX_SAFE_INTEGER, 1] }] },
  ];
  for (const info of cases) assert.equal(parameterCount(info), reference(info));
});

test("parameterCount does not call BigInt per dimension", () => {
  const info = { tensorInfo: Array.from({ length: 200 }, () => ({ dimensions: [4096, 4096] })) };
  const real = globalThis.BigInt;
  let calls = 0;
  globalThis.BigInt = (...args) => { calls += 1; return real(...args); };
  let out;
  try {
    out = parameterCount(info);
  } finally {
    globalThis.BigInt = real;
  }
  assert.equal(out, reference(info));
  assert.equal(calls, 1, "one final conversion, not one per dimension");
});
