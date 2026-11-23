import { itemPassed, signFlipPValue, wilson } from "./stats.mjs";

/** Measuring candidates for a tune: a per-item cache with a run budget, and the statistics each choice is made on. */

export const round = (value, digits = 1) => Number(value.toFixed(digits));

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stdev(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

/** Stable identity of one settings object; shared by the measurement cache and the gate answer cache (IDEA-1764). */
let settingsKeyComputes = 0;
export function slotKeyComputations() {
  return settingsKeyComputes;
}
export const settingsKey = (settings) => {
  settingsKeyComputes += 1;
  return JSON.stringify(Object.keys(settings).sort().map((key) => [key, settings[key]]));
};

/**
 * Whether the thread count can change an answer's text. With every layer on
 * the GPU the CPU threads only schedule work: 2,124 of 2,125 stored answers
 * came out identical at 12 and at 8 threads (ADR-123). A timed call is still
 * keyed on threads, because threads is what it times; on the CPU the thread
 * count changes the numerics, so it stays in the key there too.
 */
export const threadsShapeText = (settings) =>
  settings.timed === true || settings.gpuLayers !== "max" || !settings.gpuBackend || settings.gpuBackend === "cpu";

// One settings object is measured across many items in the same rung, so its
// keys are built once per object and seed. Identity keys are safe here: the
// slots Map already treats settings objects as stable measurement keys.
const SLOT_KEY_CACHE = new WeakMap();
const CAPFREE_KEY_CACHE = new WeakMap();
function cachedKey(cache, settings, seed, compute) {
  let bySeed = cache.get(settings);
  if (!bySeed) {
    bySeed = new Map();
    cache.set(settings, bySeed);
  }
  const key = bySeed.get(seed);
  if (key !== undefined) return key;
  const built = compute();
  bySeed.set(seed, built);
  return built;
}

/** The measurement cache's slot key for one settings object and seed. */
export function slotKeyOf(settings, seed) {
  return cachedKey(SLOT_KEY_CACHE, settings, seed, () => {
    if (threadsShapeText(settings) || !("threads" in settings)) return `${settingsKey(settings)}|${seed}`;
    const { threads: _threads, ...rest } = settings;
    return `${settingsKey(rest)}|${seed}`;
  });
}

/**
 * The token cap of a settings object: a number, or Infinity for none. An answer that ended by itself (`eogToken`)
 * under a cap is the same answer under every larger one, so the cap is what separates slots that may share it (ADR-182).
 */
export const capOf = (settings) => (Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : Infinity);

/** The slot key without the cap: slots with the same one differ only in `maxTokens`. */
export function capFreeKeyOf(settings, seed) {
  return cachedKey(CAPFREE_KEY_CACHE, settings, seed, () => {
    const { maxTokens: _cap, ...rest } = settings;
    return slotKeyOf(rest, seed);
  });
}

/** An answer that stopped on its own (cut, aborted and failed ones never do) and how many tokens it took. */
const finishedByItself = (row) => Boolean(row) && !row.error && row.stopReason === "eogToken" && Number.isFinite(row.outputTokens);

/** Live re-asks per spot-check before saved answers are reused (ADR-123). */
export const VERIFY_SAMPLE = 8;

/**
 * Before saved answers are reused, re-ask a few of them live (ADR-123). The
 * identity filters cannot see every code change that frames an answer, so the
 * check asks the model directly: any text difference refuses the whole reuse
 * and the tune measures everything. Timed rows are never the evidence. Where
 * threads are left out of the key, every other probe runs at another thread
 * count, so the check also tests that assumption.
 */
export async function verifyRestore(groups, evaluate, { sample = VERIFY_SAMPLE } = {}) {
  const candidates = [];
  for (const group of groups ?? []) {
    if (!group?.settings || group.settings.timed === true) continue;
    for (const row of group.rows ?? []) {
      if (typeof row?.text === "string" && (row.item ?? row.id) !== undefined) candidates.push({ group, row });
    }
  }
  if (!candidates.length) return { ok: true, checked: 0, mismatched: [] };
  const count = Math.min(sample, candidates.length);
  // Evenly spread over the saved answers, so the check is not one settings group.
  const picked = Array.from({ length: count }, (_, index) => candidates[Math.floor(((index + 0.5) * candidates.length) / count)]);
  const mismatched = [];
  for (const [index, { group, row }] of picked.entries()) {
    const id = row.item ?? row.id;
    let settings = group.settings;
    if (index % 2 === 1 && !threadsShapeText(settings) && Number.isFinite(settings.threads)) {
      settings = { ...settings, threads: settings.threads > 1 ? Math.max(1, Math.floor(settings.threads / 2)) : 2 };
    }
    const out = await evaluate(settings, [id], group.seed);
    const live = out?.prompts?.[0];
    if (!live || live.text !== row.text || live.passed !== row.passed) mismatched.push(id);
  }
  return { ok: mismatched.length === 0, checked: count, mismatched };
}

/**
 * The same live spot-check, kept per family of items (ADR-185): a few of the cheapest saved answers of each family
 * are re-asked, a family with a difference is dropped, and the families that came out identical keep every saved
 * answer. The all-or-nothing check above threw away tens of thousands of answers because one cheap family (recall,
 * code reading) had changed, and the hours of code answers with them. Only when no family verifies is nothing reused.
 * `familyOf(itemId)` names the family (the suite's category); an item it does not know belongs to "other".
 */
export async function verifyRestoreByFamily(groups, evaluate, { familyOf = () => null, perFamily = 3 } = {}) {
  const byFamily = new Map();
  for (const group of groups ?? []) {
    if (!group?.settings || group.settings.timed === true) continue;
    for (const row of group.rows ?? []) {
      const id = row?.item ?? row?.id;
      if (typeof row?.text !== "string" || id === undefined) continue;
      const family = familyOf(id) ?? "other";
      if (!byFamily.has(family)) byFamily.set(family, []);
      byFamily.get(family).push({ group, row, id });
    }
  }
  if (!byFamily.size) return { ok: true, checked: 0, mismatched: [], stale: [], groups: [] };
  const stale = [];
  const mismatched = [];
  let checked = 0;
  for (const [family, list] of byFamily) {
    // The cheapest half, spread evenly: a re-ask of a long answer costs seconds, and the cheap ones are as telling.
    const cheap = [...list].sort((left, right) => (Number(left.row.ms) || Infinity) - (Number(right.row.ms) || Infinity)).slice(0, Math.max(1, Math.ceil(list.length / 2)));
    const count = Math.min(perFamily, cheap.length);
    let differs = false;
    for (let index = 0; index < count; index += 1) {
      const { group, row, id } = cheap[Math.floor(((index + 0.5) * cheap.length) / count)];
      let settings = group.settings;
      if (index % 2 === 1 && !threadsShapeText(settings) && Number.isFinite(settings.threads)) {
        settings = { ...settings, threads: settings.threads > 1 ? Math.max(1, Math.floor(settings.threads / 2)) : 2 };
      }
      const live = (await evaluate(settings, [id], group.seed))?.prompts?.[0];
      checked += 1;
      if (!live || live.text !== row.text || live.passed !== row.passed) {
        differs = true;
        mismatched.push(id);
      }
    }
    if (differs) stale.push(family);
  }
  const kept = stale.length < byFamily.size
    ? (groups ?? []).map((group) => ({ ...group, rows: (group.rows ?? []).filter((row) => !stale.includes(familyOf(row.item ?? row.id) ?? "other")) })).filter((group) => group.rows.length)
    : [];
  return { ok: kept.length > 0, checked, mismatched, stale, groups: kept };
}

/** Fixed-budget quota default: no cap unless the caller sets one (IDEA-1580). */
export const QUOTA_DEFAULT = Infinity;

/**
 * True when `runs` has reached the fixed `quota`. Pure so the quota rule is
 * unit-testable without a Measurements instance.
 */
export function isQuotaExceeded(runs, quota) {
  if (!Number.isFinite(quota)) return false;
  return Number(runs) >= Number(quota);
}

/** Items asked per call while a time budget runs, so the budget is checked between them. */
export const DEADLINE_CHUNK = 4;

/** Per-item result cache with a run budget; a rung only asks for the items it has not seen. */
export class Measurements {
  constructor(evaluate, maxRuns, onAnswers = () => {}, { quota = QUOTA_DEFAULT, deadline = Infinity, clock = Date.now } = {}) {
    this.evaluate = evaluate;
    this.maxRuns = maxRuns;
    // A time budget (tune-budget.mjs): no new answers are asked once `clock()` passes it.
    this.deadline = deadline ?? Infinity;
    this.clock = clock;
    // IDEA-1580: fixed-budget quota caps total measured answers for the whole
    // tune, independent of the per-rung maxRuns ceiling. Infinity disables it.
    this.quota = quota ?? QUOTA_DEFAULT;
    // Called with every newly measured answer, for the run record (ADR-050).
    this.onAnswers = onAnswers;
    this.runs = 0;
    // IDEA-1764: answers served by restore() instead of the model.
    this.reusedRows = 0;
    this.slots = new Map();
    // Slots that differ only in their token cap, by the key without it (ADR-182).
    this.capSlots = new Map();
    // Why measuring stopped early (the model cannot load at all), or null.
    this.stopped = null;
  }

  get quotaExceeded() {
    return isQuotaExceeded(this.runs, this.quota);
  }

  get deadlinePassed() {
    return Number.isFinite(this.deadline) && this.clock() >= this.deadline;
  }

  get exhausted() {
    return this.runs >= this.maxRuns || this.quotaExceeded || this.deadlinePassed || this.stopped !== null;
  }

  /** Stop every further measurement; later stages see the budget as spent and end. */
  stop(reason) {
    this.stopped ??= reason;
  }

  /** The slot of one settings object and seed, made on first use and listed with its cap-only siblings. */
  #slotFor(settings, seed) {
    const slotKey = slotKeyOf(settings, seed);
    if (!this.slots.has(slotKey)) {
      const slot = { items: new Map(), memoryBytes: undefined, gpuVram: undefined };
      this.slots.set(slotKey, slot);
      const family = capFreeKeyOf(settings, seed);
      if (!this.capSlots.has(family)) this.capSlots.set(family, []);
      this.capSlots.get(family).push({ cap: capOf(settings), slot });
    }
    return this.slots.get(slotKey);
  }

  /**
   * Fill the items of `slot` that a sibling slot, differing only in its token cap, already answered by itself
   * (ADR-182). Same prompt, same sampler and seed, so the model produces the same tokens until the cap: an answer that
   * ended after `n` tokens is the same answer under every cap above `n`, whichever cap it was asked under and in
   * whichever order. Returns the ids still missing.
   */
  #reuseFromSiblingCap(settings, seed, slot, missing) {
    const cap = capOf(settings);
    const donors = (this.capSlots.get(capFreeKeyOf(settings, seed)) ?? []).filter((donor) => donor.slot !== slot);
    if (!donors.length) return missing;
    return missing.filter((id) => {
      const donor = donors.find((entry) => {
        const row = entry.slot.items.get(id);
        return finishedByItself(row) && row.outputTokens < cap;
      });
      if (!donor) return true;
      slot.items.set(id, { ...donor.slot.items.get(id), reusedFromCap: donor.cap });
      return false;
    });
  }

  /**
   * Prefill one slot from saved answers (G8): a continue or re-tune reuses an
   * exact settings/seed/item match instead of re-asking the model. Returns
   * false when the slot already has measurements (fresh answers win).
   */
  restore(settings, seed, rows) {
    // Several saved groups can share one slot (runs at different thread counts on
    // full GPU offload, ADR-123), so each adds only the items the slot lacks: an
    // item already there, fresh or restored first, is never replaced.
    const { items } = this.#slotFor(settings, seed);
    let added = false;
    for (const row of rows) {
      const id = row.item ?? row.id;
      if (items.has(id)) continue;
      items.set(id, { ...row, id });
      added = true;
    }
    return added;
  }

  async measure(settings, itemIds, seed) {
    const slot = this.#slotFor(settings, seed);
    const missing = this.#reuseFromSiblingCap(settings, seed, slot, itemIds.filter((id) => !slot.items.has(id)));
    if (missing.length) {
      if (this.exhausted) return null;
      // With a time budget the items are asked a few at a time so the tune stops close to it,
      // not a whole rung later. Answers are per item, so the split changes none of them.
      const chunk = Number.isFinite(this.deadline) ? Math.max(DEADLINE_CHUNK, Number(this.evaluate.parallel) || 1) : missing.length;
      for (let start = 0; start < missing.length; start += chunk) {
        if (start > 0 && this.exhausted) return null;
        const part = missing.slice(start, start + chunk);
        const out = await this.evaluate(settings, part, seed);
        this.runs += part.length;
        this.onAnswers(settings, seed, out.prompts);
        for (const prompt of out.prompts) slot.items.set(prompt.id, prompt);
        // CPU RAM and GPU VRAM are both memory; dropping VRAM here made a GPU
        // preset look no larger than its small host slice.
        slot.memoryBytes = out.memoryBytes ?? slot.memoryBytes;
        slot.gpuVram = out.gpuVram ?? slot.gpuVram;
      }
    }
    this.reusedRows += itemIds.length - missing.length;
    return { prompts: itemIds.map((id) => slot.items.get(id)), memoryBytes: slot.memoryBytes, gpuVram: slot.gpuVram };
  }
}

