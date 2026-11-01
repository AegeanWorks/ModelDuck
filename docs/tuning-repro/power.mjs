// Section 4.1: power and false-change rate of one sampling axis, through the real tune() code.
//   node docs/tuning-repro/power.mjs [simulations=400]
// 6 values, the incumbent is value 0, value 3 is truly better by `gain` points (or not).
// Items: 30% near-always-fail, 30% near-always-pass, 40% discriminating (p in 0.2..0.8),
// answered at temperature 0.7 with the default 3 seeds and majority vote, as the tuner does.
import { tune } from "../../benchmarks/tune.mjs";

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const uniform = (key) => { let t = (fnv(key) + 0x6d2b79f5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function makeItems(sim, count) {
  return Array.from({ length: count }, (_v, i) => {
    const u = uniform(`kind|${sim}|${i}`);
    const p = u < 0.3 ? 0.02 : u < 0.6 ? 0.98 : 0.2 + 0.6 * uniform(`p|${sim}|${i}`);
    return { id: `item-${i}`, p };
  });
}
// A logit shift on discriminating items that yields about `gain` points on the whole set.
function shiftFor(gain) {
  if (gain === 0) return 0;
  let lo = 0, hi = 5;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2; let g = 0, n = 0;
    for (let j = 0; j < 400; j++) { const p = 0.2 + 0.6 * (j + 0.5) / 400; g += sigmoid(logit(p) + mid) - p; n++; }
    (0.4 * g / n * 100 < gain) ? (lo = mid) : (hi = mid);
  }
  return (lo + hi) / 2;
}

async function once(sim, { gain, sizes, costlyBest = false }) {
  const pool = makeItems(sim, sizes.at(-1));
  const byId = new Map(pool.map((item) => [item.id, item]));
  const shift = shiftFor(gain);
  const evaluate = async (settings, itemIds, seed) => ({
    prompts: itemIds.map((id) => {
      const item = byId.get(id);
      const discriminating = item.p > 0.05 && item.p < 0.95;
      const p = settings.x === 3 && discriminating ? sigmoid(logit(item.p) + shift) : item.p;
      const passed = uniform(`ans|${sim}|${settings.x}|${id}|${seed}`) < p;
      return { id, passed: passed ? 1 : 0, total: 1, ms: 100, outputTokens: costlyBest && settings.x === 3 ? 400 : 200, tokensPerSecond: 10, digest: "d" };
    }),
  });
  const ids = pool.map((item) => item.id);
  const rungs = { t: sizes.map((size) => ids.slice(0, size)), load: [[]], speed: [[]], holdout: {} };
  const result = await tune({
    evaluate, base: { temperature: 0.7, x: 0 }, tasks: ["t"], rungs, stages: ["sampling"],
    samplingAxes: () => [{ name: "x", patches: [0, 1, 2, 3, 4, 5].map((x) => ({ x })) }],
    promptAxes: [], qualityAxes: [], speedAxes: [],
  });
  const sweep = result.sweeps.find((s) => s.axis === "x");
  return { winner: result.tasks.t?.settings?.x ?? 0, changed: Boolean(sweep?.changed), answers: result.runs, survivedRung1: sweep.rungs.length > 1 && sweep.rungs[1].candidates.some((c) => c.patch.x === 3) };
}

const SIMS = Number(process.argv[2] ?? 400);
const rows = [];
for (const sizes of [[12, 24, 48], [12, 24, 48, 96]]) {
  for (const gain of [0, 5, 10, 15]) {
    for (const costlyBest of gain ? [false, true] : [false]) {
      let picked = 0, changedWrong = 0, answers = 0, survived = 0;
      for (let sim = 0; sim < SIMS; sim++) {
        const r = await once(sim, { gain, sizes, costlyBest });
        if (gain && r.winner === 3) picked++;
        if (r.changed && r.winner !== 3) changedWrong++;
        if (!gain && r.changed) changedWrong += 0; // counted above
        answers += r.answers; if (r.survivedRung1) survived++;
      }
      rows.push({ rungs: sizes.join("/"), gain: `+${gain} pts`, bestCostsMore: costlyBest, pickTrueBest: gain ? `${(100 * picked / SIMS).toFixed(1)}%` : "-", wrongChange: `${(100 * changedWrong / SIMS).toFixed(1)}%`, bestReachedRung2: gain ? `${(100 * survived / SIMS).toFixed(1)}%` : "-", answersPerSweep: Math.round(answers / SIMS) });
    }
  }
}
console.table(rows);
