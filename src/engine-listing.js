import fs from "node:fs/promises";
import path from "node:path";

import { engineContext } from "./engine-catalog.js";
import { AppError } from "./errors.js";
import { profileIdFor } from "./model-profiles.js";

/**
 * The engines this machine can serve a model with, asked of the catalog (ADR-160), for the API and the UI (ADR-170).
 * `canServe(id)` is the check the load route makes before it hands an engine id to the router, so an unknown or
 * measure-only engine is refused with a Why and a Fix instead of silently falling back to the in-process one.
 */
export function createEngineListing({ catalog, registry, profilesDir = null, context = () => engineContext({ registry }) }) {
  const listed = () => catalog.descriptors().flatMap((descriptor) => descriptor.adapters(context()).map((adapter) => ({ id: adapter.id, label: adapter.label })));

  const servable = (id) => catalog.isServable(id) && catalog.resolve(id, context()) !== null;

  /** What `tune`/`npm run engines` measured for this model, by engine id; empty when nothing was measured. */
  async function measured(modelId) {
    const entry = modelId ? registry?.findById(modelId) : null;
    if (!entry || !profilesDir) return new Map();
    try {
      const saved = JSON.parse(await fs.readFile(path.join(profilesDir, `${profileIdFor(entry.fileName)}.engines.json`), "utf8"));
      return new Map((saved.results ?? []).map((result) => [result.id, { genTps: result.genTps ?? null, promptTps: result.promptTps ?? null, ok: result.ok === true, assessedAt: saved.assessedAt ?? null }]));
    } catch {
      return new Map();
    }
  }

  return Object.freeze({
    canServe: servable,
    /** Every engine the catalog offers; `servable` ones may be chosen on load. `fastest` is the measured best for `modelId`, if any. */
    async list(modelId = null) {
      const speeds = await measured(modelId);
      const engines = listed().map(({ id, label }) => ({
        id,
        label,
        servable: servable(id),
        version: catalog.version(id, context()),
        measured: speeds.get(id) ?? null,
      }));
      const ranked = engines.filter((engine) => engine.servable && engine.measured?.ok && Number.isFinite(engine.measured.genTps)).sort((a, b) => b.measured.genTps - a.measured.genTps);
      return { engines, fastest: ranked[0]?.id ?? null };
    },
    /** Throws a refusal naming the engines that can be chosen when `id` cannot be served here. */
    assertServable(id) {
      if (servable(id)) return;
      const choices = listed().map((engine) => engine.id).filter(servable);
      throw new AppError("That engine cannot serve this model", {
        status: 400,
        code: "engine_unknown",
        why: `${id} is not an engine this machine can start (it is unknown, not installed, or can only be measured).`,
        fix: `Use one of: ${choices.join(", ") || "none installed (run: npm run engines:install)"}; leave engine out for the in-process engine.`,
      });
    },
  });
}
