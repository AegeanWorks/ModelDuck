import { BUILTIN_DESCRIPTORS, NODE_BACKENDS, createEngineCatalog, engineContext, engineRoots } from "./engine-catalog.js";
import { WORKLOAD } from "./inference-engine-adapters.js";

/**
 * Which inference engines can run a model here, and how fast each one is
 * (ADR-155). The registry looks an engine up by id; `assessEngines` detects
 * and times every one on the same file and workload and ranks them by
 * generation speed. An engine that is missing or fails is reported with its
 * reason, never skipped silently and never fatal to the others. What engines
 * exist is the catalog's business (ADR-160), not this module's.
 */

export { BUILTIN_DESCRIPTORS, NODE_BACKENDS, engineRoots };

/** The adapters the assessment times: one per engine the catalog (built-in, or with plugins) offers. */
export function defaultEngines({ catalog = createEngineCatalog(), ...options } = {}) {
  return catalog.adapters(engineContext(options));
}

/**
 * How the app resolves the engine a profile names. The llama.cpp prompt cache is off: against a real llama-server it saved
 * nothing (a long shared prefix, 329 ms with it and 351 without) and, with concurrent clients, made each wait about 5 s
 * where cache-off requests queued in 74 to 274 ms (ADR-163). The in-process engine drops its sessions between requests too.
 */
export function servingResolver(options) {
  return (id) => externalEngineFor(id, { ...options, cachePrompt: false });
}

/** A ready engine for tuning or serving by id, or null when this machine cannot provide it. */
export function externalEngineFor(id, { catalog = createEngineCatalog(), ...options } = {}) {
  return catalog.resolve(id, engineContext(options));
}

export function createEngineRegistry({ engines = defaultEngines() } = {}) {
  const byId = new Map(engines.map((engine) => [engine.id, engine]));
  return Object.freeze({
    ids: () => [...byId.keys()],
    list: () => [...byId.values()],
    get(id) {
      const engine = byId.get(id);
      if (!engine) throw new Error(`Unknown inference engine "${id}"; known: ${[...byId.keys()].join(", ")}.`);
      return engine;
    },
  });
}

/** One engine's outcome as a frozen record. */
function outcome(engine, fields) {
  return Object.freeze({
    id: engine.id,
    label: engine.label,
    available: false,
    ok: false,
    reason: null,
    error: null,
    version: null,
    promptTps: null,
    genTps: null,
    genRange: null,
    runs: 0,
    detail: null,
    backends: null,
    location: null,
    ...fields,
  });
}

/**
 * Detect and time every engine on `entry`, one after another so they never
 * compete for the same cores. `onProgress({ engine, stage })` reports each step.
 */
export async function assessEngines({ registry = createEngineRegistry(), entry, runs = 3, only = null, onProgress = () => {} }) {
  const results = [];
  for (const engine of registry.list()) {
    if (only && !only.includes(engine.id)) continue;
    onProgress({ engine: engine.id, stage: "detect" });
    const found = await engine.detect().catch((error) => ({ available: false, reason: error?.message || String(error), version: null }));
    if (!found.available) {
      results.push(outcome(engine, { reason: found.reason }));
      continue;
    }
    onProgress({ engine: engine.id, stage: "measure" });
    try {
      const measured = await engine.measure({ entry, runs });
      results.push(outcome(engine, { available: true, ok: Number.isFinite(measured.genTps), ...measured, version: found.version ?? measured.version ?? null, backends: found.backends ?? null, location: found.location ?? null }));
    } catch (error) {
      results.push(outcome(engine, { available: true, version: found.version, error: error?.message || String(error) }));
    }
  }
  return Object.freeze({ model: entry.fileName ?? entry.id, results: Object.freeze(results), fastest: fastestEngine(results) });
}

/** The measured engine with the highest generation speed, or null when none measured. */
export function fastestEngine(results) {
  const measured = results.filter((result) => result.ok);
  if (!measured.length) return null;
  return measured.reduce((best, result) => (result.genTps > best.genTps ? result : best)).id;
}

/**
 * The measured engines, other than the fastest, whose generation range reaches the fastest one's lower end (ADR-181):
 * their difference from it is inside what repeated runs of one engine already vary by, so the verdict between them is
 * not a measurement. A single reading counts as a range of one value.
 */
export function tiedWithFastest(results) {
  const measured = results.filter((result) => result.ok);
  const fastest = measured.length ? measured.reduce((best, result) => (result.genTps > best.genTps ? result : best)) : null;
  if (!fastest) return [];
  const floor = fastest.genRange ? fastest.genRange[0] : fastest.genTps;
  return measured.filter((result) => result !== fastest && (result.genRange ? result.genRange[1] : result.genTps) >= floor).map((result) => result.id);
}

/**
 * Seconds one answer of the standard workload (a 256-token prompt, 64 tokens out) takes on this engine, from its
 * measured prompt and generation speeds; Infinity when it was not measured (ADR-187). Generation speed alone can
 * mislead: kinetic 0.1.0 decoded 2.5x faster than llama-server on one GPU and read prompts 8x slower, and took 1.8x
 * as long on the code items, 3.5x on comprehension and 8x on recall.
 */
export function endToEndSeconds(result) {
  if (!result?.ok || !(result.genTps > 0) || !(result.promptTps > 0)) return Infinity;
  return WORKLOAD.promptTokens / result.promptTps + WORKLOAD.genTokens / result.genTps;
}

