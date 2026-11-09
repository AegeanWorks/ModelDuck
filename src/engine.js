import os from "node:os";

import { AppError } from "./errors.js";
import { normalizeSettings } from "./config.js";
import { samplerOptions } from "./sampler-chain.js";
import { toGenerationError, toLoadError } from "./engine-errors.js";
import { formatBytes } from "./fs-atomic.js";
import { estimateLoad, estimateLoadV2, fitVerdict, recordLoadSample, splitKvCache } from "./memory-fit.js";
import { ENGINE_MACHINE } from "./state-machine.js";
import {
  buildChatHistory,
  buildGenerationManifest,
  detectLoop,
  buildSystemPrompt,
  canReuseSession,
  nextSessionHistoryLength,
  repeatPrompt,
} from "./generation-manifest.js";

const MAX_SESSIONS = 1;
const KV_CACHE_TYPES = {
  f16: "F16",
  q8_0: "Q8_0",
  q4_0: "Q4_0",
};

function publicModel(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    fileName: entry.fileName,
    size: entry.size,
    sizeLabel: entry.sizeLabel,
    quant: entry.quant,
    params: entry.params,
    architecture: entry.architecture,
    contextLength: entry.contextLength,
    chatTemplate: entry.chatTemplate,
    chatTemplateHash: entry.chatTemplateHash ?? null,
  };
}

function mapAttention(value) {
  if (value === "on") return true;
  if (value === "off") return false;
  return "auto";
}

/** A KV cache label is valid when every colon-separated part names a known type. */
export function validKvLabel(label) {
  const parts = String(label ?? "").split(":");
  return parts.length <= 2 && parts.every((part) => Object.hasOwn(KV_CACHE_TYPES, part)) ? parts.join(":") : "f16";
}

/** IDEA-1200: count tokens loudly; a tokenizer failure must never read as 0. */
export function countTokensWith(model, text) {
  if (!model || !text) return 0;
  try {
    return model.tokenize(text).length;
  } catch (error) {
    throw new AppError("Could not count tokens", {
      code: "token_count_failed",
      status: 500,
      why: `The tokenizer failed: ${error?.message || error}`,
      fix: "Reload the model, then try again. If it repeats, reinstall the model file.",
    });
  }
}

/** IDEA-1163: grammar cache key includes the model so a swap cannot reuse stale grammars. */
export function grammarSignatureFor(modelId, settings) {
  const schema = settings?.jsonSchema ?? "";
  const schemaText = typeof schema === "string" ? schema : (() => { try { return JSON.stringify(schema); } catch { return String(schema); } })();
  return `${modelId ?? "none"}|${settings?.structuredOutput ?? "none"}|${schemaText}`;
}

/** IDEA-1160: clamp a reply to the context that remains; 0 means the prompt alone fills the window. */
export function replyBudget(promptTokens, contextSize, maxTokens) {
  const remaining = Math.floor(Number(contextSize) || 0) - Math.floor(Number(promptTokens) || 0);
  if (remaining <= 0) return 0;
  return Math.min(Number(maxTokens) || 0, remaining);
}

/**
 * IDEA-1084: divide the remaining context across parallel sequences, so N
 * slots cannot overbook it. Returns 0 only when nothing remains; otherwise
 * at least 1 so a generation can always make progress (a 0-token cap would
 * fail in the runtime). Callers use the return value directly.
 */
export function slotClamp(maxTokens, remaining, sequences) {
  const slots = Math.max(1, Math.floor(Number(sequences) || 1));
  const budget = Math.floor(Number(remaining) || 0);
  if (budget <= 0) return 0;
  const perSlot = Math.floor(budget / slots);
  if (perSlot <= 0) return Math.min(Number(maxTokens) || 0, budget) > 0 ? 1 : 0;
  return Math.min(Number(maxTokens) || 0, perSlot);
}

/**
 * IDEA-1082: keep the tail of an overflowing prompt so a single huge input
 * proceeds instead of failing. Binary-searches the shortest tail within
 * budget; a leading lone surrogate from a split pair is stripped so the
 * tail is always valid UTF-16. Returns the original text when it fits.
 */
export function truncatePromptTail(text, countTokens, budget) {
  const source = String(text ?? "");
  if (countTokens(source) <= Math.max(0, budget)) return source;
  let lo = 0;
  let hi = source.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (countTokens(source.slice(mid)) <= budget) hi = mid;
    else lo = mid + 1;
  }
  // A slice can split a UTF-16 surrogate pair; drop the orphaned low half.
  return source.slice(lo).replace(/^[\uDC00-\uDFFF]/, "");
}

/** IDEA-1159: a GPU flip is allowed only when measured VRAM fits the weights. */
export function vramFitsModel({ freeBytes, modelBytes, reserveBytes = 0 } = {}) {
  const rawFree = freeBytes;
  const free = Number(rawFree);
  const weights = Number(modelBytes);
  const reserve = Number(reserveBytes) || 0;
  if (rawFree === null || rawFree === undefined || !Number.isFinite(free) || !(weights > 0)) return { fits: null, reason: "VRAM could not be measured; the load decides." };
  const fits = weights + reserve <= free;
  return {
    fits,
    reason: fits
      ? "Measured VRAM fits the weights."
      : `The weights need about ${weights + reserve} bytes but only ${free} are free on the GPU.`,
  };
}

/** IDEA-1161: retry once without the grammar when constrained output came back empty. */
export function needsEmptyRetry({ text, grammarUsed, aborted }) {
  return Boolean(grammarUsed) && !aborted && String(text ?? "").trim().length === 0;
}

const RESPONSE_CACHE_MAX = 32;
const RESPONSE_CACHE_TEXT_MAX = 8192;

/**
 * IDEA-1076: only exact-repeat deterministic answers are cacheable: greedy
 * decoding (temperature 0) with an explicit seed, keyed by the full manifest
 * digest. Anything creative or unseeded always regenerates.
 */
export function eligibleForCache(settings) {
  return Number(settings?.temperature) === 0 && Number(settings?.seed) >= 0;
}

const KNOWN_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** IDEA-1162: reject unsupported JSON schemas before a session is created. */
export function assertJsonSchemaSupported(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new AppError("The JSON schema is invalid", {
      code: "invalid_json_schema",
      status: 400,
      why: "Structured output is set to json_schema, but the schema is not a JSON object.",
      fix: "Fix the schema in Settings, or switch structured output to json_object.",
    });
  }
  if (schema.type !== undefined && !KNOWN_SCHEMA_TYPES.has(schema.type)) {
    throw new AppError("This JSON schema is not supported", {
      code: "unsupported_json_schema",
      status: 422,
      why: `Schema type "${schema.type}" cannot be compiled to a constrained grammar.`,
      fix: "Use a plain object/array/string/number/integer/boolean/null schema, or switch structured output to json_object.",
    });
  }
}

function mapMmap(value) {
  if (value === "on") return true;
  if (value === "off") return false;
  return "auto";
}