/**
 * Pass rate (seed-averaged), Wilson CI, latency, answer length and speed of
 * one settings combination on one item set. Resolves null when the run budget
 * is spent. Internal per-item maps are removed by `publicStats`.
 */
let zeroedMapBuilds = 0;
export function zeroedMapBuildCount() {
  return zeroedMapBuilds;
}

export async function score(measurements, settings, itemIds, seeds) {
  const used = settings.temperature > 0 ? seeds : seeds.slice(0, 1);
  // Fill each map directly: `new Map(ids.map(id => [id, 0]))` allocates an
  // intermediate array of pairs for every map, on every tuning rung.
  const zeroed = () => {
    zeroedMapBuilds += 1;
    const map = new Map();
    for (const id of itemIds) map.set(id, 0);
    return map;
  };
  const fractions = zeroed();
  // Partial credit per item (G6): the share of checks passed, averaged over
  // seeds. Code items have 2-7 cases but count only when all pass; the
  // fraction of cases is a finer signal for the paired test. The headline
  // rate stays all-or-nothing.
  const credit = zeroed();
  const itemLatency = new Map();
  const itemTokens = new Map();
  const itemPrompt = new Map();
  const itemSpeed = new Map();
  // Work per second of wall time, prompt plus answer: what an engine that reads prompts faster is worth (ADR-159).
  const itemThroughput = new Map();
  const digests = new Map();
  const latencies = [];
  const tokens = [];
  const speeds = [];
  const promptTokenCounts = [];
  // Prefill vs decode throughput (M3/M4): identical prompts make prefill
  // comparable even when answers differ; decode stays comparable per token.
  const prefillSpeeds = [];
  const decodeSpeeds = [];
  // Per-answer serving evidence (M1/V4): stop reasons, TTFT and decode rate stay
  // comparable when answers differ, unlike raw text digests.
  let truncated = 0;
  // Empty answers (no tokens, or blank text) are give-ups, not truncations:
  // the agentic failure mode is an empty patch, not a cut-off one (lit §8).
  let empty = 0;
  let answered = 0;
  let memoryBytes;
  let gpuVram;
  let errors = 0;
  let firstError = null;
  for (const seed of used) {
    const measured = await measurements.measure(settings, itemIds, seed);
    if (!measured) return null;
    memoryBytes = measured.memoryBytes ?? measured.memory?.cpuRam ?? memoryBytes;
    gpuVram = measured.gpuVram ?? measured.memory?.gpuVram ?? gpuVram;
    for (const prompt of measured.prompts) {
      if (prompt.error) {
        errors += 1;
        firstError ??= prompt.error;
      } else {
        answered += 1;
        if (prompt.stopReason === "maxTokens") truncated += 1;
        if (prompt.outputTokens === 0 || (typeof prompt.text === "string" && prompt.text.trim() === "")) empty += 1;
      }
      if (itemPassed(prompt)) fractions.set(prompt.id, fractions.get(prompt.id) + 1 / used.length);
      if (!prompt.error && Number(prompt.total) > 0) {
        credit.set(prompt.id, credit.get(prompt.id) + Math.min(1, Math.max(0, (Number(prompt.passed) || 0) / Number(prompt.total))) / used.length);
      }
      if (Number.isFinite(prompt.ms)) {
        latencies.push(prompt.ms);
        itemLatency.set(prompt.id, (itemLatency.get(prompt.id) ?? 0) + prompt.ms / used.length);
      }
      if (Number.isFinite(prompt.outputTokens)) {
        tokens.push(prompt.outputTokens);
        itemTokens.set(prompt.id, (itemTokens.get(prompt.id) ?? 0) + prompt.outputTokens / used.length);
      }
      if (Number.isFinite(prompt.tokensPerSecond)) {
        speeds.push(prompt.tokensPerSecond);
        itemSpeed.set(prompt.id, (itemSpeed.get(prompt.id) ?? 0) + prompt.tokensPerSecond / used.length);
      }
      if (Number.isFinite(prompt.promptTokens) && Number.isFinite(prompt.firstTokenMs) && prompt.firstTokenMs > 0) {
        prefillSpeeds.push((prompt.promptTokens / (prompt.firstTokenMs / 1000)) || 0);
      }
      if (Number.isFinite(prompt.outputTokens) && Number.isFinite(prompt.ms) && Number.isFinite(prompt.firstTokenMs) && prompt.ms > prompt.firstTokenMs && prompt.outputTokens > 1) {
        decodeSpeeds.push(((prompt.outputTokens - 1) / ((prompt.ms - prompt.firstTokenMs) / 1000)) || 0);
      }
      if (Number.isFinite(prompt.promptTokens) && Number.isFinite(prompt.outputTokens) && Number.isFinite(prompt.ms) && prompt.ms > 0) {
        itemThroughput.set(prompt.id, (itemThroughput.get(prompt.id) ?? 0) + (((prompt.promptTokens + prompt.outputTokens) / (prompt.ms / 1000)) / used.length));
      }
      if (Number.isFinite(prompt.promptTokens)) {
        promptTokenCounts.push(prompt.promptTokens);
        itemPrompt.set(prompt.id, (itemPrompt.get(prompt.id) ?? 0) + prompt.promptTokens / used.length);
      }
      if (seed === used[0]) digests.set(prompt.id, prompt.digest ?? null);
    }
  }
  const passed = [...fractions.values()].reduce((sum, value) => sum + value, 0);
  // Fractional solved count (seed-averaged) for a rounding-free tolerance (D4):
  // one item lost by majority at 3 seeds counts as 0.67 items, not as a rounded point.
  const solved = Math.round(passed * 1000) / 1000;
  const majority = new Map([...fractions].map(([id, fraction]) => [id, fraction >= 0.5]));
  // Plain per-item outcomes for the paired gate (V1); the Map stays internal.
  const outcomes = Object.fromEntries([...majority].map(([id, passed]) => [id, passed ? 1 : 0]));
  // Seed-averaged pass per item for the sign-flip test (S2); the Map stays internal.
  const fractionsPlain = Object.fromEntries([...fractions].map(([id, fraction]) => [id, Math.round(fraction * 10000) / 10000]));
  // Seed-averaged partial credit per item (G6); the Map stays internal.
  const creditPlain = Object.fromEntries([...credit].map(([id, value]) => [id, Math.round(value * 10000) / 10000]));
  return {
    // No items is a zero rate, not NaN: an empty rung must compare and report, never poison ordering.
    rate: itemIds.length ? round((passed / itemIds.length) * 100) : 0,
    solved,
    ci95: wilson(passed, itemIds.length),
    latencyMs: latencies.length ? round(median(latencies)) : null,
    latencySd: latencies.length ? round(stdev(latencies)) : null,
    outputTokens: tokens.length ? round(median(tokens)) : null,
    tokensPerSecond: speeds.length ? round(median(speeds), 2) : null,
    // Share of non-error answers cut off by the token budget (M1); a tuned cap must keep this near zero.
    truncationRate: answered ? round((truncated / answered) * 100) : null,
    // Share of non-error answers that are empty (lit §8); the agentic give-up rate.
    giveUpRate: answered ? round((empty / answered) * 100) : null,
    promptTokens: promptTokenCounts.length ? round(median(promptTokenCounts)) : null,
    prefillTps: prefillSpeeds.length ? round(median(prefillSpeeds), 2) : null,
    decodeTps: decodeSpeeds.length ? round(median(decodeSpeeds), 2) : null,
    items: itemIds.length,
    seeds: used.length,
    memoryBytes,
    ...(gpuVram !== undefined && { gpuVram }),
    // Every answer errored: the settings did not load or run, which is not a measurement.
    failed: errors === itemIds.length * used.length,
    error: firstError,
    majority,
    outcomes,
    fractions: fractionsPlain,
    credit: creditPlain,
    itemLatency,
    itemTokens,
    itemPrompt,
    itemSpeed,
    itemThroughput,
    digests,
  };
}

