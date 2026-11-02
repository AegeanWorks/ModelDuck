import { costDelta, publicStats, score } from "./tune-measure.mjs";

/**
 * Stage 0 (ADR-031, ADR-066): where does this model run fastest? Measures the
 * fixed speed workload on the CPU and on each GPU backend with every layer
 * offloaded; when that will not load, smaller offloads (three quarters, half,
 * a quarter) are tried in turn, so a model too big for VRAM can still use some
 * GPU layers. A GPU wins only when it is measurably faster and answers at least
 * as many items as the CPU, since its different rounding can change answers.
 */

const CPU = Object.freeze({ gpuBackend: "cpu", gpuLayers: 0 });

// Answers differ slightly between devices, so compare throughput, not time per answer.
const speedOf = (entry) => entry.stats.tokensPerSecond ?? 0;
const passedOf = (entry) => Math.round((entry.stats.rate / 100) * entry.stats.items);

function candidatePatches(backends, layers) {
  const gpus = backends.filter((backend) => backend !== "cpu");
  const smaller = layers > 1
    ? [...new Set([Math.ceil(layers * 0.75), Math.ceil(layers * 0.5), Math.ceil(layers * 0.25)])].filter((count) => count >= 1 && count < layers)
    : [];
  return {
    first: [CPU, ...gpus.map((gpuBackend) => ({ gpuBackend, gpuLayers: "max" }))],
    fallback: (gpuBackend) => smaller.map((gpuLayers) => ({ gpuBackend, gpuLayers })),
  };
}

function summarise(entry, verdict) {
  return { patch: entry.patch, ...publicStats(entry.stats), passed: passedOf(entry), verdict };
}

/**
 * Probe the devices from `start`. Resolves `{ settings, probe, reason, aborted }`;
 * `settings` is `{ gpuBackend, gpuLayers }` for the chosen device. `loadItems`
 * is the larger mixed rung used only when a fast GPU loses one speed item (S7).
 */
const LOAD_RECHECK_MIN = 8;

