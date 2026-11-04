/**
 * IDEA-1520: single canonical ordered sampler chain.
 *
 * Order (applied identically in engine.js chat and completion paths):
 *   temperature -> topP -> topK -> minP -> repeatPenalty (+ tokens) -> dry -> seed
 *
 * Rationale: temperature first (greedy vs sampling decides whether the rest
 * matter), then the truncation filters in narrowing order (topP, topK, minP),
 * then the repetition penalties, then the deterministic seed. Presets in
 * src/config.js keep mapping onto these same keys, so a preset is just a
 * named entry point into this chain (subsumes IDEA-1380/1523, which each
 * covered only one filter in isolation).
 *
 * Both engine paths build their node-llama-cpp options through
 * `samplerOptions()` below, so the key insertion order — and therefore the
 * effective application order — is identical. `chainSteps()` exposes the same
 * order as data for tests and debugging.
 */

export const SAMPLER_ORDER = Object.freeze([
  "temperature",
  "topP",
  "topK",
  "minP",
  "repeatPenalty",
  "repeatPenaltyTokens",
  "penalizeNewLine",
  "dryStrength",
  "dryBase",
  "dryAllowedLength",
  "seed",
]);

function repeatBlock(normalized) {
  if (!(normalized.repeatPenalty > 1)) return false;
  return {
    penalty: normalized.repeatPenalty,
    lastTokens: normalized.repeatPenaltyTokens,
    penalizeNewLine: normalized.penalizeNewLine !== false,
  };
}

function dryBlock(normalized) {
  if (!(normalized.dryStrength > 0)) return false;
  return {
    strength: normalized.dryStrength,
    base: normalized.dryBase,
    allowedLength: normalized.dryAllowedLength,
  };
}

/**
 * Ordered sampler steps for `normalized` settings. Each entry is
 * `{ name, value }` in canonical application order; disabled blocks carry
 * `value: false` so the chain shape is stable across greedy and sampling
 * runs. Pure: input key order never affects output order.
 */
export function chainSteps(normalized = {}) {
  return [
    { name: "temperature", value: normalized.temperature },
    { name: "topP", value: normalized.topP },
    { name: "topK", value: normalized.topK },
    { name: "minP", value: normalized.minP },
    { name: "repeatPenalty", value: repeatBlock(normalized) },
    { name: "dryStrength", value: dryBlock(normalized) },
    { name: "seed", value: normalized.seed >= 0 ? normalized.seed : undefined },
  ];
}

/** Names of the chain in order, for order-determinism tests. */
export function chainOrder() {
  return chainSteps({}).map((step) => step.name);
}

/**
 * Sampler options in canonical order for node-llama-cpp. Spreads into the
 * chat/completion option objects in engine.js so both paths share one order.
 */
export function samplerOptions(normalized = {}) {
  return {
    temperature: normalized.temperature,
    topP: normalized.topP,
    topK: normalized.topK,
    minP: normalized.minP,
    repeatPenalty: repeatBlock(normalized),
    dryRepeatPenalty: dryBlock(normalized),
    seed: normalized.seed >= 0 ? normalized.seed : undefined,
  };
}

/**
 * Full generation options in canonical order: sampler chain first, then the
 * non-sampler fields ( caps, stops, grammar, wiring ). Keeps both engine
 * paths identical beyond their path-specific caps.
 */
export function orderedSamplerKeys() {
  return ["temperature", "topP", "topK", "minP", "repeatPenalty", "dryRepeatPenalty", "seed"];
}
