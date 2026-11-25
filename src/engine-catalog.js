import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installedEngineSnapshot } from "./engine-install.js";
import { AppError } from "./errors.js";
import { LlamaServerBackend, OllamaBackend, OpenAICompatBackend, parseOpenAiSpec } from "./external-engines.js";
import { ServerEngine } from "./server-engine.js";
import { LlamaBenchAdapter, LlamaServerAdapter, NodeBackendAdapter, OllamaAdapter, OpenAICompatAdapter } from "./inference-engine-adapters.js";

/**
 * Every inference engine ModelDuck knows is one descriptor in one catalog
 * (ADR-160). Nothing else in the code names an engine: assessment, the tuner's
 * device candidates, the engines a profile may name, and the engine the app
 * serves through are all asked of the catalog. Adding an engine is adding a
 * descriptor, and a descriptor can come from a file (`--engine-plugin`).
 *
 * A descriptor is an object with:
 *   kind        string; owns every id equal to it or starting with `kind:`
 *   servable    boolean, or a function of the id; true when the app can start the
 *               engine itself from a saved profile (so the tuner may adopt it),
 *               false when it is only measured (attached servers, benchmarks)
 *   adapters(ctx)         -> adapters {id, label, detect(), measure({entry, runs})} for assessment
 *   resolve(id, ctx)      -> a ServerEngine for tuning and serving, or null (optional)
 *   candidates(result, ctx) -> device-stage patches {engine, gpuBackend, gpuLayers} for a measured result (optional)
 *   version(id, ctx)      -> the build the app would run, as a short string or null (optional). It is the string a
 *                            profile records when it adopts the engine and compares when it is applied, so it must
 *                            be the same at tune time and at serve time and cheap to ask (no process is started).
 * An engine id is `kind` or `kind:detail` and is the same id in assessments,
 * profiles and logs. `ctx` is { registry, roots, platform, options, cachePrompt }.
 */

export const NODE_BACKENDS = Object.freeze(["cpu", "vulkan", "cuda", "metal"]);

/** Where installed engines live: the ones shipped beside ModelDuck, then the user's own folder. */
export function engineRoots(home = os.homedir()) {
  return [fileURLToPath(new URL("../engines", import.meta.url)), path.join(home, ".modelduck", "engines")];
}

const ownsKind = (kind) => (id) => id === kind || String(id).startsWith(`${kind}:`);

/** The context every descriptor receives; built from plain options so tests and the app share it. */
export function engineContext({ registry = null, roots = engineRoots(), platform = process.platform, cachePrompt = false, createEngine, ...options } = {}) {
  return Object.freeze({
    registry, roots, platform, cachePrompt, createEngine,
    installedSnapshot: () => installedEngineSnapshot(roots, { platform }),
    options: Object.freeze({ llamaBench: null, llamaServer: null, ollamaModel: null, ollamaUrl: undefined, openai: [], openaiKey: null, ...options }),
  });
}

const installed = (ctx) => (typeof ctx.installedSnapshot === "function"
  ? ctx.installedSnapshot()
  : installedEngineSnapshot(ctx.roots, { platform: ctx.platform })).filter((install) => install.engine === "llama.cpp");
// The exact-stamped snapshot already resolved registered and discovered binaries.
const serverBinary = (install) => install.serverBinary ?? null;

const nodeLlamaCpp = {
  kind: "node-llama-cpp",
  servable: false,
  owns: ownsKind("node-llama-cpp"),
  adapters: (ctx) => NODE_BACKENDS.map((backend) => new NodeBackendAdapter({ backend, ...(ctx.createEngine && { createEngine: ctx.createEngine }) })),
};

const llamaBench = {
  kind: "llama-bench",
  servable: false,
  owns: ownsKind("llama-bench"),
  adapters(ctx) {
    const binary = ctx.options.llamaBench ?? installed(ctx).map((install) => install.benchBinary).find(Boolean) ?? null;
    return [new LlamaBenchAdapter({ binary })];
  },
};

const llamaServer = {
  kind: "llama-server",
  // An installed variant can be found again by a saved profile; a binary passed on one command line cannot.
  servable: (id) => id !== "llama-server",
  owns: ownsKind("llama-server"),
  adapters(ctx) {
    const found = installed(ctx)
      .map((install) => ({ install, binary: serverBinary(install) }))
      .filter((entry) => entry.binary)
      .map(({ install, binary }) => new LlamaServerAdapter({ binary, variant: install.variant, release: install.release, backend: install.backend ?? null, label: install.label ?? null, platform: ctx.platform }));
    // A build passed by hand keeps its own id, so it is never mistaken for an installed variant.
    if (ctx.options.llamaServer) found.push(new LlamaServerAdapter({ binary: ctx.options.llamaServer, variant: null, platform: ctx.platform }));
    return found.length ? found : [new LlamaServerAdapter({ binary: null, platform: ctx.platform })];
  },
  resolve(id, ctx) {
    let binary = null;
    if (id === "llama-server") binary = ctx.options.llamaServer;
    else {
      const install = installed(ctx).find((entry) => entry.variant === id.slice("llama-server:".length));
      binary = install ? serverBinary(install) : null;
    }
    return binary ? new ServerEngine({ id, registry: ctx.registry, backend: new LlamaServerBackend({ binary, cachePrompt: ctx.cachePrompt }) }) : null;
  },
  candidates: (result) => (result.backends ?? ["cpu"]).map((backend) => ({ engine: result.id, gpuBackend: backend, gpuLayers: backend === "cpu" ? 0 : "max" })),
  // The release the installer pinned; a binary passed by hand has none to name.
  version: (id, ctx) => installed(ctx).find((entry) => id === `llama-server:${entry.variant}`)?.release ?? null,
};

