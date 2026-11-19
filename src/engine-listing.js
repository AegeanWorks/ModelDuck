import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { engineContext } from "./engine-catalog.js";
import { planInstall, readManifest } from "./engine-install.js";
import { AppError } from "./errors.js";
import { profileIdFor } from "./model-profiles.js";

const MANIFEST = fileURLToPath(new URL("../engines/manifest.json", import.meta.url));

/** One plain sentence when the installer has no prebuilt llama.cpp for this machine (ADR-176), else null. */
export async function prebuiltNotice({ platform = process.platform, arch = process.arch, manifestFile = MANIFEST } = {}) {
  try {
    planInstall(await readManifest(manifestFile), { platform, arch });
    return null;
  } catch (error) {
    if (error?.code !== "engine_platform") return null;
    return `There is no prebuilt llama.cpp for ${platform}-${arch}, so ModelDuck runs models in-process only. To use llama-server, build it yourself and register it with: npm run engines:add.`;
  }
}

/**
 * Which engine answers fastest for each task (F5, ADR-181): expected seconds per answer from the engine's measured
 * prompt and generation speed and the task's recorded prompt and output token counts. Generation speed alone favours
 * an engine that reads prompts slowly on long-context tasks. Only servable, measured engines are ranked, and a task
 * with no recorded tokens is left out. The engine speeds come from one fixed 256-token workload, so this is an
 * estimate of the ranking, not of the seconds.
 */
export function fastestPerTask(engines, tasks) {
  const ranked = {};
  const candidates = engines.filter((engine) => engine.servable && engine.measured?.ok && engine.measured.genTps > 0 && engine.measured.promptTps > 0);
  for (const [task, stats] of Object.entries(tasks ?? {})) {
    const prompt = Number(stats?.promptTokens);
    const output = Number(stats?.outputTokens);
    if (!(prompt > 0 || output > 0) || !candidates.length) continue;
    const seconds = Object.fromEntries(candidates.map((engine) => [engine.id, (prompt > 0 ? prompt : 0) / engine.measured.promptTps + (output > 0 ? output : 0) / engine.measured.genTps]));
    const [fastest] = Object.entries(seconds).sort((a, b) => a[1] - b[1])[0];
    ranked[task] = { fastest, seconds };
  }
  return ranked;
}

/**
 * The engines this machine can serve a model with, asked of the catalog (ADR-160), for the API and the UI (ADR-170).
 * `canServe(id)` is the check the load route makes before it hands an engine id to the router, so an unknown or
 * measure-only engine is refused with a Why and a Fix instead of silently falling back to the in-process one.
 * The list also asks each servable engine's adapter whether it answers here (`detect`: a server that is down, a GPU build
 * with no such GPU), so the chooser offers only engines that would start (ADR-178); a probe is kept for `probeTtlMs`
 * and shared by concurrent lists, because a llama-server probe starts the binary twice.
 */
export function createEngineListing({ catalog, registry, profilesDir = null, context = () => engineContext({ registry }), notice = prebuiltNotice, probeTtlMs = 60_000, clock = Date.now }) {
  const listed = () => catalog.descriptors().flatMap((descriptor) => descriptor.adapters(context()));
  const probes = new Map();

  /** Whether the engine answers on this machine; an adapter that cannot say is taken at its word. */
  function probe(adapter) {
    const held = probes.get(adapter.id);
    if (held && clock() - held.at < probeTtlMs) return held.result;
    const result = typeof adapter.detect !== "function"
      ? Promise.resolve({ available: true, reason: null })
      : adapter.detect().then((found) => ({ available: found?.available !== false, reason: found?.available === false ? found.reason ?? null : null }), (error) => ({ available: false, reason: error?.message ?? String(error) }));
    probes.set(adapter.id, { at: clock(), result });
    return result;
  }

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

  /** The per-task prompt and output token counts the model's profile recorded, or {} when it has none. */
  async function taskTokens(modelId) {
    const entry = modelId ? registry?.findById(modelId) : null;
    if (!entry || !profilesDir) return {};
    try {
      const saved = JSON.parse(await fs.readFile(path.join(profilesDir, `${profileIdFor(entry.fileName)}.json`), "utf8"));
      return Object.fromEntries(Object.entries(saved.tasks ?? {}).map(([task, value]) => [task, { promptTokens: value?.stats?.promptTokens, outputTokens: value?.stats?.outputTokens }]));
    } catch {
      return {};
    }
  }

  return Object.freeze({
    canServe: servable,
    /** Every engine the catalog offers; `servable` ones may be chosen on load. `fastest` is the measured best for `modelId`, if any. */
    async list(modelId = null) {
      const speeds = await measured(modelId);
      const engines = await Promise.all(listed().map(async (adapter) => {
        const { id, label } = adapter;
        const live = servable(id) ? await probe(adapter) : { available: false, reason: null };
        return { id, label, servable: servable(id) && live.available, reason: live.reason, version: catalog.version(id, context()), measured: speeds.get(id) ?? null };
      }));
      const ranked = engines.filter((engine) => engine.servable && engine.measured?.ok && Number.isFinite(engine.measured.genTps)).sort((a, b) => b.measured.genTps - a.measured.genTps);
      return { engines, fastest: ranked[0]?.id ?? null, byTask: fastestPerTask(engines, await taskTokens(modelId)), notice: await notice() };
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
