import { DEFAULT_SETTINGS, normalizeSettings } from "./config.js";
import { AppError } from "./errors.js";
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

/**
 * IDEA-1097: validate the settings version on load.
 * A newer file must never be silently downgraded by an older build. No
 * version means a file from before the fence and loads; a whole number (or
 * one written as a numeric string) up to SETTINGS_VERSION loads; anything
 * else is refused before the file is read further, so it is left untouched.
 */
function validateSettingsVersion(data, file) {
  if (!data || typeof data !== "object" || data.version === undefined || data.version === null) return;
  const raw = data.version;
  const version = typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  const refuse = (message, why, fix) => new AppError(message, { code: "settings_version_unsupported", why, fix });
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw refuse(
      "The settings file has an unreadable version",
      `${file ?? "settings.json"} says version ${JSON.stringify(raw)}; a version is a whole number, and this ModelDuck reads up to ${SETTINGS_VERSION}.`,
      "Fix the version in the file, or move the file away to start from default settings.",
    );
  }
  if (version > SETTINGS_VERSION) {
    throw refuse(
      `Settings file version ${version} is newer than supported version ${SETTINGS_VERSION}`,
      `${file ?? "settings.json"} was written by a newer ModelDuck (settings version ${version}); this one reads up to ${SETTINGS_VERSION}, and loading it could drop settings it does not know.`,
      "Run the newer ModelDuck, or move the file away to start this one from default settings.",
    );
  }
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
    // IDEA-1097: validate version before processing
    validateSettingsVersion(data, this.#file);
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
