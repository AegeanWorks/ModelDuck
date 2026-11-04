import { RUNTIME_RESERVE_BYTES, estimateLoad, fitVerdict } from "./memory-fit.js";

/**
 * What to run on this machine (ADR-069): installed models ranked by what they
 * actually measured here (right answers for the task, then speed), with a
 * memory-fit verdict; catalog models that are not installed are listed as
 * estimates, since their speed cannot be known before they are downloaded.
 */

const DEFAULT_CONTEXT = 2048;
const LIMIT = 5;

/**
 * IDEA-1623: fixed-total-bytes rule. Memory math is always fixed bytes —
 * weights plus KV plus the runtime reserve — never a ratio or a hidden
 * scale. The helper is the single place both recommenders total through,
 * so a weights-only estimate still carries the reserve.
 */
export const FIXED_BYTES_OVERHEAD = RUNTIME_RESERVE_BYTES;

export function totalBytesWithReserve({ sizeBytes = 0, kvBytes = 0 } = {}) {
  const size = Math.max(0, Number(sizeBytes) || 0);
  const kv = Math.max(0, Number(kvBytes) || 0);
  return size + kv + RUNTIME_RESERVE_BYTES;
}

const fitText = (fit) => ({
  comfortable: "fits comfortably",
  tight: "fits tightly",
  unknown: "fit unknown (no KV shape)",
  will_not_fit: "will not fit",
}[fit] ?? fit);

/** Installed models that fit, measured ones first, ranked by quality then speed. */
export function recommendModels({ models, profiles = {}, memory = {}, task = "code", limit = LIMIT }) {
  const available = Number(memory.free) || 0;
  const rows = models.map((model) => {
    const profile = profiles[model.profileId] ?? profiles[model.id] ?? null;
    const preset = profile?.tasks?.[task] ?? null;
    const load = profile?.load?.settings ?? {};
    const kvCache = load.kvCache ?? "f16";
    const contextSize = Number(load.contextSize) || DEFAULT_CONTEXT;
    const estimate = estimateLoad({ modelBytes: model.size, shape: model.kvShape ?? null, contextSize, kvCache });
    const totalBytes = totalBytesWithReserve({ sizeBytes: model.size, kvBytes: estimate.kv ?? 0 });
    const verdict = fitVerdict({ estimate, availableBytes: available, shape: model.kvShape ?? null, modelBytes: model.size, kvCache });
    // Without a KV shape the fit is weights plus the runtime reserve, which is still useful.
    const fit = verdict.verdict === "unknown"
      ? (available > 0 && estimate.total <= available * 0.75 ? "comfortable" : available > 0 ? "will_not_fit" : "unknown")
      : verdict.verdict;
    const rate = preset?.stats?.rate ?? null;
    const tokensPerSecond = preset?.stats?.tokensPerSecond ?? null;
    const measured = Number.isFinite(rate);
    return {
      id: model.id,
      name: model.name,
      fileName: model.fileName,
      profileId: model.profileId,
      measured,
      rate,
      tokensPerSecond,
      contextSize,
      memoryBytes: totalBytes,
      fit,
      why: measured
        ? `Measured on this PC: ${rate}% on ${task}${Number.isFinite(tokensPerSecond) ? `, ${tokensPerSecond} tok/s` : ""}; ${fitText(fit)}.`
        : profile
          ? `Profile present but no measured ${task} rate here; ${fitText(fit)}.`
          : `Not tuned yet; ${fitText(fit)}.`,
    };
  });
  const usable = rows.filter((row) => row.fit !== "will_not_fit");
  usable.sort((left, right) =>
    Number(right.measured) - Number(left.measured) ||
    (right.rate ?? -1) - (left.rate ?? -1) ||
    (right.tokensPerSecond ?? -1) - (left.tokensPerSecond ?? -1) ||
    left.memoryBytes - right.memoryBytes ||
    left.name.localeCompare(right.name));
  return usable.slice(0, limit);
}

/** Catalog models that are not installed and whose weights fit; marked recommended ones first. */
export function recommendCatalog({ catalog = [], installed = [], memory = {}, limit = LIMIT }) {
  const have = new Set(installed);
  const available = Number(memory.free) || 0;
  return catalog
    .filter((model) => !have.has(model.id) && Number(model.size) > 0)
    .map((model) => {
      const totalBytes = totalBytesWithReserve({ sizeBytes: model.size });
      return {
        id: model.id,
        name: model.name,
        params: model.params ?? null,
        quant: model.quant ?? null,
        sizeBytes: Number(model.size),
        totalBytes,
        recommended: model.recommended === true,
        fit: available > 0 && totalBytes <= available * 0.75 ? "fits (weights and runtime only)" : "too large",
      };
    })
    .filter((model) => model.fit === "fits (weights and runtime only)")
    .sort((left, right) => Number(right.recommended) - Number(left.recommended) || left.sizeBytes - right.sizeBytes || left.name.localeCompare(right.name))
    .slice(0, limit);
}