export const publicStats = ({ majority: _majority, itemLatency: _latency, itemTokens: _tokens, itemPrompt: _prompt, itemSpeed: _speed, itemThroughput: _throughput, digests: _digests, ...stats }) => stats;

/**
 * Per-item paired differences (after − before) from the richest signal both
 * runs share: partial credit (G6), then seed fractions (S2), then majority
 * votes. Returns [{ id, diff }] with zero diffs dropped.
 */
export function pairedDiffs(before, after) {
  if (before.credit && after.credit) {
    return Object.entries(before.credit)
      .filter(([id]) => id in after.credit)
      .map(([id, base]) => ({ id, diff: after.credit[id] - base }))
      .filter(({ diff }) => diff !== 0);
  }
  if (before.fractions && after.fractions) {
    return Object.entries(before.fractions)
      .filter(([id]) => id in after.fractions)
      .map(([id, base]) => ({ id, diff: after.fractions[id] - base }))
      .filter(({ diff }) => diff !== 0);
  }
  const diffs = [];
  for (const [id, passed] of before.majority) {
    if (!after.majority.has(id)) continue;
    const diff = Number(Boolean(after.majority.get(id))) - Number(Boolean(passed));
    if (diff !== 0) diffs.push({ id, diff });
  }
  return diffs;
}

