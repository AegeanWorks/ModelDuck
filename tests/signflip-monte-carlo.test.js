import assert from "node:assert/strict";
import test from "node:test";

import { monteCarloDrawCount, resetSignPatternCounter, signFlipOneSided, signFlipPatternBuilds, signFlipPValue } from "../benchmarks/stats.mjs";

const DIFFS = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 0.25 : i % 5 === 0 ? -0.125 : 0.0625));

test("Monte Carlo uses one seeded draw per value per permutation", () => {
  const before = monteCarloDrawCount();
  signFlipPValue(DIFFS, { permutations: 50 });
  assert.equal(monteCarloDrawCount(), before + 50 * DIFFS.length);
});

test("Monte Carlo p-values match the seeded reference sequence", () => {
  function reference(diffs, oneSided, permutations) {
    const nz = diffs.filter((v) => v !== 0);
    const observed = oneSided ? nz.reduce((a, b) => a + b, 0) : Math.abs(nz.reduce((a, b) => a + b, 0));
    let state = 0x5EED;
    let extreme = 0;
    for (let draw = 0; draw < permutations; draw += 1) {
      let sum = 0;
      for (const v of nz) {
        state = (state * 1664525 + 1013904223) >>> 0;
        sum += state / 2 ** 32 < 0.5 ? v : -v;
      }
      if (oneSided ? sum <= observed + 1e-12 : Math.abs(sum) >= observed - 1e-12) extreme += 1;
    }
    return extreme / permutations;
  }
  assert.equal(signFlipPValue(DIFFS, { permutations: 200 }), reference(DIFFS, false, 200));
  assert.equal(signFlipOneSided(DIFFS, { permutations: 200 }), reference(DIFFS, true, 200));
});

test("the seeded sign pattern is built once per count and permutation width", () => {
  resetSignPatternCounter();
  const patternDiffs = Array.from({ length: 31 }, (_, index) => (index % 3 === 0 ? 0.25 : index % 5 === 0 ? -0.125 : 0.0625));
  const other = patternDiffs.map((value, index) => (index % 4 === 0 ? value + 0.01 : value));
  const drawsBefore = monteCarloDrawCount();
  signFlipPValue(patternDiffs, { permutations: 201 });
  assert.equal(signFlipPatternBuilds(), 1);
  signFlipPValue(other, { permutations: 201 });
  assert.equal(signFlipPatternBuilds(), 1, "a different value vector reuses the same sign table");
  assert.equal(signFlipPValue(other, { permutations: 401 }), reference(other, false, 401));
  assert.equal(signFlipPatternBuilds(), 2, "a new permutation width builds its own table");
  assert.equal(monteCarloDrawCount(), drawsBefore + (201 + 201 + 401) * patternDiffs.length, "logical draw counts stay exact");
  function reference(diffs, oneSided, permutations) {
    const nz = diffs.filter((value) => value !== 0);
    const observed = oneSided ? nz.reduce((a, b) => a + b, 0) : Math.abs(nz.reduce((a, b) => a + b, 0));
    let state = 0x5EED;
    let extreme = 0;
    for (let draw = 0; draw < permutations; draw += 1) {
      let sum = 0;
      for (const value of nz) {
        state = (state * 1664525 + 1013904223) >>> 0;
        sum += state / 2 ** 32 < 0.5 ? value : -value;
      }
      if (oneSided ? sum <= observed + 1e-12 : Math.abs(sum) >= observed - 1e-12) extreme += 1;
    }
    return extreme / permutations;
  }
});
