import { AppError } from "../src/errors.js";

/** The places a tune spends its wall-clock time. `other` is what is left over. */
export const TIMING_PHASES = Object.freeze(["load", "generate", "judge"]);

const PHASE_SET = new Set(TIMING_PHASES);

/**
 * Wall-clock accounting for one tune process.
 *
 * `measure(phase, fn)` adds the time `fn` takes to `phase`, even when it throws.
 * A phase's time is the wall time during which at least one call of it was
 * running, so answers generating side by side count once, not once each.
 * When different phases run at once (one answer generating while another is
 * judged) their times add up past the wall time; the summary then says
 * `overlapped` and `other` stays 0.
 */
export function createPhaseTimer({ clock = () => performance.now() } = {}) {
  const startedAt = clock();
  const totals = Object.fromEntries(TIMING_PHASES.map((phase) => [phase, 0]));
  // Per phase: how many calls are running, and since when at least one has been.
  const active = Object.fromEntries(TIMING_PHASES.map((phase) => [phase, { running: 0, since: 0 }]));
  const counts = {};

  function measure(phase, fn) {
    if (!PHASE_SET.has(phase)) {
      throw new AppError("Unknown timing phase", {
        code: "timing_phase_unknown",
        why: `"${phase}" is not one of ${TIMING_PHASES.join(", ")}.`,
        fix: "Use one of the named phases so no time is lost to a typo.",
      });
    }
    const slot = active[phase];
    if (slot.running === 0) slot.since = clock();
    slot.running += 1;
    const record = () => {
      slot.running -= 1;
      if (slot.running === 0) totals[phase] += clock() - slot.since;
    };
    // fn starts now, not a tick later, so concurrent phases begin when they are asked to.
    let pending;
    try {
      pending = Promise.resolve(fn());
    } catch (error) {
      record();
      return Promise.reject(error);
    }
    return pending.then((value) => { record(); return value; }, (error) => { record(); throw error; });
  }

  function count(name, amount = 1) {
    counts[name] = (counts[name] ?? 0) + amount;
  }

  function summary() {
    const wallMs = Math.max(0, Math.round(clock() - startedAt));
    const now = clock();
    const open = (phase) => (active[phase].running > 0 ? now - active[phase].since : 0);
    const phases = Object.fromEntries(TIMING_PHASES.map((phase) => [phase, Math.round(totals[phase] + open(phase))]));
    const summed = TIMING_PHASES.reduce((sum, phase) => sum + phases[phase], 0);
    return { wallMs, phases: { ...phases, other: Math.max(0, wallMs - summed) }, counts: { ...counts }, overlapped: summed > wallMs };
  }

  return { measure, count, summary };
}

/** 540 -> "9m00s", 61 -> "1m01s", 7 -> "7s". */
function duration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** One line for the end of a tune: where the time went and how many loads and answers it took. */
export function formatTiming({ wallMs, phases, counts = {}, overlapped = false }) {
  const parts = [];
  if (overlapped) {
    parts.push(`phases overlapped, summed: ${TIMING_PHASES.map((phase) => `${phase} ${duration(phases[phase] ?? 0)}`).join(" · ")}`);
  } else {
    const shares = [...TIMING_PHASES, "other"]
      .map((phase) => ({ phase, ms: phases[phase] ?? 0 }))
      .filter(({ ms }) => ms > 0)
      .sort((left, right) => right.ms - left.ms)
      .map(({ phase, ms }) => `${phase} ${Math.round((ms / Math.max(1, wallMs)) * 100)}%`);
    parts.push(...shares);
  }
  if (counts.loads != null) parts.push(`${counts.loads} model load${counts.loads === 1 ? "" : "s"}`);
  if (counts.reconfigures) parts.push(`${counts.reconfigures} reconfigure${counts.reconfigures === 1 ? "" : "s"}`);
  if (counts.answers != null) parts.push(`${counts.answers} answers`);
  return `Time ${duration(wallMs)}: ${parts.join(" · ")}`;
}
