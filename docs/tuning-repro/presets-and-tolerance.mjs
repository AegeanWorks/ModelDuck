// Findings D2 and D6: Light/Quiet when lower thread counts change an answer digest, and how the
// one-item tolerance behaves once rates are rounded to one decimal.
//   node docs/tuning-repro/presets-and-tolerance.mjs
import { tune } from "../../benchmarks/tune.mjs";

const ids = (prefix, count) => Array.from({ length: count }, (_v, i) => `${prefix}-${i}`);

const speed = await tune({
  evaluate: async (settings, itemIds) => ({ prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 1000 / Math.min(settings.threads, 8) + 5, tokensPerSecond: 10, outputTokens: 50, digest: id === "speed-3" && settings.threads < 8 ? `alt-${settings.threads}` : id })) }),
  base: { threads: 8, batchSize: 512, flashAttention: "auto", temperature: 0, maxTokens: 256 },
  tasks: [], stages: ["speed"], rungs: { speed: [ids("speed", 6)], load: [[]] }, hardware: { logicalCores: 12 },
  speedAxes: [{ name: "threads", patches: [1, 2, 4, 8].map((threads) => ({ threads })) }],
});
console.log(`Light/Quiet: Fastest ${speed.speed.fastest.threads} · Light ${speed.speed.light.threads} · Quiet ${speed.speed.quiet.threads} threads (measured: 1,2,4,8)`);

async function trial({ size, temperature, lostSeeds }) {
  const items = ids("code", size);
  const out = await tune({
    evaluate: async (settings, itemIds, seed) => ({ prompts: itemIds.map((id) => {
      const lost = id === items.at(-1) && settings.maxTokens < 512 && lostSeeds.includes(seed);
      return { id, passed: lost ? 0 : 1, total: 1, ms: 100, tokensPerSecond: 10, outputTokens: Math.min(settings.maxTokens, 400) * (0.5 + (Number(id.split("-")[1]) % 7) / 10), digest: "d" };
    }) }),
    base: { temperature, maxTokens: 512 }, tasks: ["code"], stages: ["sampling"],
    rungs: { code: size === 12 ? [items] : [items.slice(0, 12), items.slice(0, 24), items], load: [[]], speed: [[]], holdout: {} },
    samplingAxes: () => [{ name: "maxTokens", patches: [256, 512].map((maxTokens) => ({ maxTokens })) }],
  });
  const sweep = out.sweeps.find((entry) => entry.axis === "maxTokens");
  return `${String(size).padStart(2)} items, T=${temperature}, last item lost on ${lostSeeds.length}/${temperature > 0 ? 3 : 1} seed(s): chose maxTokens ${out.tasks.code.settings.maxTokens} (incumbent 512), paired p=${sweep.pValue}`;
}
console.log(await trial({ size: 12, temperature: 0, lostSeeds: [42] }));
console.log(await trial({ size: 24, temperature: 0, lostSeeds: [42] }));
console.log(await trial({ size: 48, temperature: 0, lostSeeds: [42] }));
console.log(await trial({ size: 48, temperature: 0.7, lostSeeds: [42, 7] }));
for (const n of [12, 24, 46, 48]) {
  const rate = Number((((n - 1) / n) * 100).toFixed(1));
  const floor = 100 - 100 / n;
  console.log(`n=${n}: one item lost -> rounded rate ${rate} vs floor ${floor.toFixed(4)} -> ${rate >= floor ? "inside" : "outside"} the tolerance`);
}
