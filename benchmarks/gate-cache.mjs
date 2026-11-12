import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "../src/fs-atomic.js";
import { settingsKey } from "./tune-measure.mjs";

/**
 * IDEA-1764: the gate's fingerprinted answer cache.
 *
 * The gate reuses a measured answer only when the world that produced it is
 * bit-for-bit the one it is judging. The reuse identity digests the answer half
 * of that world: the whole `currentFingerprint` (suite, task hash, tuner
 * version, model file and size, cpu/cores/platform/arch, node-llama-cpp) plus a
 * content digest of the files that frame sampled answers — the engine's
 * runtime closure and the drivers that assemble prompts and settings. The
 * judge half (verdicts, stats, orchestration) is NOT part of the reuse
 * identity: its code runs fresh on every gate, so a judge-only change re-judges
 * the same bit-identical answers instead of re-asking them. Any answer-side
 * axis change still discards the stale cache file — a fresh gate again measures
 * everything.
 */

export const GATE_CACHE_SCHEMA = 2;

/**
 * Benchmark drivers that frame the sampled answers: the evaluator's prompt
 * assembly (`tune-evaluate.mjs`), the settings rows `measurePresets` composes
 * (`tune.mjs`) and the measurement defaults (`tune-job.mjs`). An edit to any of
 * these can change an answer, so they belong to the reuse identity. The runtime
 * half of the generation path is not listed here: it is *derived* (see
 * generationPathFiles) so a module the engine imports can never silently fall
 * outside the digest.
 */
export const ANSWER_DRIVER_FILES = Object.freeze([
  "benchmarks/tune.mjs",
  "benchmarks/tune-evaluate.mjs",
  "benchmarks/tune-job.mjs",
]);

/**
 * Judge-only drivers: gate orchestration, verdicts and paired stats
 * (`tune-gate.mjs`, `tune-measure.mjs`) and the rung/holdout order (`tasks.mjs`,
 * whose item content is guarded by `taskHash` in the world fingerprint). Editing
 * them re-judges reused answers, never re-frames them.
 */
export const JUDGE_DRIVER_FILES = Object.freeze([
  "benchmarks/tune-measure.mjs",
  "benchmarks/tasks.mjs",
  "benchmarks/tune-gate.mjs",
]);

/** The digest universe: the answer half plus the judge half. */
export const GATE_DRIVER_FILES = Object.freeze([...ANSWER_DRIVER_FILES, ...JUDGE_DRIVER_FILES]);

/** Where one model's gate cache lives; `benchmarks/results/` is gitignored. */
export function gateCacheFile(root, modelId) {
  const safeId = String(modelId).replace(/[^a-z0-9._-]/gi, "_");
  return path.join(root, "benchmarks", "results", "gate-cache", `${safeId}.json`);
}

const RELATIVE_FROM = /(?:from|import)\s+["'](\.[^"']+)["']/g;

function toRepoPath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/**
 * The runtime generation path: every module reachable from the engine's
 * static import closure. The engine must import an answer-affecting module
 * to run it, so the closure is the self-maintaining source of truth — a new
 * module is invalidated by construction. An unresolvable relative import
 * fails loudly instead of quietly shrinking the digest (dynamic imports
 * are deliberately not chased; the engine loads statically).
 */
export async function generationPathFiles(root, entry = "src/engine.js") {
  const seen = new Set();
  const queue = [entry];
  const files = [];
  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const absolute = path.join(root, current);
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null) {
      throw new Error(`generation path: cannot read ${current} (broken or moved import)`);
    }
    files.push(current);
    for (const match of content.matchAll(RELATIVE_FROM)) {
      const specifier = match[1];
      const resolved = path.resolve(path.dirname(absolute), specifier);
      const repoPath = toRepoPath(root, resolved);
      if (!seen.has(repoPath)) queue.push(repoPath);
    }
  }
  return files.sort();
}

/** Content digest of the given files, missing files included. */
async function contentDigest(root, list) {
  const hashes = await Promise.all(
    list.map(async (file) => {
      const content = await readFile(path.join(root, file), "utf8").catch(() => null);
      return `${file}:${content === null ? "missing" : createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
    }),
  );
  return createHash("sha256").update(hashes.join("\n")).digest("hex").slice(0, 32);
}

/** The full evidence digest: the generation path plus every gate driver. */
export async function generationDigest(root, files = null) {
  const list = files ?? (await generationPathFiles(root)).concat(GATE_DRIVER_FILES).sort();
  return contentDigest(root, list);
}

/** The answer half only: everything a sampled answer depends on, judgers excluded. */
export async function answerDigest(root, files = null) {
  const list = files ?? (await generationPathFiles(root)).concat(ANSWER_DRIVER_FILES).sort();
  return contentDigest(root, list);
}

/** The reuse identity: the whole world fingerprint plus a code digest. */
export function gateFingerprint(fingerprint = {}, codeDigest, codeKey = "generationCode") {
  const sorted = Object.fromEntries(Object.entries(fingerprint).sort(([left], [right]) => (left < right ? -1 : 1)));
  return createHash("sha256").update(JSON.stringify({ ...sorted, [codeKey]: codeDigest })).digest("hex").slice(0, 32);
}

/** The answer cache's reuse identity: the answer side of the world only. */
export function answerFingerprint(fingerprint = {}, digest) {
  return gateFingerprint(fingerprint, digest, "answerCode");
}

/**
 * One model's saved answers, or null when the file is missing, corrupt, on a
 * different schema, or stamped with a different answer identity. Corrupt or
 * stale caches are discarded (a fresh measurement covers them), never repaired
 * from partial data.
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
  return {
    groups,
    cachedAt: record.savedAt ?? null,
    runs: Number(record.runs) || 0,
    judgeDigest: typeof record.judgeDigest === "string" ? record.judgeDigest : null,
  };
}

/** Save the merged cache atomically (tmp + rename, PRINCIPLE-013). `judgeDigest` is evidence of the last judging world, never a reuse key. */
export async function saveGateCache(file, { fingerprint, judgeDigest = null, groups, runs = 0 }) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, {
    schema: GATE_CACHE_SCHEMA,
    fingerprint,
    judgeDigest,
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
