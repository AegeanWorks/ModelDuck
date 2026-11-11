/**
 * The tune gate's baseline (G-001, G-003, V1): each core model's tuned settings,
 * the per-task rates they reached, and the per-item majority outcomes the
 * paired decision needs. The gate re-measures those settings after a change and
 * fails on a paired, Holm-adjusted regression beyond one item — naming the
 * regressed items. Latency is reported but never gates.
 */
import { holm, mcnemarExact } from "./stats.mjs";
import { TUNER_VERSION } from "./tune.mjs";

export { TUNER_VERSION };

export const BASELINE_SCHEMA = 2;
// Hardware is recorded but advisory: a baseline from one PC is comparable on
// another, with a warning, since thread rounding alone flips answers (D5/M3).
export const IDENTITY_KEYS = Object.freeze(["suiteVersion", "taskHash", "nodeLlamaCpp", "tunerVersion"]);

const round = (value) => Number(value.toFixed(1));

const outcomesOf = (stats) => {
  if (!stats) return null;
  if (stats.outcomes && typeof stats.outcomes === "object") return { ...stats.outcomes };
  if (stats.majority instanceof Map) return Object.fromEntries([...stats.majority].map(([id, passed]) => [id, passed ? 1 : 0]));
  return null;
};

/**
 * The settings a saved profile contributes to a baseline, per task. A task the
 * profile never tuned keeps `{}` so the gate measures the app defaults; a
 * missing profile contributes nothing and is measured as defaults too.
 */
export function presetSettings(profile, taskIds) {
  return {
    load: { ...(profile?.load?.settings ?? {}) },
    tasks: Object.fromEntries(taskIds.map((task) => [task, { settings: { ...(profile?.tasks?.[task]?.settings ?? {}) } }])),
  };
}

/** What the gate keeps of one profile: settings, rates and per-item outcomes, without the sweep log. */
export function baselineEntry(profile, { hardware = null } = {}) {
  return {
    load: { ...profile.load.settings },
    tasks: Object.fromEntries(Object.entries(profile.tasks).map(([task, preset]) => [
      task,
      {
        settings: { ...preset.settings },
        rate: preset.stats?.rate ?? null,
        items: preset.stats?.items ?? null,
        latencyMs: preset.stats?.latencyMs ?? null,
        outcomes: outcomesOf(preset.stats),
      },
    ])),
    ...(hardware && { hardware: { ...hardware } }),
  };
}

/** Keys that make a baseline incomparable with the current run; empty when it can be used. */
export function comparability(baseline, identity) {
  if (baseline?.schema !== BASELINE_SCHEMA) return ["schema"];
  return IDENTITY_KEYS.filter((key) => baseline[key] !== identity[key]);
}

/** Hardware warning: the same settings answer differently on another CPU/GPU (D5/M3). */
export function hardwareWarning(baseline, hardware) {
  if (!baseline || !hardware) return null;
  const saved = baseline.hardware ?? baseline.models?.[Object.keys(baseline.models ?? {})[0]]?.hardware;
  if (!saved) return "the baseline records no hardware; treat small deltas as noise";
  const changed = ["cpu", "gpu", "threads"].filter((key) => saved[key] !== undefined && hardware[key] !== undefined && saved[key] !== hardware[key]);
  return changed.length ? `baseline hardware (${changed.map((key) => `${key}=${saved[key]}`).join(", ")}) differs from this machine` : null;
}

function pairedOutcomes(savedOutcomes, nowOutcomes) {
  let b = 0;
  let c = 0;
  const regressed = [];
  for (const [id, saved] of Object.entries(savedOutcomes ?? {})) {
    if (!(id in (nowOutcomes ?? {}))) continue;
    const was = Boolean(saved);
    const now = Boolean(nowOutcomes[id]);
    if (was && !now) {
      b += 1;
      regressed.push(id);
    } else if (!was && now) c += 1;
  }
  return { b, c, pValue: round(mcnemarExact(b, c), 4), regressed };
}

