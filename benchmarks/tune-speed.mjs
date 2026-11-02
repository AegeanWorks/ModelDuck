import { candidatesFor, changedAnswers, changedOutcomes, costDelta, median, pick, axisKeys, publicStats, score } from "./tune-measure.mjs";

/**
 * Stage 2 (ADR-030): load settings that should only change speed — threads,
 * batch, flash attention, mmap — measured on a fixed workload with greedy
 * answers. A candidate that flips an item's pass/fail against the stage start
 * did change quality after all and is excluded (M3); text-only rounding
 * differences are recorded but do not exclude. Picks the fastest setting and
 * a Light one that uses at most half the logical threads.
 */

/**
 * Task-weighted latency (M4): the 6 speed items are mostly short and
 * prefill-bound, while code answers are decode-heavy. Ranking by raw latency
 * picks batch sizes and thread counts that are fast for short prompts with
 * short answers. Instead each candidate's prefill/decode throughput predicts
 * each task's latency from that task's token profile, and the choice
 * minimizes the usage-weighted total. Code is the default task.
 */
export const DEFAULT_TASK_WEIGHTS = Object.freeze({ code: 0.5, comprehension: 0.25, recall: 0.25 });

/** Median prompt/output tokens per task from the reference run, grouped by `itemTask(id)`. */
export function taskProfiles(reference, items, itemTask = null) {
  const byTask = new Map();
  for (const id of items) {
    const task = itemTask?.(id) ?? "speed";
    const prompt = reference.itemPrompt?.get(id) ?? reference.promptTokens ?? null;
    const out = reference.itemTokens?.get(id) ?? reference.outputTokens ?? null;
    if (!Number.isFinite(prompt) || !Number.isFinite(out)) continue;
    const group = byTask.get(task) ?? { prompt: [], out: [] };
    group.prompt.push(prompt);
    group.out.push(out);
    byTask.set(task, group);
  }
  return Object.fromEntries([...byTask].map(([task, group]) => [
    task,
    { promptTokens: median(group.prompt), outputTokens: median(group.out) },
  ]));
}

/**
 * Predicted weighted latency (ms) of a candidate's throughput on the profiles.
 * Falls back to the measured latency when throughput or profiles are missing
 * (for example restored answers from before they were recorded).
 */
export function predictWeightedMs(stats, profiles, weights = DEFAULT_TASK_WEIGHTS) {
  const tasks = Object.keys(profiles ?? {});
  const usable = tasks.filter((task) => (weights[task] ?? 0) > 0);
  const prefill = stats.prefillTps;
  const decode = stats.decodeTps;
  if (!usable.length || !(prefill > 0) || !(decode > 0)) return stats.latencyMs ?? Infinity;
  const total = usable.reduce((sum, task) => sum + (weights[task] ?? 0), 0);
  if (!(total > 0)) return stats.latencyMs ?? Infinity;
  const predicted = {};
  let weighted = 0;
  for (const task of usable) {
    const profile = profiles[task];
    const ms = (profile.promptTokens / prefill) * 1000 + (profile.outputTokens / decode) * 1000;
    predicted[task] = Math.round(ms * 10) / 10;
    weighted += ((weights[task] ?? 0) / total) * ms;
  }
  return { ms: Math.round(weighted * 10) / 10, byTask: predicted };
}

const latencyOf = (entry) => entry.stats.latencyMs ?? Infinity;

/** Predicted weighted latency, or raw latency when there is nothing to predict from. */
const predictedOf = (entry) => entry.predictedMs ?? latencyOf(entry);

/** Fastest task-weighted candidate that flipped no item; a gap inside the measurement noise keeps the incumbent. */
function chooseFastest(entries, speedTie) {
  const ok = entries.filter((entry) => !entry.stats.failed && !entry.flippedItems.length);
  if (!ok.length) return entries.find((entry) => entry.incumbent);
  const fastest = [...ok].sort((left, right) => predictedOf(left) - predictedOf(right))[0];
  const tied = ok.filter((entry) => {
    if (entry === fastest) return true;
    const delta = costDelta(fastest.stats, entry.stats, speedTie);
    return !(delta.significant && delta.meanDelta > 0);
  });
  return tied.find((entry) => entry.incumbent) ?? fastest;
}

