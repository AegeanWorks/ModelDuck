import { TASKS } from "../benchmarks/tasks.mjs";
import { AppError } from "./errors.js";
import { currentFingerprint, loadProfile, presetFor, profileIdFor, typeWarnings } from "./model-profiles.js";

/**
 * Applies a model's measured profile (ADR-027, G-004): its load settings at
 * load time and the chosen task's sampling preset at chat time, unless the
 * user turned tuned settings off.
 */
export class TunedSettings {
  #profilesDir;
  #registry;
  #settings;
  #fingerprint;

  constructor({ profilesDir, registry, settings, fingerprint = currentFingerprint }) {
    this.#profilesDir = profilesDir;
    this.#registry = registry;
    this.#settings = settings;
    this.#fingerprint = fingerprint;
  }

  /**
   * The settings patch for a model (and task), with what it came from, or null
   * when nothing tuned applies. A stale profile still applies, with warnings.
   */
  async resolve(modelId, task = null) {
    if (task !== null && !TASKS.some((item) => item.id === task)) {
      throw new AppError("Unknown task", {
        code: "unknown_task",
        why: `"${task}" is not a tuned task.`,
        fix: `Use one of: ${TASKS.map((item) => item.id).join(", ")}.`,
      });
    }
    if (!this.#profilesDir || this.#settings.value.useTunedProfile === false) return null;
    const entry = modelId ? this.#registry?.findById(modelId) : null;
    if (!entry) return null;
    const catalogId = profileIdFor(entry.fileName);
    const loaded = await loadProfile(this.#profilesDir, catalogId, await this.#fingerprint(entry));
    if (!loaded) return null;
    const { profile, stale, warnings } = loaded;
    const speedPreset = ["fastest", "light", "quiet"].includes(this.#settings.value.speedPreset) ? this.#settings.value.speedPreset : "fastest";
    const chosen = task && profile.tasks?.[task];
    return {
      catalogId,
      task: task && profile.tasks?.[task] ? task : null,
      speedPreset,
      settings: presetFor(profile, task, speedPreset),
      stages: profile.stages ?? null,
      // What this preset scored, and the question types it answers clearly worse (ADR-068).
      rate: chosen?.stats?.rate ?? null,
      typeWarnings: task ? typeWarnings(profile)[task] ?? [] : [],
      stale,
      warnings,
    };
  }
}

/**
 * IDEA-1071: what a tuned patch would change, before it is applied. One row
 * per key the profile sets differently from the current settings.
 */
export function diffSettings(current, patch) {
  const rows = [];
  for (const [key, to] of Object.entries(patch ?? {})) {
    const from = current?.[key];
    const same = Array.isArray(to) || Array.isArray(from)
      ? JSON.stringify(from) === JSON.stringify(to)
      : Object.is(from, to);
    if (!same) rows.push({ key, from: from ?? null, to: to ?? null });
  }
  rows.sort((left, right) => String(left.key).localeCompare(String(right.key)));
  return rows;
}
