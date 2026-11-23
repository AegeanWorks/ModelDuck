import assert from "node:assert/strict";
import test from "node:test";

import { signFlipMaskCount, signFlipOneSided, signFlipPValue } from "../benchmarks/stats.mjs";

test("exact enumeration uses the O(1) per-mask recurrence", () => {
  const diffs = [0.1, -0.2, 0.3, 0.4, -0.5, 0.2];
  const before = signFlipMaskCount();
  signFlipPValue(diffs);
  assert.equal(signFlipMaskCount(), before + 2 ** 6, "one operation per mask, not count per mask");
});

test("exact sign-flip p-values match the direct enumeration", () => {
  const cases = [
    [0.25, 0.25, 0.25, -0.1],
    [0.1, -0.2, 0.3, 0.4, -0.5],
    Array.from({ length: 12 }, (_, i) => (i % 2 ? -0.125 : 0.25)),
  ];
  const reference = (diffs) => {
    const nz = diffs.filter((v) => v !== 0);
    const observed = Math.abs(nz.reduce((a, b) => a + b, 0));
    let extreme = 0;
    for (let mask = 0; mask < 2 ** nz.length; mask += 1) {
      let sum = 0;
      for (let i = 0; i < nz.length; i += 1) sum += (mask >> i) & 1 ? nz[i] : -nz[i];
      if (Math.abs(sum) >= observed - 1e-12) extreme += 1;
    }
    return extreme / 2 ** nz.length;
  };
  for (const diffs of cases) {
    assert.equal(signFlipPValue(diffs), reference(diffs));
  }
});

test("one-sided exact path still matches a direct enumeration", () => {
  const diffs = [0.2, -0.3, 0.4, -0.1, 0.5, -0.2, 0.3, -0.4];
  const nz = diffs.filter((v) => v !== 0);
  const observed = nz.reduce((a, b) => a + b, 0);
  let extreme = 0;
  for (let mask = 0; mask < 2 ** nz.length; mask += 1) {
    let sum = 0;
    for (let i = 0; i < nz.length; i += 1) sum += (mask >> i) & 1 ? nz[i] : -nz[i];
    if (sum <= observed + 1e-12) extreme += 1;
  }
  assert.equal(signFlipOneSided(diffs), extreme / 2 ** nz.length);
});