/**
 * Paired comparison on the items both runs answered. The sign-flip test uses
 * the per-item differences, so a 2-of-3 flip counts as 0.67 items and
 * magnitudes matter; with majority votes only it reduces to exact McNemar
 * (identical for binary differences).
 */
export function paired(before, after) {
  const diffs = pairedDiffs(before, after);
  let b = 0;
  let c = 0;
  for (const { diff } of diffs) {
    if (diff < 0) b += 1;
    else c += 1;
  }
  return { b, c, pValue: round(signFlipPValue(diffs.map(({ diff }) => diff)), 4) };
}

/**
 * Cluster-aware paired comparison (S4): per-item differences are summed within
 * each cluster — one function, one codebase — and the sign-flip test runs on
 * the cluster sums. A setting that changes how a model reads one function
 * flips several of its inputs together; counting those as independent items
 * makes p-values 3-4x too optimistic. With `clusterOf` null (or one item per
 * cluster) this reduces to `paired()`. Returns item-level b/c for display,
 * the cluster count, and the cluster-valid p-value.
 */
export function pairedClustered(before, after, clusterOf = null) {
  const diffs = pairedDiffs(before, after);
  let b = 0;
  let c = 0;
  const sums = new Map();
  for (const { id, diff } of diffs) {
    if (diff < 0) b += 1;
    else c += 1;
    const cluster = clusterOf?.(id) ?? id;
    sums.set(cluster, (sums.get(cluster) ?? 0) + diff);
  }
  return { b, c, pValue: round(signFlipPValue([...sums.values()]), 4), clusters: sums.size };
}

