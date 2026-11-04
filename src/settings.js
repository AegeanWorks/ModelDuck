import { DEFAULT_SETTINGS, normalizeSettings } from "./config.js";
import { readJsonWithQuarantine, writeJsonAtomic } from "./fs-atomic.js";

export const SETTINGS_VERSION = 1;

/** IDEA-1097: drop unknown keys so a newer file can never silently widen this one. */
export function fenceSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const fenced = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(patch, key)) fenced[key] = patch[key];
  }
  return fenced;
}

/** IDEA-1097: merge nested objects instead of dropping their keys on update. */
export function mergeSettingsDeep(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      next[key] !== null &&
      typeof next[key] === "object" &&
      !Array.isArray(next[key])
    ) {
      next[key] = { ...next[key], ...value };
    } else {
      next[key] = value;
    }
  }
  return next;
}

export class SettingsStore {
  #value;
  #file;
  #logger;

  constructor({ file, logger = console }) {
    this.#file = file;
    this.#logger = logger;
    this.#value = normalizeSettings({});
  }

  get value() {
    return { ...this.#value, customStopTriggers: [...this.#value.customStopTriggers] };
  }

  async load() {
    const data = await readJsonWithQuarantine(this.#file, null, { logger: this.#logger });
    const raw = data && typeof data === "object" && data.settings ? data.settings : data;
    this.#value = normalizeSettings(fenceSettingsPatch(raw ?? {}));
    return this.value;
  }

  async update(patch) {
    const next = normalizeSettings(mergeSettingsDeep(this.#value, fenceSettingsPatch(patch)));
    await writeJsonAtomic(this.#file, { version: SETTINGS_VERSION, settings: next });
    this.#value = next;
    return this.value;
  }
}
