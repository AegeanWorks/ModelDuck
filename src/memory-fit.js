/**
 * Estimates the memory a load needs before it starts, so a model that will not
 * fit is refused with a remedy instead of pushing the machine into swap. At
 * batch 1 the binding constraint on 8 GB is weights plus the KV cache, which
 * grows linearly with context: 2 (K and V) x layers x KV heads x head size x
 * bytes per element, per token.
 */

import { AppError } from "./errors.js";

const KV_BYTES_PER_ELEMENT = Object.freeze({
  f16: 2,
  q8_0: 34 / 32, // 32 int8 values plus one f16 scale per block
  q4_0: 18 / 32, // 32 nibbles plus one f16 scale per block
});

/**
 * Split a KV cache label into its key and value types. A "K:V" label tunes
 * them separately (lit §3: K-precision dominates, V tolerates coarse types);
 * a bare label uses one type for both. Unknown parts fall back to f16.
 */
export function splitKvCache(label) {
  const [key, value] = String(label ?? "f16").split(":");
  const known = (part) => (Object.hasOwn(KV_BYTES_PER_ELEMENT, part) ? part : "f16");
  return { key: known(key), value: known(value ?? key) };
}
export const RUNTIME_RESERVE_BYTES = 256 * 1024 ** 2; // compute buffers and the runtime itself
export const COMFORTABLE_RATIO = 0.6;
// Budgeting against momentary free memory makes the same PC tune different
// contexts depending on what else runs (M7). Against the total, keep this much
// for the OS, the runtime and anything else on the machine.
export const MEMORY_RESERVE_BYTES = 1 * 1024 ** 3;
export const FIT_LIMIT_RATIO = 0.75;
const CONTEXT_STEP = 512;

/** Reads the KV shape from GGUF architecture metadata; null when it is incomplete. */
export function kvShapeFromMetadata(architectureMetadata) {
  const layers = Number(architectureMetadata?.block_count);
  const heads = Number(architectureMetadata?.attention?.head_count);
  const kvHeads = Number(architectureMetadata?.attention?.head_count_kv ?? heads);
  const keyLength = Number(architectureMetadata?.attention?.key_length); // aikit:allow-secret attention size
  const headDim = keyLength || Number(architectureMetadata?.embedding_length) / heads;
  const shape = { layers, kvHeads, headDim };
  return Object.values(shape).every((value) => Number.isFinite(value) && value > 0) ? shape : null;
}

export function kvBytesPerToken(shape, kvCache = "f16") {
  if (!shape) return null;
  // A mixed cache stores K and V at different precisions: the per-token cost
  // is the mean of the two element sizes, times both sides (lit §3).
  const { key, value } = splitKvCache(kvCache);
  const element = ((KV_BYTES_PER_ELEMENT[key] ?? KV_BYTES_PER_ELEMENT.f16) +
    (KV_BYTES_PER_ELEMENT[value] ?? KV_BYTES_PER_ELEMENT.f16)) / 2;
  return Math.ceil(2 * shape.layers * shape.kvHeads * shape.headDim * element);
}

export function estimateLoad({ modelBytes, shape, contextSize, kvCache }) {
  const perToken = kvBytesPerToken(shape, kvCache); // aikit:allow-secret KV cache size
  const kv = perToken === null ? null : perToken * contextSize;
  const weights = Number(modelBytes) || 0;
  return {
    weights,
    kv,
    overhead: RUNTIME_RESERVE_BYTES,
    total: weights + (kv ?? 0) + RUNTIME_RESERVE_BYTES,
    contextSize,
    kvCache,
    estimator: "v1",
  };
}

/**
 * Normalize the runtime's V2 context requirements to the estimateLoad shape
 * (M7). V2 simulates the real allocator, so it accounts for batch size,
 * sequences, flash attention, K/V types, mmap and offloaded layers, where the
 * formula above only scales the KV cache with context. `requirements` is the
 * {cpuRam, gpuVram} pair; weights stay the file size, and the graph/compute
 * buffers already live inside the V2 split, so overhead is zero.
 */
export function estimateLoadV2({ requirements, weights, contextSize, kvCache }) {
  const cpuRam = Math.max(0, Number(requirements?.cpuRam) || 0);
  const gpuVram = Math.max(0, Number(requirements?.gpuVram) || 0);
  const w = Number(weights) || 0;
  return {
    weights: w,
    kv: cpuRam + gpuVram,
    overhead: 0,
    total: w + cpuRam + gpuVram,
    contextSize,
    kvCache,
    estimator: "v2",
    vram: gpuVram,
  };
}