/**
 * Paired comparison on the items both answered (`cost` is "itemLatency",
 * "itemTokens" or "itemSpeed", where higher is better): the mean per-item difference (after − before) is real only
 * when it exceeds both the tie band and twice its standard error.
 */
export function costDelta(before, after, speedTie, cost = "itemLatency") {
  const diffs = [];
  let baseline = 0;
  for (const [id, value] of before[cost]) {
    if (!after[cost].has(id)) continue;
    diffs.push(after[cost].get(id) - value);
    baseline += value;
  }
  if (!diffs.length) return { meanDelta: 0, se: 0, significant: false };
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const se = diffs.length > 1 ? stdev(diffs) * Math.sqrt(diffs.length / (diffs.length - 1)) / Math.sqrt(diffs.length) : 0;
  const band = Math.max(speedTie * (baseline / diffs.length), 2 * se);
  return { meanDelta: round(mean), se: round(se), significant: Math.abs(mean) > band };
}

/** Items whose answer text differs from the reference run, by digest. */
export function changedAnswers(reference, stats) {
  return [...reference.digests].filter(([id, digest]) => digest === null || stats.digests.get(id) !== digest).map(([id]) => id);
}

/**
 * Items whose pass/fail flipped against the reference run (M3). Rounding can
 * change answer text without changing quality; only a flip guards speed.
 */
