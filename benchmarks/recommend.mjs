/**
 * Turns a model-phase benchmark result into configuration advice. Quality
 * comparisons use only variants that ran the full suite; speed-only variants
 * (the smoke subset) feed a separate speed-tuning suggestion. Pure function.
 */

export const DEFAULT_MAX_LOSS_POINTS = 5;
export const OVERALL_QUALITY_WEIGHT = 0.7;
export const OVERALL_FLOOR_POINTS = 15;
export const CODING_CATEGORIES = Object.freeze(["code", "code-long", "code-repo", "bugfix", "bugfix-long", "bugfix-repo", "public-code", "code-comprehension"]);

const SETTING_KEYS = [
  "kvCache", "contextSize", "batchSize", "threads", "maxThreads", "sequences",
  "flashAttention", "useMmap", "gpuLayers", "gpuBackend", "checkpoints",
  "checkpointInterval", "checkpointMax",
];

function settingsOf(model) {
  const settings = {};
  for (const key of SETTING_KEYS) if (model[key] !== undefined && model[key] !== null) settings[key] = model[key];
  if (model.requestedContextSize) settings.contextSize = model.requestedContextSize;
  return settings;
}

function categoryRate(model, categories) {
  let passed = 0;
  let total = 0;
  for (const category of categories) {
    const value = model.items?.byCategory?.[category];
    if (!value) continue;
    passed += value.passed;
    total += value.total;
  }
  return total ? Number(((passed / total) * 100).toFixed(1)) : null;
}

function describe(model, kind, why) {
  return {
    kind,
    variantId: model.variantId,
    label: model.label,
    fileName: model.fileName,
    catalogId: model.catalogId ?? null,
    quant: model.quant ?? null,
    rate: model.items.rate,
    ci95: model.items.ci95,
    tokensPerSecond: model.tokensPerSecond,
    firstTokenMs: model.firstTokenMs,
    memoryBytes: model.memoryBytes ?? null,
    gpuVram: model.gpuVram ?? null,
    codingRate: categoryRate(model, CODING_CATEGORIES),
    settings: settingsOf(model),
    why,
  };
}

const faster = (left, right) => right.tokensPerSecond - left.tokensPerSecond;

export function recommend(result, { maxLossPoints = DEFAULT_MAX_LOSS_POINTS } = {}) {
  const models = (result?.models ?? []).filter((model) => model.items && model.items.total > 0 && !model.error);
  if (!models.length) return { available: false, items: [] };
  const fullSize = Math.max(...models.map((model) => model.items.total));
  const full = models.filter((model) => model.items.total === fullSize);
  const smoke = models.filter((model) => model.items.total < fullSize);

  const byQuality = [...full].sort((a, b) => b.items.rate - a.items.rate || faster(a, b));
  const best = byQuality[0];
  const bestCi = best.items.ci95 ? ` (95% CI ${best.items.ci95.low}-${best.items.ci95.high})` : "";
  const items = [describe(best, "quality", `Highest item pass rate: ${best.items.rate}%${bestCi}.`)];

  const coding = full
    .map((model) => ({ model, rate: categoryRate(model, CODING_CATEGORIES) }))
    .filter((entry) => entry.rate !== null)
    .sort((a, b) => b.rate - a.rate || faster(a.model, b.model))[0];
  if (coding) items.push(describe(coding.model, "coding", `Highest pass rate on write, fix, codebase, public code and code-comprehension items: ${coding.rate}%.`));

  // Normalise speed only against variants that clear the quality floor; a fast
  // but poor model must not make every usable configuration look slow.
  const eligible = full.filter((model) => model.items.rate >= best.items.rate - OVERALL_FLOOR_POINTS);
  const maxSpeed = Math.max(...eligible.map((model) => model.tokensPerSecond || 0)) || 1;
  const overall = eligible
    .map((model) => ({
      model,
      score: OVERALL_QUALITY_WEIGHT * (model.items.rate / best.items.rate) + (1 - OVERALL_QUALITY_WEIGHT) * ((model.tokensPerSecond || 0) / maxSpeed),
    }))
    .sort((a, b) => b.score - a.score)[0];
  items.push(describe(
    overall.model,
    "overall",
    `Best balance (70% quality, 30% speed, within ${OVERALL_FLOOR_POINTS} pts of the best): ${overall.model.items.rate}% at ${overall.model.tokensPerSecond} tok/s.`,
  ));

  const withinBudget = full
    .filter((model) => model.items.rate >= best.items.rate - maxLossPoints)
    .sort(faster);
  const fastest = withinBudget[0];
  items.push(describe(
    fastest,
    "speed",
    withinBudget.length > 1
      ? `Fastest within ${maxLossPoints} pts of the best quality: ${fastest.tokensPerSecond} tok/s at ${fastest.items.rate}% (${Number((best.items.rate - fastest.items.rate).toFixed(1))} pts below).`
      : `No full-suite variant is within ${maxLossPoints} pts of ${best.items.rate}%; the best quality is the only safe choice at ${fastest.tokensPerSecond} tok/s.`,
  ));

  // Speed-only knobs: the fastest smoke variant that kept every smoke item its family's base variant passed.
  let speedTuning = null;
  for (const variant of [...smoke].sort(faster)) {
    const sameBase = (model) =>
      variant.catalogId ? model.catalogId === variant.catalogId : model.key === variant.key;
    const base = full.find((model) => sameBase(model) && /-f16$/.test(model.variantId)) ?? full.find(sameBase);
    if (!base) continue;
    const baseSmoke = (base.prompts ?? []).filter((prompt) => (variant.prompts ?? []).some((item) => item.id === prompt.id));
    const kept = baseSmoke.every((prompt) => {
      const now = variant.prompts.find((item) => item.id === prompt.id);
      return !(prompt.passed === prompt.total && now.passed < now.total);
    });
    if (kept && variant.tokensPerSecond > base.tokensPerSecond) {
      const baseSettings = settingsOf(base);
      const changed = Object.fromEntries(Object.entries(settingsOf(variant)).filter(([key, value]) => baseSettings[key] !== value));
      speedTuning = {
        variantId: variant.variantId,
        family: variant.key,
        tokensPerSecond: variant.tokensPerSecond,
        baseTokensPerSecond: base.tokensPerSecond,
        settings: changed,
        why: `On ${base.label.split(" · ")[0]}, ${Object.entries(changed).map(([key, value]) => `${key} ${value}`).join(", ") || "this setting"} ran at ${variant.tokensPerSecond} tok/s vs ${base.tokensPerSecond} with no smoke item lost.`,
      };
      break;
    }
  }

  return { available: true, maxLossPoints, suiteVersion: result.suiteVersion, createdAt: result.createdAt, items, speedTuning };
}