function summarise(entry) {
  return {
    patch: entry.patch,
    ...publicStats(entry.stats),
    changedItems: entry.changedItems,
    flippedItems: entry.flippedItems ?? [],
    ...(entry.predicted != null && { predictedMs: entry.predicted }),
  };
}

/**
 * Run the speed stage from `start`. `isDone(pass, axis)` skips sweeps a
 * resumed tune already finished; `onSweep(record, current)` is called after
 * each one so progress can be saved. Resolves `{ current, fastest, light, aborted }`.
 */
// Timed candidates are measured several times, interleaved (M2): one pass over
// every candidate, then again, so a whole-run drift cannot make the first-tried
// value look faster. The median latency decides; the incumbent's own spread
// sets the tie band (A/A): band = max(5%, 2 x spread).
const SPEED_REPEATS = 3;

const repeatSeeds = (options) => {
  const seeds = options.seeds?.length ? options.seeds : [42];
  return Array.from({ length: SPEED_REPEATS }, (_, index) => [seeds[index % seeds.length]]);
};

async function measureTimed(measurements, settings, items, seed) {
  const stats = await score(measurements, settings, items, seed);
  return stats;
}

function combineRepeats(repeats) {
  const first = repeats[0];
  const latencies = repeats.map((stats) => stats.latencyMs).filter(Number.isFinite);
  const speeds = repeats.map((stats) => stats.tokensPerSecond).filter(Number.isFinite);
  const prefill = repeats.map((stats) => stats.prefillTps).filter(Number.isFinite);
  const decode = repeats.map((stats) => stats.decodeTps).filter(Number.isFinite);
  return {
    ...first,
    latencyMs: latencies.length ? median(latencies) : first.latencyMs,
    tokensPerSecond: speeds.length ? median(speeds) : first.tokensPerSecond,
    prefillTps: prefill.length ? median(prefill) : first.prefillTps,
    decodeTps: decode.length ? median(decode) : first.decodeTps,
    repeats: repeats.length,
    latencyRangeMs: latencies.length > 1 ? Math.max(...latencies) - Math.min(...latencies) : 0,
  };
}

function aaSpread(repeats) {
  const latencies = repeats.map((stats) => stats.latencyMs).filter((value) => Number.isFinite(value) && value > 0);
  if (latencies.length < 2) return 0;
  const middle = median(latencies);
  if (!(middle > 0)) return 0;
  return (Math.max(...latencies) - Math.min(...latencies)) / middle;
}