/**
 * Compare re-measured task rates with the baseline. `current` maps model →
 * task → { rate, items, latencyMs, outcomes? }. With per-item outcomes on both
 * sides the decision is paired (McNemar, Holm across a model's tasks); without
 * them it falls back to the one-item rate rule. A drop larger than one item is a
 * regression; latency is reported but never gates, since it depends on the machine.
 */
export function compareToBaseline(baseline, current, { toleranceItems = 1, alpha = 0.05 } = {}) {
  const rows = [];
  const pValues = [];
  const order = [];
  for (const [model, entry] of Object.entries(baseline.models ?? {})) {
    for (const [task, saved] of Object.entries(entry.tasks)) {
      const now = current[model]?.[task];
      if (!now) {
        rows.push({ model, task, missing: true, regression: true });
        continue;
      }
      // IDEA-1765: an un-escalated tripwire verdict stands on the checked
      // subset only, so the comparison is computed on exactly those items:
      // the baseline's rate over the checked outcomes against the probe's.
      if (now.tripwire && !now.tripwire.escalated) {
        const checkedIds = Object.keys(now.outcomes ?? {});
        const savedChecked = checkedIds.map((id) => Number(saved.outcomes?.[id]));
        const measurable = savedChecked.filter((value) => Number.isFinite(value));
        if (!measurable.length) {
          rows.push({ model, task, missing: true, regression: true });
          continue;
        }
        const subsetBaseline = round((savedChecked.reduce((sum, value) => sum + (value ? 100 : 0), 0) / checkedIds.length));
        const tolerance = (toleranceItems / (now.items || checkedIds.length || 1)) * 100;
        const paired = saved.outcomes && now.outcomes ? pairedOutcomes(saved.outcomes, now.outcomes) : null;
        const delta = round(now.rate - subsetBaseline);
        rows.push({
          model,
          task,
          tripwire: { checked: now.tripwire.checkedItems, of: now.tripwire.of, escalated: false },
          baselineRate: subsetBaseline,
          rate: now.rate,
          delta,
          tolerance: round(tolerance),
          latencyDeltaMs: null,
          regression: delta < -tolerance || (paired ? paired.b > paired.c : false),
          ...(paired && { b: paired.b, c: paired.c, pValue: paired.pValue }),
        });
        continue;
      }
      const tolerance = (toleranceItems / (now.items || saved.items || 1)) * 100;
      const delta = round(now.rate - saved.rate);
      const paired = saved.outcomes && now.outcomes ? pairedOutcomes(saved.outcomes, now.outcomes) : null;
      const row = {
        model,
        task,
        baselineRate: saved.rate,
        rate: now.rate,
        delta,
        tolerance: round(tolerance),
        regression: delta < -tolerance,
        latencyDeltaMs: saved.latencyMs !== null && saved.latencyMs !== undefined && now.latencyMs !== null && now.latencyMs !== undefined ? round(now.latencyMs - saved.latencyMs) : null,
        ...(now.tripwire && { tripwire: { checked: now.tripwire.checkedItems, of: now.tripwire.of, escalated: true } }),
        ...(paired && { b: paired.b, c: paired.c, pValue: paired.pValue, regressed: paired.regressed }),
      };
      rows.push(row);
      if (paired) {
        pValues.push(paired.pValue);
        order.push(row);
      }
    }
  }
  // Holm across the paired comparisons: a noisy drop on one task must survive
  // correction before it fails the gate (V1).
  if (pValues.length) {
    const adjusted = holm(pValues);
    order.forEach((row, index) => {
      row.pAdjusted = round(adjusted[index], 4);
      // A paired, significant loss beyond the item tolerance fails; a bare rate
      // dip without paired significance does not (it is noise until proven).
      if (row.b !== undefined) {
        row.regression = row.b > row.c && row.pAdjusted <= alpha && row.delta < -row.tolerance;
      }
    });
  }
  return { passed: rows.every((row) => !row.regression), rows };
}