/** The in-process backends that start on this machine, for the tuner's device stage. */
export async function usableNodeBackends({ registry = createEngineRegistry() } = {}) {
  const usable = [];
  for (const engine of registry.list()) {
    if (!engine.id.startsWith("node-llama-cpp:")) continue;
    if ((await engine.detect()).available) usable.push(engine.id.split(":")[1]);
  }
  return usable;
}

/**
 * The backends the tuner's device stage may try: every in-process backend that
 * measured in this assessment, cpu first. External engines (native llama.cpp,
 * Ollama) are assessed for speed but ModelDuck's answers are served in-process,
 * so they are never device candidates.
 */
export function deviceBackendsFrom({ results }) {
  const measured = results.filter((result) => result.ok && result.id.startsWith("node-llama-cpp:")).map((result) => result.id.split(":")[1]);
  return ["cpu", ...NODE_BACKENDS.filter((backend) => backend !== "cpu" && measured.includes(backend))];
}

/**
 * The engines the tuner can generate with, from an assessment: each measured
 * engine the catalog can resolve (benchmarks that only time, such as
 * llama-bench, have no resolve and are not among them). Returns the engines
 * for `RoutedEngine`, the device-stage candidates each offers, and which of
 * them the app can start itself from a saved profile (so the tuner may adopt them).
 */
export function externalSetFrom({ results }, { catalog = createEngineCatalog(), ...options } = {}) {
  const ctx = engineContext(options);
  const engines = {};
  const candidates = [];
  for (const result of results) {
    if (!result.ok) continue;
    const engine = catalog.resolve(result.id, ctx);
    if (!engine) continue;
    engines[result.id] = engine;
    candidates.push(...catalog.candidates(result, ctx));
  }
  const servable = [...new Set(candidates.map((candidate) => candidate.engine))].filter((id) => catalog.isServable(id));
  return { engines, candidates, servable };
}

/** A plain-text table of an assessment, fastest generation first. */
// The one-line answer: the best speed engine for this model, and what it gains over the best in-process engine.
function bestEngineLine({ model, results, fastest }) {
  const best = results.find((result) => result.id === fastest && result.ok);
  if (!best) return null;
  const inProcess = results.filter((result) => result.ok && result.id !== best.id && result.id.startsWith("node-llama-cpp")).sort((a, b) => b.genTps - a.genTps)[0];
  const tied = tiedWithFastest(results);
  const note = tied.length ? `; within the measured spread of ${tied.join(", ")}, so not a clear win` : "";
  const head = `Best speed engine for ${model}: ${best.id}, ${best.genTps} tok/s`;
  if (inProcess) return `${head}, ${Math.round((best.genTps / inProcess.genTps - 1) * 100)}% faster than ${inProcess.id}${note}`;
  return results.filter((result) => result.ok).length > 1 ? `${head}${note}` : `${head} (no other engine measured)`;
}

export function formatAssessment({ model, results, fastest }) {
  const pad = (value, width) => String(value).padEnd(width);
  const lines = [`Token speed on ${model} (${results.filter((r) => r.ok).length} of ${results.length} engines measured):`];
  const ranked = [...results].sort((a, b) => (b.genTps ?? -1) - (a.genTps ?? -1));
  for (const result of ranked) {
    const speed = result.ok
      ? `${pad(`${result.genTps} tok/s gen${result.genRange && result.genRange[0] !== result.genRange[1] ? ` (${result.genRange[0]}-${result.genRange[1]})` : ""}`, 26)} ${pad(`${result.promptTps ?? "?"} tok/s prompt`, 20)} ${result.detail ?? ""}${result.version ? ` [${result.version}]` : ""}`
      : result.available
        ? `FAILED: ${result.error}${result.version ? ` [${result.version}]` : ""}`
        : `unavailable: ${result.reason}`;
    lines.push(`  ${result.id === fastest ? "*" : " "} ${pad(result.label, 32)} ${speed}`);
  }
  if (fastest) lines.push("  * fastest generation");
  const verdict = bestEngineLine({ model, results, fastest });
  if (verdict) lines.push(verdict);
  const sooner = results.filter((result) => result.ok).sort((left, right) => endToEndSeconds(left) - endToEndSeconds(right))[0];
  const decoder = results.find((result) => result.id === fastest && result.ok);
  if (decoder && sooner && sooner.id !== decoder.id && endToEndSeconds(sooner) < endToEndSeconds(decoder)) {
    lines.push(`Note: ${decoder.id} generates fastest, but ${sooner.id} answers the standard workload sooner (${endToEndSeconds(sooner).toFixed(2)} s against ${endToEndSeconds(decoder).toFixed(2)} s): prompt speed counts as much as generation speed, and ${decoder.id} reads prompts at ${decoder.promptTps} tok/s.`);
  }
  return lines.join("\n");
}

/** `--only` values: an exact engine id, or an engine family (`llama-server` is every `llama-server:*`). */
export function expandOnly(wanted, ids) {
  const matches = (entry, id) => id === entry || id.startsWith(`${entry}:`);
  return { ids: ids.filter((id) => wanted.some((entry) => matches(entry, id))), unknown: wanted.filter((entry) => !ids.some((id) => matches(entry, id))) };
}
