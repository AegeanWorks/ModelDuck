import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverInstalled, findBinary } from "./engine-install.js";
import { LlamaBenchAdapter, LlamaServerAdapter, NodeBackendAdapter, OllamaAdapter, OpenAICompatAdapter } from "./inference-engine-adapters.js";
import { LlamaServerBackend, OllamaBackend, OpenAICompatBackend, ServerEngine, parseOpenAiSpec } from "./external-engines.js";

/**
 * Which inference engines can run a model here, and how fast each one is
 * (ADR-155). The registry looks an engine up by id; `assessEngines` detects
 * and times every one on the same file and workload and ranks them by
 * generation speed. An engine that is missing or fails is reported with its
 * reason, never skipped silently and never fatal to the others.
 */

export const NODE_BACKENDS = Object.freeze(["cpu", "vulkan", "cuda", "metal"]);

/** Where installed engines live: the ones shipped beside ModelDuck, then the user's own folder. */
export function engineRoots(home = os.homedir()) {
  return [fileURLToPath(new URL("../engines", import.meta.url)), path.join(home, ".modelduck", "engines")];
}

/**
 * The engines this build knows about, in the order they are assessed: the
 * in-process backends, every installed llama.cpp variant (each its own engine,
 * so each gets its own speed), a llama.cpp binary passed by hand, Ollama, and
 * every OpenAI-compatible server attached by address.
 */
export function defaultEngines({ llamaBench = null, llamaServer = null, ollamaModel = null, ollamaUrl, openai = [], openaiKey = null, roots = engineRoots(), createEngine, platform = process.platform } = {}) {
  const exe = (name) => (platform === "win32" ? `${name}.exe` : name);
  const installed = discoverInstalled(roots).filter((install) => install.engine === "llama.cpp");
  const servers = installed
    .map((install) => ({ install, binary: findBinary(install.dir, [exe("llama-server")]) }))
    .filter((found) => found.binary)
    .map(({ install, binary }) => new LlamaServerAdapter({ binary, variant: install.variant, release: install.release, platform }));
  // A build passed by hand keeps its own id, so it is never mistaken for an installed variant.
  if (llamaServer) servers.push(new LlamaServerAdapter({ binary: llamaServer, variant: null, platform }));
  if (!servers.length) servers.push(new LlamaServerAdapter({ binary: null, platform }));
  const bench = llamaBench ?? installed.map((install) => findBinary(install.dir, [exe("llama-bench")])).find(Boolean) ?? null;
  return [
    ...NODE_BACKENDS.map((backend) => new NodeBackendAdapter({ backend, ...(createEngine && { createEngine }) })),
    new LlamaBenchAdapter({ binary: bench }),
    ...servers,
    new OllamaAdapter({ model: ollamaModel, ...(ollamaUrl && { baseUrl: ollamaUrl }) }),
    ...openai.map((text) => new OpenAICompatAdapter({ spec: parseOpenAiSpec(text), apiKey: openaiKey })),
  ];
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
 * The external engines the tuner can generate with, from an assessment: only
 * engines that measured and can produce text (llama-bench only times, so it is
 * not among them). Returns the engines for `RoutedEngine` and, for the device
 * stage, one candidate patch per backend each can run on.
 */
export function externalSetFrom({ results }, { registry, ollamaModel = null, ollamaUrl, openai = [], openaiKey = null } = {}) {
  const engines = {};
  const candidates = [];
  const attached = new Map(openai.map((text) => parseOpenAiSpec(text)).map((spec) => [spec.name, spec]));
  for (const result of results) {
    if (!result.ok) continue;
    if (result.id.startsWith("llama.cpp:llama-server") && result.location) {
      // One engine per installed variant, keyed by its id, so each is tuned and judged on its own.
      const key = result.id.replace(/^llama\.cpp:/, "");
      engines[key] = new ServerEngine({ id: key, registry, backend: new LlamaServerBackend({ binary: result.location }) });
      for (const backend of result.backends ?? ["cpu"]) candidates.push({ engine: key, gpuBackend: backend, gpuLayers: backend === "cpu" ? 0 : "max" });
    } else if (result.id.startsWith("openai:") && attached.has(result.id.slice(7))) {
      const spec = attached.get(result.id.slice(7));
      engines[result.id] = new ServerEngine({ id: result.id, registry, backend: new OpenAICompatBackend({ baseUrl: spec.baseUrl, model: spec.model, apiKey: openaiKey }) });
      // Its context, threads and GPU were fixed when it was launched; the candidate only names it.
      candidates.push({ engine: result.id, gpuBackend: "cpu", gpuLayers: 0 });
    } else if (result.id === "ollama") {
      engines.ollama = new ServerEngine({ id: "ollama", registry, backend: new OllamaBackend({ model: ollamaModel, ...(ollamaUrl && { baseUrl: ollamaUrl }) }) });
      candidates.push({ engine: "ollama", gpuBackend: "cpu", gpuLayers: 0 }, { engine: "ollama", gpuBackend: "auto", gpuLayers: "max" });
    }
  }
  return { engines, candidates };
}

/** A plain-text table of an assessment, fastest generation first. */
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
  return lines.join("\n");
}