const ollama = {
  kind: "ollama",
  servable: true,
  owns: ownsKind("ollama"),
  adapters: (ctx) => [new OllamaAdapter({ model: ctx.options.ollamaModel, ...(ctx.options.ollamaUrl && { baseUrl: ctx.options.ollamaUrl }) })],
  resolve: (id, ctx) => new ServerEngine({ id, registry: ctx.registry, backend: new OllamaBackend({ model: ctx.options.ollamaModel, ...(ctx.options.ollamaUrl && { baseUrl: ctx.options.ollamaUrl }) }) }),
  candidates: (result) => [{ engine: result.id, gpuBackend: "cpu", gpuLayers: 0 }, { engine: result.id, gpuBackend: "auto", gpuLayers: "max" }],
};

// An attached server is someone else's process with its own settings: the tuner can use it, a saved profile cannot start it.
const openaiCompat = {
  kind: "openai",
  servable: false,
  owns: ownsKind("openai"),
  adapters: (ctx) => ctx.options.openai.map((text) => new OpenAICompatAdapter({ spec: parseOpenAiSpec(text), apiKey: ctx.options.openaiKey })),
  resolve(id, ctx) {
    const spec = ctx.options.openai.map((text) => parseOpenAiSpec(text)).find((entry) => `openai:${entry.name}` === id);
    return spec ? new ServerEngine({ id, registry: ctx.registry, backend: new OpenAICompatBackend({ baseUrl: spec.baseUrl, model: spec.model, apiKey: ctx.options.openaiKey }) }) : null;
  },
  // Its context, threads and GPU were fixed when it was launched; the candidate only names it.
  candidates: (result) => [{ engine: result.id, gpuBackend: "cpu", gpuLayers: 0 }],
};

/** The engines this build ships, in the order they are assessed. */
export const BUILTIN_DESCRIPTORS = Object.freeze([nodeLlamaCpp, llamaBench, llamaServer, ollama, openaiCompat]);

/** A descriptor that does not fit the contract is refused where it is added, not where it is used. */
export function assertDescriptor(descriptor, where = "the engine descriptor") {
  const problems = [];
  if (!descriptor || typeof descriptor !== "object") problems.push("it is not an object");
  else {
    if (typeof descriptor.kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(descriptor.kind)) problems.push("kind must be a lowercase name like \"my-engine\"");
    if (typeof descriptor.owns !== "function") problems.push("owns(id) must be a function");
    if (typeof descriptor.adapters !== "function") problems.push("adapters(ctx) must be a function");
    if (typeof descriptor.servable !== "boolean" && typeof descriptor.servable !== "function") problems.push("servable must be true, false or a function");
    for (const optional of ["resolve", "candidates", "version"]) {
      if (descriptor[optional] !== undefined && typeof descriptor[optional] !== "function") problems.push(`${optional} must be a function when given`);
    }
    if (descriptor.servable && typeof descriptor.resolve !== "function") problems.push("a servable engine needs resolve(id, ctx), or a saved profile could not start it");
  }
  if (problems.length) {
    throw new AppError("Bad engine descriptor", { code: "engine_descriptor_invalid", why: `${where}: ${problems.join("; ")}.`, fix: "See the descriptor contract at the top of src/engine-catalog.js." });
  }
  return descriptor;
}

/** Import a descriptor from a file (`--engine-plugin <file>`); the module exports it as `default` or `descriptor`. */
export async function loadEnginePlugin(file) {
  const absolute = path.resolve(file);
  let loaded;
  try {
    loaded = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new AppError("The engine plugin could not be loaded", { code: "engine_plugin_failed", why: `${absolute}: ${error.message}`, fix: "Check the path, and that the file is an ES module exporting a descriptor." });
  }
  return assertDescriptor(loaded.default ?? loaded.descriptor, absolute);
}

/** The catalog: lookup by id, never by guessing from a string. */
export function createEngineCatalog({ descriptors = BUILTIN_DESCRIPTORS } = {}) {
  descriptors.forEach((descriptor) => assertDescriptor(descriptor));
  const kinds = descriptors.map((descriptor) => descriptor.kind);
  const clash = kinds.find((kind, index) => kinds.indexOf(kind) !== index);
  if (clash) throw new AppError("Two engines share a kind", { code: "engine_descriptor_invalid", why: `More than one descriptor is called "${clash}".`, fix: "Give each engine its own kind." });
  const forId = (id) => descriptors.find((descriptor) => descriptor.owns(id)) ?? null;
  return Object.freeze({
    descriptors: () => [...descriptors],
    descriptorFor: forId,
    /** Every adapter the assessment times, in catalog order. */
    adapters: (ctx) => descriptors.flatMap((descriptor) => descriptor.adapters(ctx)),
    /** A ready engine for tuning or serving, or null when this machine cannot provide it. */
    resolve: (id, ctx) => forId(id)?.resolve?.(id, ctx) ?? null,
    /** True when the app can start the engine from a saved profile. */
    isServable: (id) => {
      const servable = forId(id)?.servable;
      return typeof servable === "function" ? servable(id) === true : servable === true;
    },
    /** The build the app would run for an engine, or null when the engine does not say. */
    version: (id, ctx) => forId(id)?.version?.(id, ctx) ?? null,
    /** The device-stage candidates one measured result offers. */
    candidates: (result, ctx) => forId(result.id)?.candidates?.(result, ctx) ?? [],
  });
}