function largestContextWithin(budget, { modelBytes, shape, kvCache }) {
  const perToken = kvBytesPerToken(shape, kvCache); // aikit:allow-secret KV cache size
  const room = budget - (Number(modelBytes) || 0) - RUNTIME_RESERVE_BYTES;
  if (!perToken || room <= 0) return 0;
  return Math.floor(room / perToken / CONTEXT_STEP) * CONTEXT_STEP;
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * The context size a tune uses (ADR-043): the largest of `steps` whose load fits
 * and the model was trained for. The short test questions cannot tell context
 * sizes apart, so memory decides; with nothing fitting, or the KV shape
 * unknown, the smallest step is used.
 *
 * Prefer `totalBytes` (the device's total memory minus `reserveBytes`, M7):
 * momentary free memory includes whatever else runs — even the server's own
 * loaded model — so the same PC tunes different contexts on different days.
 * With only `availableBytes`, the old 60%-of-free rule applies. Either way the
 * inputs are returned, so a profile says what budget it assumed.
 */
export function budgetContext({ steps, modelBytes, shape, kvCache = "f16", availableBytes, totalBytes = null, reserveBytes = MEMORY_RESERVE_BYTES, trainContext = Infinity }) {
  const sizes = [...(steps ?? [])].map(Number).filter((size) => size > 0).sort((left, right) => left - right);
  // No sizes is a caller bug, not a tight budget: refusing loudly beats
  // choosing `undefined` and poisoning the tune winner downstream.
  if (!sizes.length) {
    throw new AppError("No context sizes to budget", {
      code: "empty_context_steps",
      why: "The context step list is empty, so there is no size to choose.",
      fix: "List at least one context size, e.g. [2048, 4096, 8192].",
    });
  }
  const smallest = sizes[0];
  const inputs = {
    modelBytes: Number(modelBytes) || null,
    kvCache,
    trainContext,
    ...(totalBytes ? { totalBytes, reserveBytes } : { availableBytes: availableBytes ?? null }),
  };
  if (!kvBytesPerToken(shape, kvCache) || !((totalBytes ?? 0) > 0 || (availableBytes ?? 0) > 0)) {
    return { contextSize: smallest, reason: `Memory or the model's KV shape is unknown, so the smallest listed context (${smallest}) is used.`, inputs };
  }
  const budget = (totalBytes ?? 0) > 0 ? totalBytes - reserveBytes : availableBytes * COMFORTABLE_RATIO;
  const basis = (totalBytes ?? 0) > 0 ? `${gib(totalBytes)} total minus ${gib(reserveBytes)} reserved` : `${gib(availableBytes)} free`;
  const fits = (size) => estimateLoad({ modelBytes, shape, contextSize: size, kvCache }).total <= budget;
  const usable = sizes.filter((size) => size <= trainContext && fits(size));
  if (!usable.length) {
    return { contextSize: smallest, reason: `No listed size fits in ${basis}, so the smallest (${smallest}) is used.`, inputs: { ...inputs, budget } };
  }
  const contextSize = usable.at(-1);
  const capped = sizes.some((size) => size > contextSize && size > trainContext && fits(size));
  return {
    contextSize,
    reason: `${contextSize} is the largest listed context that fits in ${basis} with a ${kvCache} KV cache` +
      `${capped ? `; the model was trained for ${trainContext}` : ""}.`,
    inputs: { ...inputs, budget },
  };
}

/**
 * "comfortable" under 60 % of available memory, "tight" up to 75 %, and
 * "will_not_fit" above that. "unknown" when the KV shape is missing, which
 * never blocks a load.
 */
export function fitVerdict({ estimate, availableBytes, shape = null, modelBytes = estimate?.weights, kvCache = estimate?.kvCache }) {
  if (!estimate || typeof estimate.total !== "number" || !Number.isFinite(estimate.total) || estimate?.kv === null || !(availableBytes > 0)) {
    return { verdict: "unknown", ratio: null, availableBytes: availableBytes ?? null, largestSafeContext: null };
  }
  const ratio = estimate.total / availableBytes;
  const verdict = ratio <= COMFORTABLE_RATIO ? "comfortable" : ratio <= FIT_LIMIT_RATIO ? "tight" : "will_not_fit";
  const largestSafeContext = shape
    ? largestContextWithin(availableBytes * FIT_LIMIT_RATIO, { modelBytes, shape, kvCache })
    : null;
  return { verdict, ratio: Number(ratio.toFixed(3)), availableBytes, largestSafeContext };
}
