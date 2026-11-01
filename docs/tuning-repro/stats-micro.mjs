// Sections 4.2, 4.4 and 4.5: majority vote vs seed fractions, held-back fallback rate, clustered items.
//   node docs/tuning-repro/stats-micro.mjs
import { mcnemarExact } from "../../benchmarks/stats.mjs";

let state = 12345;
const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const SIMS = 4000;

function itemP(discriminatingShare) {
  const u = rand();
  if (u < discriminatingShare) return 0.2 + 0.6 * rand();
  return u < discriminatingShare + (1 - discriminatingShare) / 2 ? 0.02 : 0.98;
}
function shiftFor(gain, share) {
  let lo = 0, hi = 6;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2; let g = 0;
    for (let j = 0; j < 400; j++) { const p = 0.2 + 0.6 * (j + 0.5) / 400; g += sigmoid(logit(p) + mid) - p; }
    (share * g / 400 * 100 < gain) ? (lo = mid) : (hi = mid);
  }
  return (lo + hi) / 2;
}
// Per item: fraction of 3 seeds passed, for incumbent and challenger.
function draw(n, gain, share, seeds = 3) {
  const shift = shiftFor(gain, share);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const p = itemP(share);
    const disc = p > 0.05 && p < 0.95;
    const q = disc ? sigmoid(logit(p) + shift) : p;
    let a = 0, b = 0;
    for (let s = 0; s < seeds; s++) { if (rand() < p) a++; if (rand() < q) b++; }
    rows.push([a / seeds, b / seeds]);
  }
  return rows;
}
// (a) The tuner's rule: exact McNemar on the majority vote, c > b and two-sided p <= alpha.
function mcnemarMajority(rows, alpha) {
  let b = 0, c = 0;
  for (const [x, y] of rows) { const X = x >= 0.5, Y = y >= 0.5; if (X && !Y) b++; if (!X && Y) c++; }
  return c > b && mcnemarExact(b, c) <= alpha;
}
// (b) Alternative: one-sided paired sign-flip permutation test on the per-item seed fractions.
function signFlip(rows, alphaOneSided, draws = 2000) {
  const d = rows.map(([x, y]) => y - x).filter((v) => v !== 0);
  if (!d.length) return false;
  const obs = d.reduce((s, v) => s + v, 0);
  let extreme = 0;
  for (let k = 0; k < draws; k++) { let t = 0; for (const v of d) t += rand() < 0.5 ? v : -v; if (t >= obs) extreme++; }
  return (extreme + 1) / (draws + 1) <= alphaOneSided;
}

console.log("1) Binarizing 3 seeds by majority vote vs using the fractions (48 items, one challenger)");
const t1 = [];
for (const share of [0.4, 1.0]) for (const gain of [0, 5, 10]) {
  let a = 0, b = 0;
  for (let s = 0; s < SIMS; s++) { const rows = draw(48, gain, share); if (mcnemarMajority(rows, 0.2)) a++; if (signFlip(rows, 0.1, 600)) b++; }
  t1.push({ discriminatingItems: `${share * 100}%`, trueGain: `+${gain} pts`, "McNemar on majority (current)": `${(100 * a / SIMS).toFixed(1)}%`, "sign-flip on fractions": `${(100 * b / SIMS).toFixed(1)}%` });
}
console.table(t1);

console.log("\n2) Held-back check: how often a preset falls back to the defaults (rule: preset rate < default rate)");
const t2 = [];
for (const n of [16, 35]) for (const gain of [0, 5, 10]) {
  let fell = 0;
  for (let s = 0; s < SIMS; s++) {
    const rows = draw(n, gain, 0.4);
    const rate = (k) => rows.reduce((sum, r) => sum + r[k], 0) / n;
    if (rate(1) < rate(0)) fell++;
  }
  t2.push({ heldBackItems: n, presetTrueGain: `+${gain} pts`, fellBack: `${(100 * fell / SIMS).toFixed(1)}%` });
}
console.table(t2);

console.log("\n3) Clustered items (comprehension: 8 functions x 8 inputs), greedy, NO real difference between settings");
const t3 = [];
for (const reroll of [0.15, 0.3]) {
  let p05 = 0, p20 = 0, cluster05 = 0;
  for (let s = 0; s < SIMS; s++) {
    let b = 0, c = 0; const fnDiff = [];
    for (let f = 0; f < 8; f++) {
      const q = 0.2 + 0.6 * rand();
      const u1 = rand() < q; const u2 = rand() < reroll ? rand() < q : u1; // a perturbation re-rolls whether a function is understood
      let fb = 0, fc = 0;
      for (let i = 0; i < 8; i++) {
        const x = rand() < (u1 ? 0.9 : 0.1); const y = rand() < (u2 ? 0.9 : 0.1);
        if (x && !y) fb++; if (!x && y) fc++;
      }
      b += fb; c += fc; fnDiff.push(fc - fb);
    }
    const p = mcnemarExact(b, c);
    if (p <= 0.05) p05++; if (p <= 0.2) p20++;
    // Cluster-level alternative: exact sign test over functions whose net flip is non-zero.
    const pos = fnDiff.filter((v) => v > 0).length, neg = fnDiff.filter((v) => v < 0).length;
    if (mcnemarExact(neg, pos) <= 0.05) cluster05++;
  }
  t3.push({ functionsReRolled: `${reroll * 100}%`, "item McNemar p<=0.05 (nominal 5%)": `${(100 * p05 / SIMS).toFixed(1)}%`, "item McNemar p<=0.20 (nominal 20%)": `${(100 * p20 / SIMS).toFixed(1)}%`, "function-level sign test p<=0.05": `${(100 * cluster05 / SIMS).toFixed(1)}%` });
}
console.table(t3);