export async function deviceStage(context, { backends, layers = 0, start, items, forced, loadItems = null }) {
  const { measurements, options } = context;
  const seeds = options.seeds.slice(0, 1);
  const { first, fallback } = candidatePatches(backends, layers);
  const entries = [];
  const measure = async (patch) => {
    const stats = await score(measurements, { ...start, ...patch, ...forced }, items, seeds);
    if (!stats) return null;
    const entry = { patch, stats };
    entries.push(entry);
    context.onEvent({ type: "candidate", stage: "device", task: null, axis: "device", rung: items.length, patch, rate: stats.rate, latencyMs: stats.latencyMs, tokensPerSecond: stats.tokensPerSecond, failed: stats.failed, runs: measurements.runs });
    return entry;
  };
  for (const patch of first) {
    const entry = await measure(patch);
    if (!entry) return { aborted: true };
    // A GPU that cannot load all layers tries smaller offloads until one loads (ADR-066).
    const fallbacks = entry.stats.failed && patch.gpuBackend !== "cpu" ? fallback(patch.gpuBackend) : [];
    for (const attempt of fallbacks) {
      const smaller = await measure(attempt);
      if (!smaller) return { aborted: true };
      if (!smaller.stats.failed) break;
    }
  }

  const cpu = entries[0];
  const verdicts = new Map();
  const judge = (entry) => {
    if (entry.stats.failed) return `did not run: ${entry.stats.error}`;
    if (!cpu.stats.failed && passedOf(entry) < passedOf(cpu)) return `answered ${passedOf(entry)} of ${entry.stats.items} correctly vs ${passedOf(cpu)} on the CPU`;
    const delta = cpu.stats.failed ? { significant: true, meanDelta: 1 } : costDelta(cpu.stats, entry.stats, options.speedTie, "itemSpeed");
    return delta.significant && delta.meanDelta > 0 ? "faster than the CPU" : "not measurably faster than the CPU";
  };
  for (const entry of entries.slice(1)) verdicts.set(entry, judge(entry));
  // A full offload that loads but shares memory (spilled, slow) loses to the
  // CPU without a partial offload ever being tried (G7): try 75% then 50%.
  for (const entry of entries.slice(1)) {
    if (entry.patch.gpuBackend === "cpu" || entry.patch.gpuLayers !== "max") continue;
    if (entry.stats.failed || verdicts.get(entry) !== "not measurably faster than the CPU") continue;
    for (const attempt of fallback(entry.patch.gpuBackend)) {
      if (entries.some((existing) => existing.patch.gpuBackend === attempt.gpuBackend && existing.patch.gpuLayers === attempt.gpuLayers)) break;
      const smaller = await measure(attempt);
      if (!smaller) return { aborted: true };
      verdicts.set(smaller, judge(smaller));
      if (!smaller.stats.failed) break;
    }
  }
  let winners = entries.slice(1).filter((entry) => verdicts.get(entry) === "faster than the CPU");
  // One rounding-induced loss on six items rejects a 5x GPU (S7): when the
  // fastest GPU loses exactly one item but is at least twice as fast, decide
  // accuracy on the larger load rung instead of the 6-item count.
  let recheck = null;
  if (!winners.length && loadItems?.length >= LOAD_RECHECK_MIN && !cpu.stats.failed) {
    const bySpeed = entries.slice(1)
      .filter((entry) => !entry.stats.failed && passedOf(entry) === passedOf(cpu) - 1)
      .sort((left, right) => speedOf(right) - speedOf(left))[0];
    const speedup = bySpeed && cpu.stats.tokensPerSecond ? (bySpeed.stats.tokensPerSecond / cpu.stats.tokensPerSecond) : 0;
    if (bySpeed && speedup >= 2) {
      const onLoad = [];
      for (const patch of [CPU, bySpeed.patch]) {
        const stats = await score(measurements, { ...start, ...patch, ...forced }, loadItems, seeds);
        if (!stats) return { aborted: true };
        onLoad.push({ patch, stats });
      }
      const [cpuLoad, gpuLoad] = onLoad;
      recheck = { patch: bySpeed.patch, cpuPassed: Math.round((cpuLoad.stats.rate / 100) * cpuLoad.stats.items), gpuPassed: Math.round((gpuLoad.stats.rate / 100) * gpuLoad.stats.items), of: loadItems.length };
      if (!gpuLoad.stats.failed && recheck.gpuPassed >= recheck.cpuPassed - 1) {
        winners = [bySpeed];
        verdicts.set(bySpeed, `one item behind on the 6 speed items but within one item on ${loadItems.length} load items, ${speedup.toFixed(1)}x faster: chosen on non-inferiority`);
      }
    }
  }
  const chosen = winners.sort((left, right) => speedOf(right) - speedOf(left))[0] ?? cpu;
  verdicts.set(cpu, cpu.stats.failed ? `did not run: ${cpu.stats.error}` : chosen === cpu ? "chosen" : "slower than the chosen GPU");
  if (chosen !== cpu && !verdicts.get(chosen)?.includes("non-inferiority")) verdicts.set(chosen, "chosen");
  const tokS = (entry) => (entry.stats.tokensPerSecond ? `${entry.stats.tokensPerSecond} tok/s` : `${entry.stats.latencyMs} ms/answer`);
  const reason = chosen === cpu
    ? `CPU kept (${tokS(cpu)}): no GPU option was both faster and as accurate.`
    : `${chosen.patch.gpuBackend} with ${chosen.patch.gpuLayers} layers: ${tokS(chosen)} vs ${cpu.stats.failed ? `the CPU could not run it (${cpu.stats.error})` : `${tokS(cpu)} on the CPU`}, ${passedOf(chosen)}/${chosen.stats.items} correct.`;
  return {
    settings: { ...chosen.patch },
    probe: entries.map((entry) => summarise(entry, verdicts.get(entry))),
    reason,
    ...(recheck && { accuracyRecheck: recheck }),
    aborted: false,
  };
}
