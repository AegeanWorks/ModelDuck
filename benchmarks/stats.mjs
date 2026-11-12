/**
 * Benchmark statistics. A prompt ("item") passes when all of its checks pass;
 * comparisons are paired by (variant, item), which is the only design with
 * useful power at a few dozen items. Pure functions, no dependencies.
 */

export const FLOOR_DROP_POINTS = 5;
export const ALPHA = 0.05;
const Z95 = 1.959964;

/** Wilson score interval for a binomial proportion, as percentages. */
export function wilson(passed, total, z = Z95) {
  if (!total) return { low: 0, high: 0 };
  const p = passed / total;
  const z2 = z * z;
  const centre = (p + z2 / (2 * total)) / (1 + z2 / total);
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / (1 + z2 / total);
  const round = (value) => Number((Math.min(1, Math.max(0, value)) * 100).toFixed(1));
  return { low: round(centre - half), high: round(centre + half) };
}

/**
 * IDEA-1232: an honest interval for a calibration subset of a larger matrix.
 * The Wilson interval is shrunk by the finite-population correction, so a
 * subset that is most of the matrix claims a tighter band than a small probe.
 * Reports that ignore the subset size overstate their certainty.
 */
export function subsetInterval(passed, subsetTotal, populationTotal, z = Z95) {
  const base = wilson(passed, subsetTotal, z);
  const subset = Number(subsetTotal) || 0;
  const population = Number(populationTotal) || 0;
  if (!(subset > 0) || !(population > subset)) return { ...base, calibration: false };
  const fpc = Math.sqrt(Math.max(0, (population - subset) / (population - 1)));
  const mid = (base.low + base.high) / 2;
  const half = ((base.high - base.low) / 2) * fpc;
  const round = (value) => Number((Math.min(100, Math.max(0, value))).toFixed(1));
  return { low: round(mid - half), high: round(mid + half), calibration: true };
}

function logChoose(n, k) {
  let sum = 0;
  for (let index = 1; index <= k; index += 1) sum += Math.log(n - k + index) - Math.log(index);
  return sum;
}

