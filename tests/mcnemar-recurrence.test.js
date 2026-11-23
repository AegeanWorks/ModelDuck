import assert from "node:assert/strict";
import test from "node:test";

import { mcnemarExact, mcnemarLogStepCount, mcnemarOneSided } from "../benchmarks/stats.mjs";

function logChoose(n, k) { let sum = 0; for (let i = 1; i <= k; i += 1) sum += Math.log(n - k + i) - Math.log(i); return sum; }
function referenceExact(b, c) {
  const n = b + c; if (n === 0) return 1; const k = Math.min(b, c); let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}
function referenceOneSided(b, c) {
  const n = b + c; if (n === 0) return 1; let tail = 0;
  for (let i = 0; i <= c; i += 1) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, tail);
}

test("the binomial tail uses one log step per index", () => {
  const before = mcnemarLogStepCount();
  mcnemarExact(100, 300);
  assert.equal(mcnemarLogStepCount(), before + 100, "one step per index up to min(b,c)");
});

test("McNemar p-values match the direct logChoose sum", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  for (const [b, c] of [[0, 0], [1, 2], [3, 7], [10, 20], [50, 50], [200, 150], [500, 300]]) {
    close(mcnemarExact(b, c), referenceExact(b, c));
    close(mcnemarOneSided(b, c), referenceOneSided(b, c));
  }
});