/**
 * Use only the installed prebuilt binaries. node-llama-cpp's default ("auto")
 * may download llama.cpp from GitHub and compile it when no binary fits, which
 * a local app must never do without the user starting it.
 */
const RUNTIME_OPTIONS = Object.freeze({ build: "never" });

function defaultLoadRuntime() {
  return import("node-llama-cpp");
}

function runtimeMissing(error) {
  return new AppError("The inference runtime is not installed for this computer", {
    code: "runtime_binary_missing",
    status: 500,
    why: `No usable prebuilt llama.cpp binary was found: ${error?.message || error}`,
    fix: "Reinstall ModelDuck's dependencies with npm install, or build one yourself with npx node-llama-cpp source download.",
  });
}

export class LlamaEngine {
  #registry;
  #logger;
  #loadRuntime;
  #availableMemory;
  #llama = null;
  #model = null;
  #context = null;
  #chatSessionClass = null;
  #completionClass = null;
  #sessions = new Map();
  #active = new Map();
  // Generations in flight; more than one only when the model was loaded with several sequences.
  #running = 0;
  #maxConcurrent = 1;
  #pending = new Set();
  #checkpoints = true;
  #checkpointInterval = 8192;
  #checkpointMax = 32;
  #grammarCache = null;
  #responseCache = new Map(); // IDEA-1076: memory-only, cleared on unload.
  #gpuBackend = null;
  #state = {
    status: "idle",
    model: null,
    contextSize: null,
    trainContextSize: null,
    threads: null,
    maxThreads: null,
    batchSize: null,
    sequences: null,
    flashAttention: null,
    useMmap: null,
    gpuLayers: null,
    checkpoints: null,
    checkpointInterval: null,
    checkpointMax: null,
    kvCache: null,
    runtimeVersion: null,
    loadedAt: null,
    error: null,
    lastStats: null,
    fit: null,
    contextFallback: null,
  };
  #loading = false;
  #unloading = false;
  #loadEpoch = 0;

  /** IDEA-1095: the id deleteById refuses while loaded; was undefined before. */
  get loadedId() {
    return this.#state.model?.id ?? null;
  }

  /** The engine phase machine (src/state-machine.js) guards every status write. */
  #assertStatus(next) {
    ENGINE_MACHINE.assert(this.#state.status, next);
  }

  #setStatus(next) {
    this.#assertStatus(next);
    this.#state = { ...this.#state, status: next };
  }

  /** IDEA-1158: one load/unload phase machine with terminal refusals. */
  get phase() {
    if (this.#unloading) return "unloading";
    if (this.#loading) return "loading";
    return this.#state.status;
  }

  get busy() {
    return this.#running > 0 || this.#loading || this.#unloading;
  }

  /** IDEA-1094: cancel a load stuck between native awaits; the load throws canceled. */
  cancelLoad() {
    if (!this.#loading) return false;
    this.#loadEpoch += 1;
    return true;
  }

  #assertLoadAlive(epoch) {
    if (epoch !== this.#loadEpoch) {
      throw new AppError("The model load was canceled", {
        code: "model_loading_canceled",
        status: 409,
        why: "The load was canceled while it was still starting.",
        fix: "Load the model again if you still want it.",
      });
    }
  }

  constructor({
    registry,
    logger = console,
    loadRuntime = defaultLoadRuntime,
    availableMemory = () => os.freemem(),
  }) {
    this.#registry = registry;
    this.#logger = logger;
    this.#loadRuntime = loadRuntime;
    this.#availableMemory = availableMemory;
  }

  /**
   * Runtime V2 context requirements for a load (M7). The simulator accounts
   * for batch size, sequences, flash attention, K/V types, mmap and offloaded
   * layers, where the formula only scales the KV cache with context. Cached
   * per file; null on any failure (or for "auto" offload, which resolves its
   * own layer count), so the caller falls back to the formula.
   */
  #insightsCache = new Map();
  async #contextRequirementsV2(entry, { contextSize, gpuLayers, batchSize, sequences, flashAttention, kvCache }) {
    try {
      const layers = Number(gpuLayers);
      const gpuLayerCount = Number.isFinite(layers)
        ? layers
        : gpuLayers === "max"
          ? Number(entry.kvShape?.layers) || 0
          : null;
      // "auto" offload picks its own layer count from live VRAM; the formula covers it.
      if (gpuLayerCount === null || !(gpuLayerCount >= 0)) return null;
      const { readGgufFileInfo, GgufInsights, GgmlType } = await import("node-llama-cpp");
      const { key: kvKey, value: kvValue } = splitKvCache(kvCache);
      const keyType = GgmlType[KV_CACHE_TYPES[kvKey] ?? "F16"];
      const valueType = GgmlType[KV_CACHE_TYPES[kvValue] ?? "F16"];
      if (!Number.isFinite(keyType) || !Number.isFinite(valueType)) return null;
      const key = `${entry.path}|${entry.size}`;
      let insights = this.#insightsCache.get(key);
      if (!insights) {
        insights = await GgufInsights.from(await readGgufFileInfo(entry.path));
        this.#insightsCache.set(key, insights);
      }
      const flash = flashAttention === "on" ? true : flashAttention === "off" ? false : "auto";
      return await insights.estimateContextResourceRequirementsV2({
        contextSize,
        modelGpuLayers: gpuLayerCount,
        ...(Number(batchSize) > 0 && { batchSize: Number(batchSize) }),
        ...(Number(sequences) > 0 && { sequences: Number(sequences) }),
        flashAttention: flash,
        kvCacheKeyType: keyType,
        kvCacheValueType: valueType,
      });
    } catch {
      return null;
    }
  }

  /**
   * Memory verdict for a CPU load. The currently loaded model is unloaded
   * first, so its weights count as available. GPU offload moves weights out of
   * RAM, so the check is skipped when layers are offloaded.
   */
  async #planFit(entry, { contextSize, kvCache, gpuLayers, batchSize, sequences, flashAttention }) {
    const contextTokens = Math.max(512, Math.min(Number(contextSize) || 16384, entry.contextLength || Infinity));
    const kvLabel = validKvLabel(kvCache);
    const v2 = await this.#contextRequirementsV2(entry, { contextSize: contextTokens, gpuLayers, batchSize, sequences, flashAttention, kvCache: kvLabel });
    const estimate = v2
      ? estimateLoadV2({ requirements: v2, weights: entry.size, contextSize: contextTokens, kvCache: kvLabel })
      : estimateLoad({ modelBytes: entry.size, shape: entry.kvShape, contextSize: contextTokens, kvCache: kvLabel });
    const offloaded = gpuLayers === "auto" || gpuLayers === "max" || Number(gpuLayers) > 0;
    const reclaimable = this.#state.status === "ready" ? Number(this.#state.model?.size) || 0 : 0;
    const fit = offloaded
      ? { verdict: "unknown", ratio: null, availableBytes: null, largestSafeContext: null }
      : fitVerdict({ estimate, availableBytes: this.#availableMemory() + reclaimable, shape: entry.kvShape });
    return { ...fit, estimateBytes: estimate.total, contextSize: contextTokens, kvCache: kvLabel, estimator: estimate.estimator };
  }

  /**
   * Free memory for a load on `gpuBackend`: VRAM on a GPU, RAM on the CPU. The loaded
   * model's weights count as free, since a new load replaces it. Null when the GPU's
   * free memory cannot be read (no GPU runtime yet, or another backend).
   */
  async availableMemory({ gpuBackend = "cpu" } = {}) {
    const loaded = this.#state.status === "ready" ? Number(this.#state.model?.size) || 0 : 0;
    if (gpuBackend === "cpu") return this.#availableMemory() + loaded;
    if (!this.#llama?.gpu || this.#gpuBackend !== gpuBackend) return null;
    try {
      const vram = await this.#llama.getVramState();
      return vram.free + loaded;
    } catch {
      return null;
    }
  }

  /**
   * Total memory for a load on `gpuBackend` (M7): RAM on the CPU, VRAM on a
   * GPU. Unlike the momentary free figure, the total does not move with
   * whatever else runs, so the same PC tunes the same context twice.
   */
  async totalMemory({ gpuBackend = "cpu" } = {}) {
    if (gpuBackend === "cpu") {
      try {
        const os = await import("node:os");
        return os.totalmem();
      } catch {
        return null;
      }
    }
    if (!this.#llama?.gpu || this.#gpuBackend !== gpuBackend) return null;
    try {
      const vram = await this.#llama.getVramState();
      return Number(vram.total) || null;
    } catch {
      return null;
    }
  }

  /** The llama runtime for `backend`, started once and replaced when the backend changes. */
  async #startRuntime(module, backend) {
    if (this.#llama && this.#gpuBackend !== backend) {
      await this.#llama.dispose().catch(() => {});
      this.#llama = null;
    }
    if (this.#llama) return;
    try {
      this.#llama = await module.getLlama({
        ...RUNTIME_OPTIONS,
        gpu: backend === "cpu" ? false : backend,
      });
      this.#gpuBackend = backend;
    } catch (error) {
      if (backend === "cpu") throw runtimeMissing(error);
      if (backend !== "auto") {
        throw new AppError("The GPU backend could not start", {
          code: "gpu_backend_failed",
          status: 500,
          why: `${backend} could not be loaded: ${error?.message || error}`,
          fix: "Use the CPU backend, install the vendor runtime, or try Vulkan/CUDA from Settings.",
        });
      }
      this.#logger.warn?.(
        `[modelduck] ${backend} GPU unavailable; falling back to CPU: ${error?.message || error}`,
      );
      this.#llama = await module.getLlama({ ...RUNTIME_OPTIONS, gpu: false }).catch((cpuError) => {
        throw runtimeMissing(cpuError);
      });
      this.#gpuBackend = "cpu";
    }
  }

  /**
   * Start the runtime for `gpuBackend` without loading a model, so a tune finds a broken
   * GPU in a second instead of after a round of failed answers (ADR-044). A loaded
   * model is left alone; its runtime evidently works.
   */
  async startBackend(gpuBackend) {
    if (this.#state.status === "ready" || this.#loading) return;
    await this.#startRuntime(await this.#loadRuntime(), gpuBackend);
  }

  async status() {
    let memory = null;
    if (this.#llama) {
      try {
        memory = await this.#llama.getLlamaMemoryUsage();
      } catch {
        memory = null;
      }
    }
    return { ...this.#state, phase: this.phase, memory };
  }

  async load({
    modelId,
    contextSize,
    threads,
    maxThreads,
    batchSize,
    sequences,
    flashAttention,
    useMmap,
    gpuLayers,
    gpuBackend,
    checkpoints,
    checkpointInterval,
    checkpointMax,
    kvCache,
    // IDEA-1627: batch 1 is the repro path, explicitly opted in. The app
    // keeps the 32 floor; only a deterministic repro run passes true.
    deterministicRepro = false,
    force = false,
  }) {
    if (this.#running > 0) {
      throw new AppError("Stop the current reply first", {
        code: "generation_in_progress",
        status: 409,
        why: "A model cannot be swapped while it is generating a reply.",
        fix: "Click Stop, then load the model again.",
      });
    }
    if (this.#loading) {
      throw new AppError("A model is already loading", {
        code: "model_loading",
        status: 409,
        why: "Wait for the current load to finish before starting another.",
        fix: "Give the current model a moment to finish loading.",
      });
    }
    if (this.#unloading) {
      throw new AppError("The model is unloading", {
        code: "model_unloading",
        status: 409,
        why: "Wait for the unload to finish before loading another model.",
        fix: "Give the current model a moment, then load again.",
      });
    }
    const entry = this.#registry.findById(modelId);
    if (!entry) {
      throw new AppError("Model not found", {
        code: "model_not_found",
        status: 404,
        why: "That model is no longer in the library.",
        fix: "Refresh the model list and choose an installed model.",
      });
    }
    if (entry.blocked) {
      throw new AppError("This GGUF file was blocked", {
        code: "gguf_header_rejected",
        status: 422,
        why: entry.blockedReason,
        fix: "Delete the file and download the model again from a source you trust.",
      });
    }
    // IDEA-1093/1228: the scan already resolved the template compat; surface
    // its warnings at load so a fallback template or rename risk is visible.
    // Selection still prefers the model default (see summarize/templateCompat).
    for (const warning of entry.compat?.warnings ?? []) {
      this.#logger.warn?.(`[modelduck] Template: ${warning} (${entry.fileName})`);
    }
    const fit = await this.#planFit(entry, { contextSize, kvCache, gpuLayers, batchSize, sequences, flashAttention });
    if (fit.verdict === "will_not_fit" && !force) {
      const safer = fit.largestSafeContext >= 512
        ? `Lower Context size to ${fit.largestSafeContext} tokens, use the q8_0 KV cache,`
        : "Choose a smaller model or quantization,";
      throw new AppError("This model will not fit in memory", {
        code: "model_will_not_fit",
        status: 507,
        why: `It needs about ${formatBytes(fit.estimateBytes)} at ${fit.contextSize} tokens, but only ${formatBytes(fit.availableBytes)} is free; loading it would push the computer into swap.`,
        fix: `${safer} or close other programs and try again.`,
      });
    }

    this.#loading = true;
    const epoch = ++this.#loadEpoch;

    try {
      await this.unload();
      this.#assertLoadAlive(epoch);
      this.#setStatus("loading");
      this.#state = { ...this.#state, model: publicModel(entry), error: null };
      const module = await this.#loadRuntime();
      this.#assertLoadAlive(epoch);
      this.#chatSessionClass = module.LlamaChatSession;
      this.#completionClass = module.LlamaCompletion;
      const runtimeVersion = await module.getModuleVersion().catch(() => null);
      const requestedBackend = ["auto", "cuda", "vulkan", "metal"].includes(
        process.env.MODELDUCK_GPU,
      )
        ? process.env.MODELDUCK_GPU
        : gpuBackend;
      const backend = ["cpu", "auto", "cuda", "vulkan", "metal"].includes(requestedBackend)
        ? requestedBackend
        : "cpu";
      await this.#startRuntime(module, backend);

      const actualThreads = Math.max(1, Math.min(64, Number(threads) || 4));
      const actualMaxThreads = Math.max(1, Math.min(64, Number(maxThreads) || actualThreads));
      // IDEA-1627: batch 1 is valid only on the explicit repro path; the app
      // keeps the 32 floor so a mistyped batch never silently slows to a crawl.
      const batchFloor = deterministicRepro === true ? 1 : 32;
      const actualBatchSize = Math.max(batchFloor, Math.min(8192, Number(batchSize) || 512));
      const actualSequences = Math.max(1, Math.min(8, Number(sequences) || 1));
      const kvLabel = validKvLabel(kvCache);
      const { key: kvKey, value: kvValue } = splitKvCache(kvLabel);
      const kvKeyType = KV_CACHE_TYPES[kvKey];
      const kvValueType = KV_CACHE_TYPES[kvValue];
      const attention = mapAttention(flashAttention);
      const mmap = mapMmap(useMmap);
      const gpuLayerValue =
        gpuLayers === "auto" || gpuLayers === "max"
          ? gpuLayers
          : Math.max(0, Math.min(200, Number(gpuLayers) || 0));
      if (this.#llama.maxThreads !== actualMaxThreads) {
        this.#llama.maxThreads = actualMaxThreads;
      }

      this.#model = await this.#llama.loadModel({
        modelPath: entry.path,
        useMmap: mmap,
        gpuLayers: gpuLayerValue,
      });
      this.#assertLoadAlive(epoch);
      // IDEA-1159: a GPU flip is gated on measured VRAM, not on hope.
      if (backend !== "cpu" && (gpuLayerValue === "auto" || gpuLayerValue === "max" || Number(gpuLayerValue) > 0)) {
        const freeVram = await this.availableMemory({ gpuBackend: backend }).catch(() => null);
        const gate = vramFitsModel({ freeBytes: freeVram, modelBytes: entry.size });
        if (gate.fits === false && !force) {
          throw new AppError("The GPU cannot fit this model", {
            code: "gpu_vram_fit",
            status: 507,
            why: gate.reason,
            fix: "Use fewer GPU layers, the q8_0 KV cache, or the CPU backend — or retry with force.",
          });
        }
      }
      const trained = this.#model.trainContextSize || 16384;
      const wanted = Math.max(512, Math.min(Number(contextSize) || 16384, trained));
      const attempts = [...new Set([wanted, Math.min(wanted, 3072), 2048, 1024])];
      this.#checkpoints = checkpoints !== false;
      this.#checkpointInterval = Math.max(128, Math.min(32768, Number(checkpointInterval) || 8192));
      this.#checkpointMax = Math.max(1, Math.min(64, Number(checkpointMax) || 32));

      let lastError = null;
      for (const attempt of attempts) {
        this.#assertLoadAlive(epoch);
        try {
          const contextOptions = {
            contextSize: attempt,
            threads: actualThreads,
            batchSize: actualBatchSize,
            sequences: actualSequences,
          };
          if (kvKeyType !== "F16" || kvValueType !== "F16") {
            contextOptions.flashAttention = true;
            contextOptions.experimentalKvCacheKeyType = kvKeyType;
            contextOptions.experimentalKvCacheValueType = kvValueType;
          } else if (attention !== "auto") {
            contextOptions.flashAttention = attention;
          }
          this.#context = await this.#model.createContext(contextOptions);
          this.#maxConcurrent = actualSequences;
          break;
        } catch (error) {
          lastError = error;
          this.#logger.warn?.(
            `[modelduck] Context size ${attempt} with KV ${kvLabel} failed: ${error?.message || error}`,
          );
        }
      }
      if (!this.#context) throw lastError ?? new Error("No context could be created");

      this.#assertStatus("ready");
      this.#state = {
        status: "ready",
        model: publicModel(entry),
        contextSize: this.#context.contextSize,
        trainContextSize: trained,
        threads: actualThreads,
        maxThreads: actualMaxThreads,
        batchSize: actualBatchSize,
        sequences: actualSequences,
        flashAttention: kvKeyType !== "F16" || kvValueType !== "F16" ? "on" : flashAttention ?? "auto",
        useMmap: mmap,
        gpuLayers: this.#model.gpuLayers,
        gpuBackend: this.#llama.gpu || "cpu",
        checkpoints: this.#checkpoints,
        checkpointInterval: this.#checkpointInterval,
        checkpointMax: this.#checkpointMax,
        kvCache: kvLabel,
        runtimeVersion,
        loadedAt: new Date().toISOString(),
        error: null,
        lastStats: null,
        fit,
        contextFallback:
          this.#context.contextSize < wanted
            ? {
                requested: wanted,
                actual: this.#context.contextSize,
                reason: lastError?.message || "The requested context could not be allocated.",
              }
            : null,
      };
      // IDEA-1065: calibrate the memory reserve from the measured process size.
      try {
        recordLoadSample({ rssBytes: process.memoryUsage?.().rss, modelBytes: entry.size });
      } catch {
        // Calibration is best-effort; a load never fails because of it.
      }
      return { ...this.#state };
    } catch (error) {
      await this.#disposeModel();
      this.#setStatus("error");
      this.#state = {
        ...this.#state,
        error: error?.message || String(error),
      };
      throw toLoadError(error);
    } finally {
      this.#loading = false;
    }
  }

  async unload() {
    if (this.#unloading) return { ...this.#state };
    this.#unloading = true;
    this.#setStatus("unloading");
    try {
      await this.teardown();
    } catch (error) {
      // A teardown that throws must not leave the phase stuck on "unloading".
      this.#setStatus("error");
      this.#state = { ...this.#state, error: error?.message || String(error) };
      throw error;
    } finally {
      this.#unloading = false;
    }
    return { ...this.#state };
  }

  /**
   * IDEA-1095: stop-confirmed teardown with a receipt; dispose errors are
   * recorded instead of swallowed, and callers can prove the model is gone.
   */
  async teardown() {
    const modelId = this.#state.model?.id ?? null;
    for (const controller of this.#active.values()) controller.abort();
    await Promise.allSettled([...this.#pending]);
    this.#active.clear();
    this.#disposeSessions();
    const errors = [];
    try {
      if (this.#context) await this.#context.dispose();
    } catch (error) {
      errors.push(`context: ${error?.message || error}`);
    } finally {
      this.#context = null;
    }
    try {
      if (this.#model) await this.#model.dispose();
    } catch (error) {
      errors.push(`model: ${error?.message || error}`);
    } finally {
      this.#model = null;
    }
    this.#grammarCache = null; // IDEA-1163: a model swap must never reuse a stale grammar.
    // IDEA-1076: cached answers belong to the unloaded model; never reuse them.
    this.#responseCache.clear();
    this.#assertStatus("idle");
    this.#state = {
      status: "idle",
      model: null,
      contextSize: null,
      trainContextSize: null,
      threads: null,
      maxThreads: null,
      batchSize: null,
      sequences: null,
      flashAttention: null,
      useMmap: null,
      gpuLayers: null,
      gpuBackend: null,
      checkpoints: null,
      checkpointInterval: null,
      checkpointMax: null,
      kvCache: null,
      runtimeVersion: null,
      loadedAt: null,
      error: null,
      lastStats: null,
      // A fresh teardown must not leak the previous load's verdicts.
      fit: null,
      contextFallback: null,
    };
    return { modelId, disposedAt: new Date().toISOString(), errors };
  }

  abort(conversationId) {
    const controller = this.#active.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  dropSession(conversationId) {
    if (this.#active.has(conversationId)) return;
    const record = this.#sessions.get(conversationId);
    if (!record) return;
    record.session.dispose();
    this.#sessions.delete(conversationId);
  }

  async chat({
    conversationId,
    messages,
    systemPrompt,
    settings,
    signal,
    onToken = () => {},
  }) {
    if (this.#state.status !== "ready" || !this.#context || !this.#model) {
      throw new AppError("No model is loaded", {
        code: "model_not_loaded",
        status: 409,
        why: "ModelDuck needs a loaded model before it can answer.",
        fix: "Open Models, load an installed model, then send your message again.",
      });
    }
    if (this.#active.has(conversationId)) {
      throw new AppError("A reply is already being generated", {
        code: "generation_in_progress",
        status: 409,
        why: "Only one reply can run in a conversation at a time.",
        fix: "Stop the current reply, or wait for it to finish.",
      });
    }
    if (this.#running >= this.#maxConcurrent) {
      throw new AppError("The duck is already answering", {
        code: "generation_in_progress",
        status: 409,
        why: this.#maxConcurrent > 1
          ? `All ${this.#maxConcurrent} answer slots of the loaded model are in use.`
          : "ModelDuck runs one generation at a time on the CPU.",
        fix: "Wait for the other reply to finish, or stop it first.",
      });
    }
    const last = messages.at(-1);
    if (!last || last.role !== "user") {
      throw new AppError("The last message must be from you", {
        code: "invalid_messages",
        why: "The model needs a user message to answer.",
        fix: "Send a message, then try again.",
      });
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    this.#active.set(conversationId, controller);
    this.#running += 1;
    let finishGeneration = () => {};
    const generation = new Promise((resolve) => {
      finishGeneration = resolve;
    });
    this.#pending.add(generation);

    const normalized = normalizeSettings(settings ?? {});
    // IDEA-1675: per-model stops/sampling win over the global settings; other
    // models fall back to the global values so stops cannot bleed across models.
    const withModel = this.#registry?.resolveModelSettings
      ? this.#registry.resolveModelSettings(this.#state.model?.id, normalized)
      : normalized;
    const effectiveSettings = normalizeSettings(withModel);
    const effectiveSystemPrompt = buildSystemPrompt(systemPrompt, effectiveSettings.reasoning);
    let priorMessages = messages.slice(0, -1);
    let effectiveLast = last;
    let truncatedHistory = false;
    // IDEA-1082: truncate mode drops the oldest history (keeping the newest
    // turns) so a long chat survives overflow. Budgets below use the
    // effective (truncated) messages, and the session record stores the
    // truncated length, so a dropped history can never silently reuse a
    // session that holds different turns.
    if (effectiveSettings.contextOverflow === "truncate") {
      const contextSize = this.#context?.contextSize ?? 0;
      let probe = this.#countPromptTokens(effectiveSystemPrompt, [...priorMessages, effectiveLast]);
      while (priorMessages.length > 0 && probe + effectiveSettings.maxTokens > contextSize) {
        priorMessages = priorMessages.slice(1);
        truncatedHistory = true;
        probe = this.#countPromptTokens(effectiveSystemPrompt, [...priorMessages, effectiveLast]);
      }
      if (probe + effectiveSettings.maxTokens > contextSize && priorMessages.length === 0) {
        // One huge turn alone overflows: keep its tail (the newest tokens,
        // mirroring the completion path) instead of refusing outright.
        const tail = truncatePromptTail(
          effectiveLast.content,
          (count) => this.#countPromptTokens(effectiveSystemPrompt, [{ ...effectiveLast, content: count }]),
          Math.max(0, contextSize - effectiveSettings.maxTokens),
        );
        if (tail !== effectiveLast.content) {
          effectiveLast = { ...effectiveLast, content: tail };
          truncatedHistory = true;
          probe = this.#countPromptTokens(effectiveSystemPrompt, [effectiveLast]);
        }
      }
      // No explicit dropSession here: dropSession early-returns while this
      // conversation is active. Invalidation flows through the truncated
      // history length instead (see #sessionFor and the finally below).
    }
    const effectiveMessages = truncatedHistory ? [...priorMessages, effectiveLast] : messages;
    let history = buildChatHistory(priorMessages);
    const historyComplete = history.length === priorMessages.length;
    const promptText = repeatPrompt(effectiveLast.content, effectiveSettings.promptRepeat);
    const manifest = buildGenerationManifest({
      model: this.#state.model,
      originalSystemPrompt: systemPrompt,
      effectiveSystemPrompt,
      messages: priorMessages,
      history,
      promptText,
      settings: effectiveSettings,
      runtimeVersion: this.#state.runtimeVersion,
      chatTemplateHash: this.#state.model?.chatTemplateHash,
      // IDEA-1082: the digest covers the dropped history, so a truncated
      // turn never shares a cache key with a complete one.
      forceHistoryTruncated: truncatedHistory,
      // IDEA-1229: attest what was actually allocated for this reply.
      allocation: {
        allocatedContext: this.#context?.contextSize ?? null,
        requestedContext: Number(effectiveSettings.contextSize) || null,
        backend: this.#gpuBackend ?? "cpu",
        gpuLayers: this.#state.gpuLayers ?? null,
        fallback: this.#state.contextFallback ?? null,
      },
    });
    // IDEA-1076: exact-repeat deterministic answers skip regeneration entirely.
    // The store is memory-only and cleared on unload, so nothing private persists.
    const cacheable = eligibleForCache(effectiveSettings);
    const cached = cacheable ? this.#responseCache.get(manifest.digest) : null;
    if (cached) {
      // A hit never reaches the session: release the slot it reserved.
      signal?.removeEventListener?.("abort", abortFromCaller);
      this.#active.delete(conversationId);
      this.#running -= 1;
      this.#pending.delete(generation);
      finishGeneration();
      return {
        text: cached.text,
        aborted: false,
        stats: { ...cached.stats, cached: true, ms: 0 },
        manifest,
      };
    }
    const startedAt = Date.now();
    let firstTokenAt = null;
    let text = "";
    let outputTokens = 0;
    let stopReason = "eogToken";
    let sessionValid = false;

    try {
      const session = await this.#sessionFor(
        conversationId,
        effectiveMessages,
        effectiveSystemPrompt,
        effectiveSettings,
        history,
      );
      // Budgets measure what the session actually holds: the truncated
      // messages in truncate mode, the full conversation otherwise.
      const promptCount = this.#countPromptTokens(effectiveSystemPrompt, effectiveMessages);
      if (
        effectiveSettings.contextOverflow === "strict" &&
        promptCount + effectiveSettings.maxTokens > (this.#context?.contextSize ?? 0)
      ) {
        throw new AppError("The context is full", {
          code: "context_overflow",
          status: 413,
          why: `This conversation needs about ${promptCount + effectiveSettings.maxTokens} tokens but the model context is ${this.#context?.contextSize}.`,
          fix: "Start a new chat, raise Context size, or set Context overflow to shift.",
        });
      }
      // IDEA-1160: clamp the reply to the context that remains, even on the
      // default shift path, so an impossible reply is never requested.
      const remaining = (this.#context?.contextSize ?? 0) - promptCount;
      if (remaining <= 0) {
        throw new AppError("The context is full", {
          code: "context_overflow",
          status: 413,
          why: `This conversation needs about ${promptCount} tokens but the model context is ${this.#context?.contextSize}, leaving no room for a reply.`,
          fix: "Start a new chat, raise Context size, or shorten the conversation.",
        });
      }
      const replyMax = replyBudget(promptCount, this.#context?.contextSize ?? 0, effectiveSettings.maxTokens);
      // IDEA-1084: parallel sequences share one context window; divide it.
      // slotClamp itself guarantees progress (>= 1 while anything remains).
      const requestMax = slotClamp(replyMax, (this.#context?.contextSize ?? 0) - promptCount, this.#maxConcurrent);
      const grammar = await this.#grammarFor(effectiveSettings);
      // IDEA-1520: single canonical ordered sampler chain
      // (temperature -> topP -> topK -> minP -> repeat -> dry -> seed);
      // both paths spread samplerOptions() so the order is identical.
      const chatOptions = (activeGrammar) => ({
        maxTokens: requestMax, // aikit:allow-secret token limit, not a credential
        ...samplerOptions(effectiveSettings),
        responsePrefix: effectiveSettings.responsePrefix || undefined,
        customStopTriggers: effectiveSettings.customStopTriggers.length ? effectiveSettings.customStopTriggers : undefined,
        // IDEA-1161: the retry drops the constraint by passing undefined here.
        grammar: activeGrammar,
        signal: controller.signal,
        stopOnAbortSignal: true,
        onTextChunk: (chunk) => {
          if (!chunk) return;
          if (firstTokenAt === null) firstTokenAt = Date.now();
          text += chunk;
          onToken(chunk);
        },
        onToken: (tokens) => {
          outputTokens += tokens.length;
        },
      });
      let result = await session.promptWithMeta(promptText, chatOptions(grammar));

      // IDEA-1161: one grammar-drop retry on empty constrained output, sharing
      // the empty outcome with IDEA-1265 instead of succeeding silently.
      let retriedAfterEmpty = false;
      if (needsEmptyRetry({ text, grammarUsed: grammar, aborted: controller.signal.aborted })) {
        text = "";
        outputTokens = 0;
        stopReason = "eogToken";
        firstTokenAt = null;
        result = await session.promptWithMeta(promptText, chatOptions(undefined));
        retriedAfterEmpty = true;
      }

      if (!text && result?.responseText) text = result.responseText;
      stopReason = result?.stopReason ?? "eogToken";
      const finishedAt = Date.now();
      const generationMs = firstTokenAt
        ? Math.max(1, finishedAt - firstTokenAt)
        : Math.max(1, finishedAt - startedAt);
      const stats = {
        promptTokens: promptCount, // aikit:allow-secret token count, not a credential
        outputTokens: outputTokens || this.#safeCountTokens(text),
        tokensPerSecond:
          outputTokens > 0
            ? Number((outputTokens / (generationMs / 1000)).toFixed(2))
            : 0,
        firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        ms: finishedAt - startedAt,
        stopReason,
        // IDEA-1265: empty answers are flagged, never silent; IDEA-1161 shares it.
        empty: text.trim().length === 0,
        retriedAfterEmpty,
        // IDEA-1164: a degenerate tail loop is flagged for the sampler stack.
        loopDetected: detectLoop(text).loop,
        cached: false,
      };
      this.#state = { ...this.#state, lastStats: stats };
      const aborted = controller.signal.aborted || stopReason === "abort";
      sessionValid = !aborted;
      if (sessionValid && historyComplete) {
        const record = this.#sessions.get(conversationId);
        const nextLength = nextSessionHistoryLength(effectiveMessages.length, historyComplete);
        if (record && nextLength !== null) record.historyLength = nextLength;
      }
      // IDEA-1076: store exact-repeat deterministic answers, memory-only.
      if (cacheable && !aborted && text.length <= RESPONSE_CACHE_TEXT_MAX) {
        if (this.#responseCache.size >= RESPONSE_CACHE_MAX) {
          this.#responseCache.delete(this.#responseCache.keys().next().value);
        }
        this.#responseCache.set(manifest.digest, { text, stats });
      }
      return {
        text,
        aborted,
        stats,
        manifest,
      };
    } catch (error) {
      if (controller.signal.aborted || /abort/i.test(String(error?.name))) {
        return {
          text,
          aborted: true,
          stats: {
            promptTokens: this.#countPromptTokens(effectiveSystemPrompt, effectiveMessages), // aikit:allow-secret token count
            outputTokens: outputTokens || this.#safeCountTokens(text),
            tokensPerSecond: 0,
            firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
            ms: Date.now() - startedAt,
            stopReason: "abort",
          },
          manifest,
        };
      }
      this.#logger.warn?.(`[modelduck] Generation failed: ${error?.stack || error}`);
      throw toGenerationError(error);
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      this.#active.delete(conversationId);
      if (!sessionValid || !historyComplete) this.dropSession(conversationId);
      this.#running -= 1;
      this.#pending.delete(generation);
      finishGeneration();
    }
  }

  async complete({
    conversationId,
    prompt,
    settings,
    signal,
    onToken = () => {},
  }) {
    if (this.#state.status !== "ready" || !this.#context || !this.#model) {
      throw new AppError("No model is loaded", {
        code: "model_not_loaded",
        status: 409,
        why: "A model must be loaded before it can complete text.",
        fix: "Load a model in ModelDuck first.",
      });
    }
    if (this.#active.has(conversationId)) {
      throw new AppError("A completion is already running", {
        code: "generation_in_progress",
        status: 409,
        why: "Only one completion can run in a conversation at a time.",
        fix: "Wait for the current completion, or stop it.",
      });
    }
    if (this.#running >= this.#maxConcurrent) {
      throw new AppError("The duck is already answering", {
        code: "generation_in_progress",
        status: 409,
        why: this.#maxConcurrent > 1
          ? `All ${this.#maxConcurrent} answer slots of the loaded model are in use.`
          : "ModelDuck runs one generation at a time on the CPU.",
        fix: "Wait for the other reply to finish, or stop it first.",
      });
    }
    const promptText = String(prompt ?? "");
    if (!promptText.trim()) {
      throw new AppError("The prompt is required", {
        code: "invalid_prompt",
        why: "A text completion needs a non-empty prompt.",
        fix: "Send a prompt string in the request body.",
      });
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    this.#active.set(conversationId, controller);
    this.#running += 1;
    let finishGeneration = () => {};
    const generation = new Promise((resolve) => {
      finishGeneration = resolve;
    });
    this.#pending.add(generation);

    const normalized = normalizeSettings(settings ?? {});
    // IDEA-1675: per-model stops/sampling win over the global settings here too.
    const withModel = this.#registry?.resolveModelSettings
      ? this.#registry.resolveModelSettings(this.#state.model?.id, normalized)
      : normalized;
    const effectiveSettings = normalizeSettings(withModel);
    // The completion engine has no response-prefix option, so a tuned prefix
    // (the code-fence axis) is prefilled by continuing the prompt with it,
    // mirroring the chat path where the assistant turn starts with it.
    let fullPrompt = promptText + (effectiveSettings.responsePrefix || "");
    let truncatedPrompt = false;
    // IDEA-1082: truncate mode keeps the prompt tail so a completion can
    // proceed instead of failing. Truncation runs BEFORE the manifest is
    // built, so the cache key, the manifest and the stored entry all
    // describe the same tail — a hit and a miss never disagree.
    if (
      effectiveSettings.contextOverflow === "truncate" &&
      this.#countTokens(fullPrompt) + effectiveSettings.maxTokens > (this.#context?.contextSize ?? 0)
    ) {
      const budget = Math.max(1, (this.#context?.contextSize ?? 0) - effectiveSettings.maxTokens);
      const tail = truncatePromptTail(fullPrompt, (text) => this.#countTokens(text), budget);
      if (tail !== fullPrompt) {
        fullPrompt = tail;
        truncatedPrompt = true;
      }
    }
    const manifest = buildGenerationManifest({
      model: this.#state.model,
      originalSystemPrompt: "",
      effectiveSystemPrompt: "",
      messages: [],
      history: [],
      promptText: fullPrompt,
      settings: effectiveSettings,
      runtimeVersion: this.#state.runtimeVersion,
      chatTemplateHash: this.#state.model?.chatTemplateHash,
      forcePromptTruncated: truncatedPrompt,
      // IDEA-1229: attest what was actually allocated for this reply.
      allocation: {
        allocatedContext: this.#context?.contextSize ?? null,
        requestedContext: Number(effectiveSettings.contextSize) || null,
        backend: this.#gpuBackend ?? "cpu",
        gpuLayers: this.#state.gpuLayers ?? null,
        fallback: this.#state.contextFallback ?? null,
      },
    });
    const startedAt = Date.now();
    // IDEA-1076: same exact-repeat cache on the completion path.
    const completeCacheable = eligibleForCache(effectiveSettings);
    const completeCached = completeCacheable ? this.#responseCache.get(manifest.digest) : null;
    if (completeCached) {
      signal?.removeEventListener?.("abort", abortFromCaller);
      this.#active.delete(conversationId);
      this.#running -= 1;
      this.#pending.delete(generation);
      finishGeneration();
      return {
        text: completeCached.text,
        aborted: false,
        stats: { ...completeCached.stats, cached: true, ms: 0 },
        manifest,
      };
    }
    let firstTokenAt = null;
    let text = "";
    let outputTokens = 0;
    let stopReason = "eogToken";

    try {
      const promptTokens = this.#countTokens(fullPrompt); // aikit:allow-secret token count, not a credential
      if (
        effectiveSettings.contextOverflow === "strict" &&
        promptTokens + effectiveSettings.maxTokens > (this.#context.contextSize ?? 0)
      ) {
        throw new AppError("The context is full", {
          code: "context_overflow",
          status: 413,
          why: `This prompt needs about ${promptTokens + effectiveSettings.maxTokens} tokens but the model context is ${this.#context.contextSize}.`,
          fix: "Shorten the prompt, raise Context size, or set Context overflow to shift.",
        });
      }
      // IDEA-1160: same reply clamp as the chat path.
      if ((this.#context.contextSize ?? 0) - promptTokens <= 0) {
        throw new AppError("The context is full", {
          code: "context_overflow",
          status: 413,
          why: `This prompt needs about ${promptTokens} tokens but the model context is ${this.#context.contextSize}, leaving no room for a reply.`,
          fix: "Shorten the prompt, raise Context size, or set Context overflow to shift.",
        });
      }
      // IDEA-1084: same per-slot division on the completion path.
      const completionMax = slotClamp(replyBudget(promptTokens, this.#context.contextSize ?? 0, effectiveSettings.maxTokens), (this.#context.contextSize ?? 0) - promptTokens, this.#maxConcurrent);
      const grammar = await this.#grammarFor(effectiveSettings);
      // A lingering chat session occupies the only sequence with sequences=1.
      // Completions do not reuse chat history, so release idle sessions first.
      if ((this.#context.sequencesLeft ?? 0) === 0) this.#disposeIdleSessions();
      const sequence = await this.#acquireSequence();
      let completion = null;
      // IDEA-1520: same canonical ordered sampler chain as the chat path.
      const completionOptions = (activeGrammar) => ({
        maxTokens: completionMax, // aikit:allow-secret token limit, not a credential
        ...samplerOptions(effectiveSettings),
        customStopTriggers: effectiveSettings.customStopTriggers.length ? effectiveSettings.customStopTriggers : undefined,
        grammar: activeGrammar,
        signal: controller.signal,
        stopOnAbortSignal: true,
        onTextChunk: (chunk) => {
          if (!chunk) return;
          if (firstTokenAt === null) firstTokenAt = Date.now();
          text += chunk;
          onToken(chunk);
        },
        onToken: (tokens) => {
          outputTokens += tokens.length;
        },
      });
      let retriedAfterEmpty = false;
      try {
        if (!this.#completionClass) throw new Error("The completion engine is not ready");
        completion = new this.#completionClass({
          contextSequence: sequence,
          autoDisposeSequence: true,
        });
        let result = await completion.generateCompletionWithMeta(fullPrompt, completionOptions(grammar));
        // IDEA-1161: one grammar-drop retry on empty constrained output.
        if (needsEmptyRetry({ text, grammarUsed: grammar, aborted: controller.signal.aborted })) {
          text = "";
          outputTokens = 0;
          stopReason = "eogToken";
          firstTokenAt = null;
          result = await completion.generateCompletionWithMeta(fullPrompt, completionOptions(undefined));
          retriedAfterEmpty = true;
        }
        if (!text && result.response) text = result.response;
        stopReason = result.metadata?.stopReason ?? "eogToken";
      } finally {
        if (completion) completion.dispose();
        else sequence.dispose?.();
      }
      const finishedAt = Date.now();
      const generationMs = firstTokenAt
        ? Math.max(1, finishedAt - firstTokenAt)
        : Math.max(1, finishedAt - startedAt);
      const generatedTokens = this.#safeCountTokens(text) || outputTokens; // aikit:allow-secret token count
      const stats = {
        promptTokens, // aikit:allow-secret token count, not a credential
        outputTokens: generatedTokens,
        tokensPerSecond:
          generatedTokens > 0
            ? Number((generatedTokens / (generationMs / 1000)).toFixed(2))
            : 0,
        firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        ms: finishedAt - startedAt,
        stopReason,
        // IDEA-1265: empty answers are flagged, never silent; IDEA-1161 shares it.
        empty: text.trim().length === 0,
        retriedAfterEmpty,
        // IDEA-1164: a degenerate tail loop is flagged for the sampler stack.
        loopDetected: detectLoop(text).loop,
        cached: false,
      };
      this.#state = { ...this.#state, lastStats: stats };
      const completeAborted = controller.signal.aborted || stopReason === "abort";
      // IDEA-1076: store exact-repeat deterministic completions, memory-only.
      if (completeCacheable && !completeAborted && text.length <= RESPONSE_CACHE_TEXT_MAX) {
        if (this.#responseCache.size >= RESPONSE_CACHE_MAX) {
          this.#responseCache.delete(this.#responseCache.keys().next().value);
        }
        this.#responseCache.set(manifest.digest, { text, stats });
      }
      return {
        text,
        aborted: completeAborted,
        stats,
        manifest,
      };
    } catch (error) {
      if (controller.signal.aborted || /abort/i.test(String(error?.name))) {
        return {
          text,
          aborted: true,
          stats: {
            promptTokens: this.#countTokens(fullPrompt), // aikit:allow-secret token count
            outputTokens: this.#countTokens(text) || outputTokens, // aikit:allow-secret token count
            tokensPerSecond: 0,
            firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
            ms: Date.now() - startedAt,
            stopReason: "abort",
          },
          manifest,
        };
      }
      this.#logger.warn?.(`[modelduck] Completion failed: ${error?.stack || error}`);
      throw toGenerationError(error);
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      this.#active.delete(conversationId);
      this.#running -= 1;
      this.#pending.delete(generation);
      finishGeneration();
    }
  }

  async #sessionFor(conversationId, messages, systemPrompt, settings, history) {
    const signature = `${this.#state.model?.id ?? "none"}::${systemPrompt ?? ""}::${settings.contextSize}`;
    const existing = this.#sessions.get(conversationId);
    if (
      canReuseSession(existing, {
        signature,
        priorCount: messages.length - 1,
        historyComplete: history.length === messages.length - 1,
      })
    ) {
      this.#sessions.delete(conversationId);
      this.#sessions.set(conversationId, existing);
      return existing.session;
    }
    if (existing) {
      existing.session.dispose();
      this.#sessions.delete(conversationId);
    }
    // Only idle sessions; a conversation that is still answering keeps its sequence.
    for (const [key, record] of this.#sessions) {
      if (key !== conversationId && !this.#active.has(key)) {
        record.session.dispose();
        this.#sessions.delete(key);
      }
    }

    if (!this.#chatSessionClass) {
      throw new Error("The inference engine is not ready");
    }
    const sequence = await this.#acquireSequence();
    const session = new this.#chatSessionClass({
      contextSequence: sequence,
      systemPrompt,
      autoDisposeSequence: true,
    });
    // setChatHistory replaces the whole history, including the system message the constructor put first.
    session.setChatHistory([...session.getChatHistory().filter((item) => item.type === "system"), ...history]);
    const record = { session, signature, historyLength: messages.length - 1 };
    this.#sessions.set(conversationId, record);

    if (this.#sessions.size > MAX_SESSIONS) {
      const oldestId = this.#sessions.keys().next().value;
      if (oldestId && oldestId !== conversationId && !this.#active.has(oldestId)) {
        this.#sessions.get(oldestId).session.dispose();
        this.#sessions.delete(oldestId);
      }
    }
    return session;
  }

  #countPromptTokens(systemPrompt, messages) {
    const text = `${systemPrompt ?? ""}\n${messages.map((message) => message.content).join("\n")}`;
    return this.#countTokens(text);
  }

  async #grammarFor(settings) {
    if (settings.structuredOutput === "none") return undefined;
    const modelKey = this.#state.model?.id ?? this.#state.model?.fileName ?? "none";
    const grammarSignature = grammarSignatureFor(modelKey, settings);
    if (this.#grammarCache?.key === grammarSignature) return this.#grammarCache.grammar;
    if (!this.#llama) return undefined;
    let grammar;
    if (settings.structuredOutput === "json_schema") {
      let schema;
      try {
        schema = JSON.parse(settings.jsonSchema);
      } catch {
        throw new AppError("The JSON schema is invalid", {
          code: "invalid_json_schema",
          why: "Structured output is set to json_schema, but the schema is not valid JSON.",
          fix: "Fix the schema in Settings, or switch structured output to json_object.",
        });
      }
      assertJsonSchemaSupported(schema);
      try {
        grammar = await this.#llama.createGrammarForJsonSchema(schema);
      } catch (error) {
        throw new AppError("This JSON schema cannot be compiled", {
          code: "grammar_compile_failed",
          status: 422,
          why: `The grammar compiler rejected the schema: ${error?.message || error}`,
          fix: "Simplify the schema (plain types, no recursive refs), or switch structured output to json_object.",
        });
      }
    } else {
      grammar = await this.#llama.getGrammarFor("json");
    }
    this.#grammarCache = { key: grammarSignature, grammar };
    return grammar;
  }

  #countTokens(text) {
    return countTokensWith(this.#model, text);
  }

  #safeCountTokens(text) {
    try {
      if (!this.#model || !text) return 0;
      return this.#model.tokenize(text).length;
    } catch {
      return 0;
    }
  }

  /**
   * A free context sequence. node-llama-cpp gives a disposed sequence back to
   * the pool asynchronously, so a chat that starts right after another ended
   * waits briefly for it instead of failing with "No sequences left".
   */
  async #acquireSequence({ waitMs = 2000 } = {}) {
    const options = {
      checkpoints: this.#checkpoints ? { max: this.#checkpointMax, interval: this.#checkpointInterval } : { max: 1, interval: false },
    };
    const deadline = Date.now() + waitMs;
    while ((this.#context.sequencesLeft ?? 1) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.#context.getSequence(options);
  }

  #disposeIdleSessions() {
    for (const [key, record] of this.#sessions) {
      if (this.#active.has(key)) continue;
      record.session.dispose();
      this.#sessions.delete(key);
    }
  }

  #disposeSessions() {
    for (const record of this.#sessions.values()) {
      record.session.dispose();
    }
    this.#sessions.clear();
  }

  async #disposeModel() {
    if (this.#context) {
      await this.#context.dispose().catch(() => {});
      this.#context = null;
    }
    if (this.#model) {
      await this.#model.dispose().catch(() => {});
      this.#model = null;
    }
    this.#grammarCache = null; // IDEA-1163: drop grammars bound to the disposed model.
  }

  async dispose() {
    await this.unload();
    if (this.#llama) {
      await this.#llama.dispose().catch(() => {});
      this.#llama = null;
    }
  }
}
