/**
 * Adaptive informative rungs (ADR-188, opt-in, off by default).
 *
 * In recorded tunes about 90% of the answer time in sampling and prompt sweeps went to items on which every candidate
 * got the same result, which cannot influence a paired comparison (docs/tuning-improvement-report.md, F10). This module
 * learns, from the earlier sweeps of the same tune, which items tell candidates apart per second of answer time, and
 * cuts a task's search rung to those (plus a small random tripwire). A challenger that looks ahead on the subset is
 * tested again on the whole rung before it may win, so a real change is not missed (tune.mjs, `sweepAdaptive`).
 *
 * Everything here is a pure function of the sweeps seen so far. The subset for a sweep uses only earlier sweeps'
 * outcomes, so within a sweep the item order is fixed before the data and the sequential test stays valid.
 */

/**
 * Warm-up sweeps at full cost, the share of the rung's cost kept, the random share of the rest, the escalation bar and
 * the floor. One warm-up sweep is as safe as two in the replay (149 of 149 decisions the same, all 4 real changes
 * found) and also covers the costly `maxTokens` axis, which is the second sweep of the code task.
 */
export const DEFAULT_ADAPTIVE = Object.freeze({ warmup: 1, budget: 0.25, tripwire: 0.1, trigger: 0.3, minItems: 16 });

/** Prior flip rate of an item nobody has seen flip: optimism that keeps new items in play (as the replay in F10 used). */
const PRIOR_FLIP = 0.15;

/** One-sided exact test on the discordant pairs: P(X >= c) for X ~ Binomial(b + c, 1/2), `c` the challenger's wins. */
export function exactGainP(b, c) {
  const n = b + c;
  if (n === 0 || c <= 0) return 1;
  let tail = 0;
  let term = 1; // C(n, 0)
  const terms = [];
  for (let k = 0; k <= n; k += 1) {
    terms.push(term);
    term = (term * (n - k)) / (k + 1);
  }
  for (let k = c; k <= n; k += 1) tail += terms[k];
  return tail / 2 ** n;
}

/**
 * The challengers that are ahead of the incumbent on this rung with an exact one-sided p of at most `trigger`.
 * `entries` are the sweep's candidates: `{ patch, incumbent, stats: { outcomes, failed, partial } }`. A value that
 * failed, was stopped early or has no outcomes is never promising.
 */
export function promisingChallengers(entries, trigger = DEFAULT_ADAPTIVE.trigger) {
  const incumbent = entries.find((entry) => entry.incumbent);
  const base = incumbent?.stats?.outcomes;
  if (!base) return [];
  return entries.filter((entry) => {
    if (entry === incumbent || entry.stats?.failed || entry.stats?.partial || !entry.stats?.outcomes) return false;
    let wins = 0;
    let losses = 0;
    for (const [id, mine] of Object.entries(entry.stats.outcomes)) {
      const theirs = base[id];
      if (theirs === undefined) continue;
      if (mine === 1 && theirs === 0) wins += 1;
      if (mine === 0 && theirs === 1) losses += 1;
    }
    return wins > losses && exactGainP(losses, wins) <= trigger;
  });
}

function hash32(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash;
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** Per-task counts of the sweeps seen, the items' disagreements between candidates and their answer times. */
export class ItemInformation {
  #tasks = new Map();

  #task(task) {
    if (!this.#tasks.has(task)) this.#tasks.set(task, { sweeps: 0, items: new Map() });
    return this.#tasks.get(task);
  }

  /** How many sweeps with at least two usable candidates this task has contributed. */
  sweeps(task) {
    return this.#tasks.get(task)?.sweeps ?? 0;
  }

  /**
   * Record one sweep: for each item of `itemIds`, whether the usable candidates disagreed on it, and how long they
   * took. `candidates` carry `{ outcomes, itemLatency (Map of ms), failed, partial }`. A sweep with fewer than two
   * usable candidates says nothing about disagreement and is not counted.
   */
  learn(task, itemIds, candidates) {
    const usable = candidates.filter((entry) => entry && !entry.failed && !entry.partial && entry.outcomes && Object.keys(entry.outcomes).length);
    if (usable.length < 2) return;
    const state = this.#task(task);
    state.sweeps += 1;
    for (const id of itemIds) {
      const values = usable.map((entry) => entry.outcomes[id]).filter((value) => value !== undefined);
      if (values.length < 2) continue;
      const stats = state.items.get(id) ?? { seen: 0, flips: 0, msSum: 0, msN: 0 };
      stats.seen += 1;
      if (new Set(values).size > 1) stats.flips += 1;
      for (const entry of usable) {
        const ms = entry.itemLatency?.get?.(id);
        if (Number.isFinite(ms)) {
          stats.msSum += ms;
          stats.msN += 1;
        }
      }
      state.items.set(id, stats);
    }
  }

  /**
   * The items of a rung worth measuring from now on, or null when the rung stays whole (too few sweeps seen, or a
   * rung under `minItems`). Items are ranked by `(flips + prior) / (seen + 1)` per millisecond of answer time within
   * their category (the rung's category pattern is kept), taken until `budget` of the rung's estimated cost is
   * reached (never fewer than `minItems`), then a deterministic `tripwire` share of the rest is added so an item
   * that began to flip is noticed.
   */
  subset(task, items, options = DEFAULT_ADAPTIVE) {
    const { warmup = DEFAULT_ADAPTIVE.warmup, budget = 0.25, tripwire = 0.1, minItems = 16, typeOf = null } = options ?? {};
    const state = this.#tasks.get(task);
    if (!state || state.sweeps < warmup || items.length < minItems) return null;
    const known = [...state.items.values()].filter((stats) => stats.msN > 0).map((stats) => stats.msSum / stats.msN);
    const fallback = median(known) ?? 1000;
    const costOf = (id) => {
      const stats = state.items.get(id);
      return stats?.msN > 0 ? Math.max(1, stats.msSum / stats.msN) : fallback;
    };
    const scoreOf = (id) => {
      const stats = state.items.get(id) ?? { seen: 0, flips: 0 };
      return (stats.flips + PRIOR_FLIP) / (stats.seen + 1) / costOf(id);
    };
    const category = (id) => (typeof typeOf === "function" ? typeOf(id) ?? "other" : "all");
    const queues = new Map();
    for (const id of items) {
      const key = category(id);
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(id);
    }
    const position = new Map(items.map((id, index) => [id, index]));
    for (const queue of queues.values()) queue.sort((left, right) => scoreOf(right) - scoreOf(left) || position.get(left) - position.get(right));
    // Each position of the rung keeps its category; the best-scoring unused item of that category fills it.
    const reordered = items.map((id) => queues.get(category(id)).shift());
    const total = reordered.reduce((sum, id) => sum + costOf(id), 0);
    const taken = [];
    let spent = 0;
    for (const id of reordered) {
      if (taken.length >= minItems && spent >= budget * total) break;
      taken.push(id);
      spent += costOf(id);
    }
    const rest = reordered.slice(taken.length);
    const extra = tripwire > 0 && rest.length ? Math.min(rest.length, Math.ceil(tripwire * rest.length)) : 0;
    const guards = [...rest].sort((left, right) => hash32(`${task}|${state.sweeps}|${left}`) - hash32(`${task}|${state.sweeps}|${right}`)).slice(0, extra);
    return [...taken, ...guards];
  }
}