/** Exact two-sided McNemar test on discordant pairs b (pass→fail) and c (fail→pass). */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let index = 0; index <= k; index += 1) tail += Math.exp(logChoose(n, index) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/**
 * IDEA-1787 (ADR-098): one-sided exact McNemar — the probability of seeing at
 * most c fixes among n discordant pairs under a fair coin, i.e. the loss-tail
 * evidence. Gate decisions are strictly directional (a gate only fails when
 * losses exceed fixes), so a two-sided p spends half its alpha on the
 * never-firing gain side; this reports only the direction the gate acts on.
 */
export function mcnemarOneSided(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  for (let index = 0; index <= c; index += 1) tail += Math.exp(logChoose(n, index) - n * Math.LN2);
  return Math.min(1, tail);
}

/**
 * IDEA-1617: Q8_0 is the lossless ceiling reference for bench comparisons.
 * A bench that never measured the ceiling cannot tell a tie from a win, and
 * a non-ceiling variant must never be reported lossless without the ceiling
 * beside it. Bench-only: pure functions, no dependencies.
 */
export const CEILING_QUANT = "Q8_0";

function ceilingQuantOf(model) {
  return String(model?.quant ?? "").toLowerCase();
}

/** A weight-quant Q8_0 variant (not a q8 KV cache on smaller weights). */
export function isCeilingVariant(model = {}) {
  const quant = ceilingQuantOf(model);
  if (quant) return quant === "q8_0";
  const id = `${model.variantId ?? model.key ?? model.catalogId ?? ""}`.toLowerCase();
  if (!id) return false;
  return id.includes("-q8-") || id.endsWith("-q8") || id.includes("-q8_") || id.includes("_q8");
}

function claimsLossless(model = {}) {
  if (model.lossless === true || model.claimsLossless === true) return true;
  if (String(model.quality ?? "").toLowerCase() === "lossless") return true;
  return /lossless/i.test(String(model.label ?? "")) && !isCeilingVariant(model);
}

/**
 * Ceiling gate over one bench result's models. Warns when no Q8_0 variant
 * was measured (the ceiling is unknown), fails when a non-ceiling variant
 * is reported lossless without the ceiling beside it, passes otherwise.
 */
export function losslessCeilingGate(result, { ceilingQuant = CEILING_QUANT } = {}) {
  const models = result?.models ?? [];
  const ceiling = models.filter(isCeilingVariant);
  const hasCeiling = ceiling.length > 0;
  const ceilingVariantId = hasCeiling ? (ceiling[0].variantId ?? ceiling[0].key ?? null) : null;
  const claimants = models
    .filter((model) => !isCeilingVariant(model) && claimsLossless(model))
    .map((model) => model.variantId ?? model.key ?? model.catalogId ?? "unknown");
  if (!hasCeiling && claimants.length) {
    return {
      verdict: "fail",
      hasCeiling: false,
      ceilingVariantId: null,
      ceilingQuant,
      claimants,
      reasons: [`${claimants.join(", ")}: reported lossless without a measured ${ceilingQuant} ceiling beside it`],
    };
  }
  if (!hasCeiling) {
    return {
      verdict: "warn",
      hasCeiling: false,
      ceilingVariantId: null,
      ceilingQuant,
      claimants,
      reasons: [`no ${ceilingQuant} ceiling variant measured; smaller quants cannot claim a tie or a win`],
    };
  }
  return { verdict: "pass", hasCeiling: true, ceilingVariantId, ceilingQuant, claimants, reasons: [] };
}

/**
 * Sign-flip (permutation) test on paired differences (S2): under no difference
 * each difference is as likely positive as negative, so the two-sided p-value
 * is the share of sign assignments whose absolute sum reaches the observed
 * one. Exact enumeration up to 20 non-zero differences, then a seeded Monte
 * Carlo, so results reproduce exactly. Uniform magnitudes reduce to McNemar.
 */
const SIGN_FLIP_EXACT_LIMIT = 20;
const SIGN_FLIP_PERMUTATIONS = 10000;

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

export function signFlipPValue(differences, { exactLimit = SIGN_FLIP_EXACT_LIMIT, permutations = SIGN_FLIP_PERMUTATIONS } = {}) {
  const nonzero = differences.filter((value) => value !== 0);
  const count = nonzero.length;
  if (!count) return 1;
  const neg = nonzero.filter((value) => value < 0).length;
  const pos = count - neg;
  // Every difference the same size: the sum is decided by the sign counts alone.
  if (nonzero.every((value) => Math.abs(value) === Math.abs(nonzero[0]))) return mcnemarExact(neg, pos);
  const observed = Math.abs(nonzero.reduce((sum, value) => sum + value, 0));
  if (count <= exactLimit) {
    const total = 2 ** count;
    let extreme = 0;
    for (let mask = 0; mask < total; mask += 1) {
      let sum = 0;
      for (let index = 0; index < count; index += 1) sum += (mask >> index) & 1 ? nonzero[index] : -nonzero[index];
      if (Math.abs(sum) >= observed - 1e-12) extreme += 1;
    }
    return extreme / total;
  }
  const random = lcg(0x5EED);
  let extreme = 0;
  for (let draw = 0; draw < permutations; draw += 1) {
    let sum = 0;
    for (const value of nonzero) sum += random() < 0.5 ? value : -value;
    if (Math.abs(sum) >= observed - 1e-12) extreme += 1;
  }
  return extreme / permutations;
}

/** Holm step-down adjustment; returns adjusted p-values in input order. */
export function holm(pValues) {
  const order = pValues.map((p, index) => ({ p, index })).sort((left, right) => left.p - right.p);
  const adjusted = new Array(pValues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, p * (pValues.length - rank)));
    adjusted[index] = running;
  });
  return adjusted;
}

export function itemPassed(prompt) {
  return prompt.total > 0 && prompt.passed === prompt.total && !prompt.error;
}

/** Public-dataset items versus the questions ModelDuck authored itself. */
export function promptOrigin(prompt) {
  if (prompt.origin === "own" || prompt.origin === "public") return prompt.origin;
  if (prompt.source || String(prompt.category ?? "").startsWith("public-")) return "public";
  return "own";
}

/** Dataset label for public items, or "own" for authored questions. */
export function promptDataset(prompt) {
  if (prompt.source?.dataset) return prompt.source.dataset;
  const category = String(prompt.category ?? "");
  if (category.startsWith("public-")) return category.slice(7);
  return "own";
}

