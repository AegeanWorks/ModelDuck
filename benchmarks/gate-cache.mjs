import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "../src/fs-atomic.js";
import { settingsKey } from "./tune-measure.mjs";

/**
 * IDEA-1764: the gate's fingerprinted answer cache.
 *
 * The gate reuses a measured answer only when the world that produced it is
 * bit-for-bit the one it is judging. The reuse identity digests the whole
 * `currentFingerprint` (suite, task hash, tuner version, model file and size,
 * cpu/cores/platform/arch, node-llama-cpp) plus a content digest of the files
 * that decide sampled answers and their scoring. Any axis change discards the
 * stale cache file — a fresh gate again measures everything.
 */

export const GATE_CACHE_SCHEMA = 1;

/** Files whose content can change sampled answers or how answers score. */
export const GENERATION_PATH_FILES = Object.freeze([
  "src/engine.js",
  "src/sampler-chain.js",
  "src/checkpoint-policy.js",
  "src/config.js",
  "benchmarks/tune.mjs",
  "benchmarks/tune-evaluate.mjs",
  "benchmarks/tune-measure.mjs",
  "benchmarks/tasks.mjs",
  "benchmarks/tune-gate.mjs",
]);

/** Where one model's gate cache lives; `benchmarks/results/` is gitignored. */
export function gateCacheFile(root, modelId) {
  const safeId = String(modelId).replace(/[^a-z0-9._-]/gi, "_");
  return path.join(root, "benchmarks", "results", "gate-cache", `${safeId}.json`);
}

/** Content digest of the generation-path files, missing files included. */
export async function generationDigest(root, files = GENERATION_PATH_FILES) {
  const hashes = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(root, file), "utf8").catch(() => null);
      return `${file}:${content === null ? "missing" : createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
    }),
  );
  return createHash("sha256").update(hashes.join("\n")).digest("hex").slice(0, 32);
}

/** The reuse identity: the whole world fingerprint plus the code digest. */
export function gateFingerprint(fingerprint = {}, codeDigest) {
  const sorted = Object.fromEntries(Object.entries(fingerprint).sort(([left], [right]) => (left < right ? -1 : 1)));
  return createHash("sha256").update(JSON.stringify({ ...sorted, generationCode: codeDigest })).digest("hex").slice(0, 32);
}

/**
 * One model's saved answers, or null when the file is missing, corrupt, or
 * stamped with a different fingerprint. Corrupt or stale caches are discarded
 * (a fresh measurement covers them), never repaired from partial data.
 */
export async function loadGateCache(file, fingerprint) {
  let record = null;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (record?.schema !== GATE_CACHE_SCHEMA || record.fingerprint !== fingerprint) return null;
  const groups = Array.isArray(record.groups)
    ? record.groups.filter((group) => group && Array.isArray(group.rows))
    : [];
  return { groups, cachedAt: record.savedAt ?? null, runs: Number(record.runs) || 0 };
}

/** Save the merged cache atomically (tmp + rename, PRINCIPLE-013). */
export async function saveGateCache(file, { fingerprint, groups, runs = 0 }) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, {
    schema: GATE_CACHE_SCHEMA,
    fingerprint,
    savedAt: new Date().toISOString(),
    runs: Math.max(0, Math.round(runs)) + 1,
    groups,
  });
}

/**
 * Merge restored groups with the answers measured in this run. Fresh answers
 * win per (settings, seed, item); untouched cached rows survive so a partial
 * miss keeps its coverage instead of starting over.
 */
export function mergeAnswerGroups(savedGroups = [], freshGroups = []) {
  const merged = new Map();
  for (const group of [...savedGroups, ...freshGroups]) {
    if (!group || typeof group !== "object") continue;
    const key = `${settingsKey(group.settings ?? {})}|${group.seed}`;
    const slot = merged.get(key) ?? { settings: group.settings ?? {}, seed: group.seed, rows: new Map() };
    for (const row of group.rows ?? []) {
      if (!row || (row.id ?? row.item) === undefined) continue;
      slot.rows.set(String(row.id ?? row.item), row);
    }
    merged.set(key, slot);
  }
  return [...merged.values()].map((slot) => ({
    settings: slot.settings,
    seed: slot.seed,
    rows: [...slot.rows.values()],
  }));
}

/** Row count helper for the gate's reuse report. */
export function cachedRowCount(groups = []) {
  return groups.reduce((sum, group) => sum + (group?.rows?.length ?? 0), 0);
}

/**
 * IDEA-1765: the tripwire window — `size` consecutive items of the last rung,
 * rotating by `runIndex` so consecutive gates cover the whole rung instead of
 * freezing the same items. A rung no larger than the window needs no probe.
 */
export function tripwireWindow(allIds, runIndex = 0, size = 12) {
  if (!Array.isArray(allIds) || !Number.isFinite(size) || size < 1) return null;
  if (allIds.length <= size) return null;
  const shift = (Math.max(0, Math.round(runIndex)) * size) % allIds.length;
  const window = [];
  for (let index = 0; index < size; index += 1) window.push(allIds[(shift + index) % allIds.length]);
  return window;
}

/**
 * IDEA-1765: a probe verdict needs the full rung when any checked item
 * flipped against the baseline, or the baseline has no outcome for a checked
 * item (an unmeasured item cannot prove anything).
 */
export function probeDisagrees(savedOutcomes, probeOutcomes) {
  if (!savedOutcomes || !probeOutcomes) return true;
  for (const [id, outcome] of Object.entries(probeOutcomes)) {
    if (savedOutcomes[id] === undefined) return true;
    if (Number(savedOutcomes[id]) !== Number(outcome)) return true;
  }
  return false;
}