export function changedOutcomes(reference, stats) {
  const flipped = [];
  for (const [id, passed] of reference.majority) {
    if (!stats.majority.has(id)) continue;
    if (Boolean(passed) !== Boolean(stats.majority.get(id))) flipped.push(id);
  }
  return flipped;
}

export const matches = (settings, patch) => Object.entries(patch).every(([key, value]) => settings[key] === value);
export const pick = (settings, keys) => Object.fromEntries(keys.filter((key) => key in settings).map((key) => [key, settings[key]]));
// `extraKeys` are settings an axis may also change through `widen` (reasoning's answer length).
export const axisKeys = (axes) => [...new Set(axes.flatMap((axis) => [...axis.patches.flatMap(Object.keys), ...(axis.extraKeys ?? [])]))];

/** Items a candidate got right by majority vote. */
export const solvedCount = (stats) => [...stats.majority.values()].filter(Boolean).length;

/** Cumulative item counts at which a rung is checked for an early stop (four equal blocks by default). */
export function lookPoints(size, looks = 4) {
  const points = new Set();
  for (let index = 1; index <= looks; index += 1) points.add(Math.ceil((size * index) / looks));
  return [...points].filter((point) => point > 0 && point <= size).sort((left, right) => left - right);
}

/**
 * Score `settings` on `itemIds`, checking the statistics at each look point and
 * stopping when `shouldStop(stats)` says so. Answers are cached per item, so a
 * stopped candidate costs only the prefix it answered; a full pass returns the
 * same statistics as `score`. A stopped result carries `partial: true` and the
 * item count it reached.
 */