/** Item pass rate with a Wilson interval, overall, per category, origin and dataset. */
export function itemSummary(prompts) {
  const summarize = (list) => {
    const passed = list.filter(itemPassed).length;
    return { passed, total: list.length, rate: list.length ? Number(((passed / list.length) * 100).toFixed(1)) : 0, ci95: wilson(passed, list.length) };
  };
  const byCategory = {};
  const byOrigin = {};
  const byDataset = {};
  for (const prompt of prompts) {
    (byCategory[prompt.category || "other"] ??= []).push(prompt);
    (byOrigin[promptOrigin(prompt)] ??= []).push(prompt);
    (byDataset[promptDataset(prompt)] ??= []).push(prompt);
  }
  return {
    ...summarize(prompts),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([category, list]) => [category, summarize(list)])),
    byOrigin: Object.fromEntries(Object.entries(byOrigin).map(([origin, list]) => [origin, summarize(list)])),
    byDataset: Object.fromEntries(Object.entries(byDataset).map(([dataset, list]) => [dataset, summarize(list)])),
  };
}

function outcomes(model) {
  return new Map((model.prompts ?? []).map((prompt) => [prompt.id, itemPassed(prompt)]));
}

/**
 * Pairs each variant's items with the baseline's. A failure needs either a
 * floor breach (overall item pass rate down by FLOOR_DROP_POINTS or more) or a
 * variant whose decline survives Holm-corrected exact McNemar at ALPHA; any
 * smaller decline is a warning that names the items.
 */
export function compareRuns(current, baseline, { enforceCeiling = false } = {}) {
  const ceiling = losslessCeilingGate(current);
  const previous = new Map((baseline.models ?? []).map((model) => [model.variantId ?? model.key, model]));
  const variants = [];
  const failed = [];
  for (const model of current.models ?? []) {
    // A variant that failed before producing any answer fails the gate outright instead of
    // passing it quietly; it is still not paired as a regression against the baseline.
    if (!model.prompts?.length) {
      failed.push(model.variantId ?? model.key);
      continue;
    }
    const before = previous.get(model.variantId ?? model.key);
    if (!before) continue;
    const then = outcomes(before);
    const regressed = [];
    const improved = [];
    let paired = 0;
    for (const [id, passedNow] of outcomes(model)) {
      if (!then.has(id)) continue;
      paired += 1;
      if (then.get(id) && !passedNow) regressed.push(id);
      if (!then.get(id) && passedNow) improved.push(id);
    }
    variants.push({ variantId: model.variantId ?? model.key, paired, regressed, improved, p: mcnemarExact(regressed.length, improved.length) });
  }
  const adjusted = holm(variants.map((variant) => variant.p));
  variants.forEach((variant, index) => {
    variant.pAdjusted = Number(adjusted[index].toFixed(4));
    variant.p = Number(variant.p.toFixed(4));
    variant.significantDecline = variant.regressed.length > variant.improved.length && adjusted[index] < ALPHA;
  });

  const pairedIds = new Set(variants.map((variant) => variant.variantId));
  const rate = (run) => itemSummary((run.models ?? []).filter((model) => pairedIds.has(model.variantId ?? model.key)).flatMap((model) => model.prompts ?? [])).rate;
  const currentRate = rate(current);
  const baselineRate = rate(baseline);
  const drop = Number((baselineRate - currentRate).toFixed(1));

  const reasons = [];
  if (failed.length) reasons.push(`${failed.join(", ")}: no answers recorded (the variant failed before answering)`);
  if (drop >= FLOOR_DROP_POINTS) reasons.push(`item pass rate fell ${drop} pts (${baselineRate}% -> ${currentRate}%), at or past the ${FLOOR_DROP_POINTS}-pt floor`);
  for (const variant of variants.filter((item) => item.significantDecline)) {
    reasons.push(`${variant.variantId}: ${variant.regressed.length} items regressed vs ${variant.improved.length} improved (Holm p=${variant.pAdjusted})`);
  }
  const declines = variants.filter((variant) => variant.regressed.length > 0);
  let verdict = reasons.length ? "fail" : declines.length ? "warn" : "pass";
  const mergedReasons = [...reasons];
  // No shared variants means nothing to compare: warn instead of passing a
  // vacuous gate (a run whose models all failed still fails above).
  if (variants.length === 0 && (current.models ?? []).length > 0 && verdict === "pass") {
    verdict = "warn";
    mergedReasons.push("No shared variants: the runs share no model ids, so there is nothing to compare.");
  }
  if (enforceCeiling && ceiling.verdict === "fail") {
    verdict = "fail";
    mergedReasons.push(...ceiling.reasons);
  } else if (enforceCeiling && ceiling.verdict === "warn") {
    // A ceiling shortfall warns even alongside minor regressions: the tie
    // cannot be called either way regardless of the pairwise verdict.
    if (verdict === "pass") verdict = "warn";
    mergedReasons.push(...ceiling.reasons);
  }
  return { verdict, reasons: mergedReasons, currentRate, baselineRate, drop, variants, failed, ceiling };
}