export async function speedStage(context, { axes, start, items, forced, logicalCores, itemTask = null, taskWeights = null, isDone = () => false, onSweep = () => {} }) {
  const { measurements, options } = context;
  const weights = { ...DEFAULT_TASK_WEIGHTS, ...(taskWeights ?? options.taskWeights ?? {}) };
  const seeds = repeatSeeds(options);
  const referenceRepeats = [];
  for (const seed of seeds) {
    const stats = await measureTimed(measurements, { ...start, ...forced }, items, seed);
    if (!stats) return { current: start, aborted: true };
    referenceRepeats.push(stats);
  }
  const reference = combineRepeats(referenceRepeats);
  const profiles = taskProfiles(reference, items, itemTask);
  const keys = axisKeys(axes);
  let current = { ...start };
  let threadEntries = null;
  for (let pass = 1; pass <= options.passes; pass += 1) {
    let changed = false;
    for (const axis of axes) {
      if (isDone(pass, axis.name)) continue;
      if (measurements.exhausted) return { current, aborted: true };
      const { candidates, skipped } = candidatesFor(axis, current, context.valid);
      for (const entry of candidates) entry.repeats = [];
      // Interleaved: every candidate once, then every candidate again.
      for (const seed of seeds) {
        for (const entry of candidates) {
          if (measurements.exhausted) return { current, aborted: true };
          const stats = await measureTimed(measurements, { ...current, ...entry.patch, ...forced }, items, seed);
          if (!stats) return { current, aborted: true };
          entry.repeats.push(stats);
        }
      }
      for (const entry of candidates) {
        entry.stats = combineRepeats(entry.repeats);
        entry.predicted = predictWeightedMs(entry.stats, profiles, weights);
        entry.predictedMs = typeof entry.predicted === "object" ? entry.predicted.ms : entry.predicted;
        entry.changedItems = entry.stats.failed ? [] : changedAnswers(reference, entry.stats);
        entry.flippedItems = entry.stats.failed ? [] : changedOutcomes(reference, entry.stats);
        context.onEvent({ type: "candidate", stage: "speed", task: null, axis: axis.name, rung: items.length, patch: entry.patch, rate: entry.stats.rate, latencyMs: entry.stats.latencyMs, tokensPerSecond: entry.stats.tokensPerSecond, prefillTps: entry.stats.prefillTps ?? null, decodeTps: entry.stats.decodeTps ?? null, predictedMs: entry.predictedMs ?? null, repeats: entry.stats.repeats, latencyRangeMs: entry.stats.latencyRangeMs, changedItems: entry.changedItems, flippedItems: entry.flippedItems, runs: measurements.runs });
      }
      const incumbent = candidates.find((entry) => entry.incumbent);
      const spread = incumbent?.repeats ? aaSpread(incumbent.repeats) : 0;
      const tie = Math.max(options.speedTie, 0.05, 2 * spread);
      const winner = chooseFastest(candidates, tie);
      if (axis.name === "threads") threadEntries = candidates;
      const record = {
        stage: "speed",
        task: null,
        pass,
        axis: axis.name,
        skipped,
        repeats: SPEED_REPEATS,
        aaSpread: Math.round(spread * 10000) / 10000,
        speedTie: tie,
        taskWeights: weights,
        taskProfiles: profiles,
        rungs: [{ size: items.length, candidates: candidates.map(summarise) }],
        previous: incumbent.patch,
        winner: winner.patch,
        changed: winner !== incumbent,
        speed: { cost: "latency", ...costDelta(incumbent.stats, winner.stats, tie) },
      };
      if (record.changed) {
        current = { ...current, ...winner.patch };
        changed = true;
      }
      context.sweeps.push(record);
      context.onEvent({ type: "sweep", stage: "speed", task: null, axis: axis.name, pass, winner: winner.patch, changed: record.changed, runs: measurements.runs });
      await onSweep(record, current);
    }
    if (!changed) break;
  }
  const fastest = pick(current, keys);
  // Light and Quiet use fewer threads than the fastest setting, chosen from the same measurements.
  // Only measured entries can win (D2): a formula fallback would invent a thread
  // count that was never timed, so an empty field yields null instead.
  let threadsMeasured = threadEntries !== null;
  const threadsFor = (cap) => {
    const entries = (threadEntries ?? []).filter((entry) => entry.patch.threads <= cap);
    const incumbent = (threadEntries ?? []).find((entry) => entry.incumbent);
    const spread = incumbent?.repeats ? aaSpread(incumbent.repeats) : 0;
    const tie = Math.max(options.speedTie, 0.05, 2 * spread);
    const winner = entries.length ? chooseFastest(entries.map((entry) => ({ ...entry, incumbent: false })), tie) : null;
    if (!winner || !(winner.patch.threads <= cap)) return null;
    return { ...fastest, threads: winner.patch.threads };
  };
  const half = Math.max(1, Math.floor(logicalCores / 2));
  const quarter = Math.max(1, Math.floor(logicalCores / 4));
  return { current, fastest, light: threadsFor(half), quiet: threadsFor(quarter), threadsMeasured, aborted: false };
}
