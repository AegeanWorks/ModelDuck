import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "./errors.js";
import { importRecipe } from "./model-profiles.js";

/** Where the measured presets ship (benchmarks/presets/README.md). */
export const SHIPPED_PRESETS_DIR = fileURLToPath(new URL("../benchmarks/presets/", import.meta.url));

/** The machine a recipe's load settings were measured on: change one and the load must be measured again. */
const MACHINE_KEYS = Object.freeze(["cpu", "cores", "platform", "arch"]);

/** What changed since the recipe was measured that does not stop it from applying, said plainly. */
const DRIFT = Object.freeze({
  suiteVersion: (then, now) => `measured on test suite v${then}, this is v${now}`,
  tunerVersion: (then, now) => `measured with tuner v${then}, this is v${now}`,
  nodeLlamaCpp: (then, now) => `measured on node-llama-cpp ${then}, this is ${now}`,
});

/**
 * How a shipped recipe fits this computer and this model file:
 *
 * - `exact`: same model file (name and size) on the same machine. Load settings
 *   and task presets both apply.
 * - `portable`: same model file on another machine. The task presets (sampling
 *   and prompt) apply; the load settings (device, GPU layers, threads) were
 *   measured on other hardware and stay at this machine's defaults until the
 *   Device and Speed stages measure them here.
 * - `none`: another model file, so nothing applies.
 *
 * `reasons` lists what differs, so an older measurement is said, not hidden.
 */
export function matchPreset(recipe, current) {
  const then = recipe?.fingerprint;
  if (!then || !current) return { status: "none", keeps: [], reasons: ["the preset or this model has no fingerprint"], next: null };
  if (then.modelFile !== current.modelFile || then.modelSize !== current.modelSize) {
    return { status: "none", keeps: [], reasons: [`measured on ${then.modelFile} (${then.modelSize} bytes), not this file`], next: null };
  }
  const reasons = Object.entries(DRIFT)
    .filter(([key]) => then[key] != null && then[key] !== current[key])
    .map(([key, say]) => say(then[key], current[key]));
  const machine = MACHINE_KEYS.filter((key) => then[key] !== current[key]);
  if (!machine.length) return { status: "exact", keeps: ["load", "tasks"], reasons, next: null };
  return {
    status: "portable",
    keeps: ["tasks"],
    reasons: [`load settings were measured on ${then.cpu} (${then.cores} threads, ${then.platform}), not this computer`, ...reasons],
    next: "Run the Device and Speed stages (about a minute) to fit the load settings to this computer.",
  };
}

/**
 * The profile a matched recipe becomes: an imported profile (ADR-067) that
 * says it came from a shipped preset. A portable match leaves the load at the
 * defaults. It never counts as tuned here, so a later tune measures every stage.
 */
export function presetProfile(recipe, match) {
  if (match?.status !== "exact" && match?.status !== "portable") {
    throw new AppError("This preset does not fit this model", {
      code: "preset_no_match",
      status: 409,
      why: match?.reasons?.join("; ") || "The preset was measured on another model file.",
      fix: "Tune this model instead: Bench & Tune → Quick pass.",
    });
  }
  const profile = importRecipe(match.status === "exact" ? recipe : { ...recipe, load: { settings: {}, stats: null }, speed: null });
  return { ...profile, search: { ...profile.search, preset: { status: match.status, source: "shipped" } } };
}

/** Every valid shipped recipe in `dir`; an unreadable or invalid file is skipped. */
export async function readShippedPresets(dir = SHIPPED_PRESETS_DIR) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  const presets = [];
  for (const name of names.filter((item) => item.endsWith(".modelduck-profile.json")).sort()) {
    try {
      const recipe = JSON.parse(await fs.promises.readFile(path.join(dir, name), "utf8"));
      importRecipe(recipe);
      presets.push(recipe);
    } catch {
      // A broken preset file must not hide the others.
    }
  }
  return presets;
}