export async function scoreSequential(measurements, settings, itemIds, seeds, { lookAt = null, shouldStop = null } = {}) {
  const points = [...new Set([...(lookAt ?? []), itemIds.length])].filter((point) => point > 0 && point <= itemIds.length).sort((left, right) => left - right);
  let stats = null;
  for (const point of points) {
    stats = await score(measurements, settings, itemIds.slice(0, point), seeds);
    if (!stats) return null;
    if (point === itemIds.length) break;
    if (shouldStop?.(stats, point)) return { ...stats, partial: true };
  }
  return stats;
}

/** The axis values to measure on top of `current`; impossible combinations are listed instead of run. */
export function candidatesFor(axis, current, valid) {
  const candidates = [];
  const skipped = [];
  for (const [index, listed] of axis.patches.entries()) {
    // An axis may adjust a value to what it needs on top of `current` (ADR-046).
    const patch = axis.widen ? axis.widen(current, listed) : listed;
    const incumbent = matches(current, patch);
    if (!incumbent && !valid({ ...current, ...patch })) skipped.push(patch);
    else candidates.push({ patch, index, incumbent });
  }
  if (!candidates.some((entry) => entry.incumbent)) {
    candidates.push({ patch: pick(current, axisKeys([axis])), index: axis.patches.length, incumbent: true });
  }
  return { candidates, skipped };
}
