import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { engineContext } from "./engine-catalog.js";
import { planInstall, readManifest } from "./engine-install.js";
import { AppError } from "./errors.js";
import { profileIdFor } from "./model-profiles.js";

const MANIFEST = fileURLToPath(new URL("../engines/manifest.json", import.meta.url));
const NOTICE_CACHE = new Map();

/** One plain sentence when the installer has no prebuilt llama.cpp for this machine (ADR-176), else null. */
export async function prebuiltNotice({ platform = process.platform, arch = process.arch, manifestFile = MANIFEST } = {}) {
  const file = manifestFile instanceof URL ? fileURLToPath(manifestFile) : manifestFile;
  const info = await fs.stat(file).catch(() => null);
  const stamp = info ? `${info.mtimeMs}:${info.size}` : null;
  const key = `${path.resolve(file)}|${platform}|${arch}`;
  const cached = NOTICE_CACHE.get(key);
  if (cached?.stamp === stamp) return cached.notice;
  let notice = null;
  try {
    planInstall(await readManifest(manifestFile), { platform, arch });
  } catch (error) {
    if (error?.code === "engine_platform") {
      notice = `There is no prebuilt llama.cpp for ${platform}-${arch}, so ModelDuck runs models in-process only. To use llama-server, build it yourself and register it with: npm run engines:add.`;
    }
  }
  NOTICE_CACHE.set(key, { stamp, notice });
  return notice;
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
  const sharedContext = () => {
    const ctx = context();
    if (typeof ctx?.installedSnapshot !== "function") return ctx;
    const snapshot = ctx.installedSnapshot();
    return Object.freeze({ ...ctx, installedSnapshot: () => snapshot });
  };
  const listed = (ctx = context()) => catalog.descriptors().flatMap((descriptor) => descriptor.adapters(ctx));
  const probes = new Map();
  const profileCache = new Map();
  const profileReads = new Map();
  const PROFILE_CACHE_LIMIT = 32;

  /** Read one profile sidecar once per exact stamp, sharing concurrent lists. */
  async function readProfile(file) {
    const info = await fs.stat(file).catch(() => null);
    if (!info) {
      profileCache.delete(file);
      return null;
    }
    const stamp = `${info.mtimeMs}:${info.size}`;
    const cached = profileCache.get(file);
    if (cached?.stamp === stamp) return cached.value;
    const held = profileReads.get(file);
    if (held?.stamp === stamp) return (await held.promise).value;
    const promise = fs.readFile(file, "utf8")
      .then((text) => ({ ok: true, value: JSON.parse(text) }))
      .catch(() => ({ ok: false, value: null }));
    profileReads.set(file, { stamp, promise });
    try {
      const result = await promise;
      if (result.ok) {
        if (profileCache.size >= PROFILE_CACHE_LIMIT) profileCache.delete(profileCache.keys().next().value);
        profileCache.set(file, { stamp, value: result.value });
      }
      return result.value;
    } finally {
      if (profileReads.get(file)?.promise === promise) profileReads.delete(file);
    }
  }

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

  const servable = (id, ctx = context()) => catalog.isServable(id) && catalog.resolve(id, ctx) !== null;

  /** What `tune`/`npm run engines` measured for this model, by engine id; empty when nothing was measured. */
  async function measured(modelId) {
    const entry = modelId ? registry?.findById(modelId) : null;
    if (!entry || !profilesDir) return new Map();
    const saved = await readProfile(path.join(profilesDir, `${profileIdFor(entry.fileName)}.engines.json`));
    if (!saved) return new Map();
    return new Map((saved.results ?? []).map((result) => [result.id, { genTps: result.genTps ?? null, promptTps: result.promptTps ?? null, ok: result.ok === true, assessedAt: saved.assessedAt ?? null }]));
  }

  /** The per-task prompt and output token counts the model's profile recorded, or {} when it has none. */
  async function taskTokens(modelId) {
    const entry = modelId ? registry?.findById(modelId) : null;
    if (!entry || !profilesDir) return {};
    const saved = await readProfile(path.join(profilesDir, `${profileIdFor(entry.fileName)}.json`));
    if (!saved) return {};
    return Object.fromEntries(Object.entries(saved.tasks ?? {}).map(([task, value]) => [task, { promptTokens: value?.stats?.promptTokens, outputTokens: value?.stats?.outputTokens }])); // aikit:allow-secret -- numeric profile token counts, not credentials
  }

  return Object.freeze({
    canServe: servable,
    /** Every engine the catalog offers; `servable` ones may be chosen on load. `fastest` is the measured best for `modelId`, if any. */
    async list(modelId = null) {
      const speeds = await measured(modelId);
      const ctx = sharedContext();
      const engines = await Promise.all(listed(ctx).map(async (adapter) => {
        const { id, label } = adapter;
        const canServe = servable(id, ctx);
        const live = canServe ? await probe(adapter) : { available: false, reason: null };
        return { id, label, servable: canServe && live.available, reason: live.reason, version: catalog.version(id, ctx), measured: speeds.get(id) ?? null };
      }));
      const ranked = engines.filter((engine) => engine.servable && engine.measured?.ok && Number.isFinite(engine.measured.genTps)).sort((a, b) => b.measured.genTps - a.measured.genTps);
      return { engines, fastest: ranked[0]?.id ?? null, byTask: fastestPerTask(engines, await taskTokens(modelId)), notice: await notice() };
    },
    /** Throws a refusal naming the engines that can be chosen when `id` cannot be served here. */
    assertServable(id) {
      const ctx = sharedContext();
      if (servable(id, ctx)) return;
      const choices = listed(ctx).map((engine) => engine.id).filter((engineId) => servable(engineId, ctx));
      throw new AppError("That engine cannot serve this model", {
        status: 400,
        code: "engine_unknown",
        why: `${id} is not an engine this machine can start (it is unknown, not installed, or can only be measured).`,
        fix: `Use one of: ${choices.join(", ") || "none installed (run: npm run engines:install)"}; leave engine out for the in-process engine.`,
      });
    },
  });
}
