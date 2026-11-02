import os from "node:os";

import { AppError } from "./errors.js";
import { normalizeSettings } from "./config.js";
import { toGenerationError, toLoadError } from "./engine-errors.js";
import { formatBytes } from "./fs-atomic.js";
import { estimateLoad, estimateLoadV2, fitVerdict, splitKvCache } from "./memory-fit.js";
import {
  buildChatHistory,
  buildGenerationManifest,
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
function validKvLabel(label) {
  const parts = String(label ?? "").split(":");
  return parts.length <= 2 && parts.every((part) => part in KV_CACHE_TYPES) ? parts.join(":") : "f16";
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
    const contextTokens = Math.max(512, Math.min(Number(contextSize) || 4096, entry.contextLength || Infinity));
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

  get loadedId() {
    return this.#state.model?.id ?? null;
  }

  get busy() {
    return this.#running > 0;
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
    return { ...this.#state, memory };
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
    await this.unload();
    this.#state = { ...this.#state, status: "loading", model: publicModel(entry), error: null };

    try {
      const module = await this.#loadRuntime();
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
      const actualBatchSize = Math.max(32, Math.min(8192, Number(batchSize) || 512));
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
      const trained = this.#model.trainContextSize || 4096;
      const wanted = Math.max(512, Math.min(Number(contextSize) || 4096, trained));
      const attempts = [...new Set([wanted, Math.min(wanted, 3072), 2048, 1024])];
      this.#checkpoints = checkpoints !== false;
      this.#checkpointInterval = Math.max(128, Math.min(32768, Number(checkpointInterval) || 8192));
      this.#checkpointMax = Math.max(1, Math.min(64, Number(checkpointMax) || 32));

      let lastError = null;
      for (const attempt of attempts) {
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
      return { ...this.#state };
    } catch (error) {
      await this.#disposeModel();
      this.#state = {
        ...this.#state,
        status: "error",
        error: error?.message || String(error),
      };
      throw toLoadError(error);
    } finally {
      this.#loading = false;
    }
  }

  async unload() {
    for (const controller of this.#active.values()) controller.abort();
    await Promise.allSettled([...this.#pending]);
    this.#active.clear();
    this.#disposeSessions();
    await this.#disposeModel();
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
    };
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
    const effectiveSystemPrompt = buildSystemPrompt(systemPrompt, normalized.reasoning);
    const priorMessages = messages.slice(0, -1);
    const history = buildChatHistory(priorMessages);
    const historyComplete = history.length === priorMessages.length;
    const promptText = repeatPrompt(last.content, normalized.promptRepeat);
    const manifest = buildGenerationManifest({
      model: this.#state.model,
      originalSystemPrompt: systemPrompt,
      effectiveSystemPrompt,
      messages: priorMessages,
      history,
      promptText,
      settings: normalized,
      runtimeVersion: this.#state.runtimeVersion,
      chatTemplateHash: this.#state.model?.chatTemplateHash,
    });
    const startedAt = Date.now();
    let firstTokenAt = null;
    let text = "";
    let outputTokens = 0;
    let stopReason = "eogToken";
    let sessionValid = false;

    try {
      const session = await this.#sessionFor(
        conversationId,
        messages,
        effectiveSystemPrompt,
        normalized,
        history,
      );
      const promptCount = this.#countPromptTokens(effectiveSystemPrompt, messages);
      if (
        normalized.contextOverflow === "strict" &&
        promptCount + normalized.maxTokens > (this.#context?.contextSize ?? 0)
      ) {
        throw new AppError("The context is full", {
          code: "context_overflow",
          status: 413,
          why: `This conversation needs about ${promptCount + normalized.maxTokens} tokens but the model context is ${this.#context?.contextSize}.`,
          fix: "Start a new chat, raise Context size, or set Context overflow to shift.",
        });
      }
      const grammar = await this.#grammarFor(normalized);
      const result = await session.promptWithMeta(promptText, {
        maxTokens: normalized.maxTokens, // aikit:allow-secret token limit, not a credential
        temperature: normalized.temperature,
        topP: normalized.topP,
        topK: normalized.topK,
        minP: normalized.minP,
        seed: normalized.seed >= 0 ? normalized.seed : undefined,
        responsePrefix: normalized.responsePrefix || undefined,
        customStopTriggers: normalized.customStopTriggers.length ? normalized.customStopTriggers : undefined,
        repeatPenalty:
          normalized.repeatPenalty > 1
            ? {
                penalty: normalized.repeatPenalty,
                lastTokens: normalized.repeatPenaltyTokens, // aikit:allow-secret repetition window, not a credential,
                penalizeNewLine: normalized.penalizeNewLine !== false,
              }
            : false,
        dryRepeatPenalty:
          normalized.dryStrength > 0
            ? {
                strength: normalized.dryStrength,
                base: normalized.dryBase,
                allowedLength: normalized.dryAllowedLength,
              }
            : false,
        grammar,
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

      if (!text && result?.responseText) text = result.responseText;
      stopReason = result?.stopReason ?? "eogToken";
      const finishedAt = Date.now();
      const generationMs = firstTokenAt
        ? Math.max(1, finishedAt - firstTokenAt)
        : Math.max(1, finishedAt - startedAt);
      const stats = {
        promptTokens: promptCount, // aikit:allow-secret token count, not a credential
        outputTokens: outputTokens || this.#countTokens(text),
        tokensPerSecond:
          outputTokens > 0
            ? Number((outputTokens / (generationMs / 1000)).toFixed(2))
            : 0,
        firstTokenMs: firstTokenAt ? firstTokenAt - startedAt : null,
        ms: finishedAt - startedAt,
        stopReason,
      };
      this.#state = { ...this.#state, lastStats: stats };
      const aborted = controller.signal.aborted || stopReason === "abort";
      sessionValid = !aborted;
      if (sessionValid && historyComplete) {
        const record = this.#sessions.get(conversationId);
        const nextLength = nextSessionHistoryLength(messages.length, historyComplete);
        if (record && nextLength !== null) record.historyLength = nextLength;
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
            promptTokens: this.#countPromptTokens(effectiveSystemPrompt, messages), // aikit:allow-secret token count
            outputTokens: outputTokens || this.#countTokens(text),
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
    const manifest = buildGenerationManifest({
      model: this.#state.model,
      originalSystemPrompt: "",
      effectiveSystemPrompt: "",
      messages: [],
      history: [],
      promptText,
      settings: normalized,
      runtimeVersion: this.#state.runtimeVersion,
      chatTemplateHash: this.#state.model?.chatTemplateHash,
    });
    const startedAt = Date.now();
    let firstTokenAt = null;
    let text = "";
    let outputTokens = 0;
    let stopReason = "eogToken";

    try {
      const promptTokens = this.#countTokens(promptText); // aikit:allow-secret token count, not a credential
      if (
        normalized.contextOverflow === "strict" &&
        promptTokens + normalized.maxTokens > (this.#context.contextSize ?? 0)
      ) {
        throw new AppError("The context is full", {
          code: "context_overflow",
          status: 413,
          why: `This prompt needs about ${promptTokens + normalized.maxTokens} tokens but the model context is ${this.#context.contextSize}.`,
          fix: "Shorten the prompt, raise Context size, or set Context overflow to shift.",
        });
      }
      const grammar = await this.#grammarFor(normalized);
      // A lingering chat session occupies the only sequence with sequences=1.
      // Completions do not reuse chat history, so release idle sessions first.
      if ((this.#context.sequencesLeft ?? 0) === 0) this.#disposeIdleSessions();
      const sequence = await this.#acquireSequence();
      let completion = null;
      try {
        if (!this.#completionClass) throw new Error("The completion engine is not ready");
        completion = new this.#completionClass({
          contextSequence: sequence,
          autoDisposeSequence: true,
        });
        const result = await completion.generateCompletionWithMeta(promptText, {
          maxTokens: normalized.maxTokens, // aikit:allow-secret token limit, not a credential
          temperature: normalized.temperature,
          topP: normalized.topP,
          topK: normalized.topK,
          minP: normalized.minP,
          seed: normalized.seed >= 0 ? normalized.seed : undefined,
          customStopTriggers: normalized.customStopTriggers.length ? normalized.customStopTriggers : undefined,
          repeatPenalty:
            normalized.repeatPenalty > 1
              ? {
                  penalty: normalized.repeatPenalty,
                  lastTokens: normalized.repeatPenaltyTokens, // aikit:allow-secret repetition window, not a credential
                  penalizeNewLine: normalized.penalizeNewLine !== false,
                }
              : false,
          dryRepeatPenalty:
            normalized.dryStrength > 0
              ? {
                  strength: normalized.dryStrength,
                  base: normalized.dryBase,
                  allowedLength: normalized.dryAllowedLength,
                }
              : false,
          grammar,
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
      const generatedTokens = this.#countTokens(text) || outputTokens; // aikit:allow-secret token count
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
      };
      this.#state = { ...this.#state, lastStats: stats };
      return {
        text,
        aborted: controller.signal.aborted || stopReason === "abort",
        stats,
        manifest,
      };
    } catch (error) {
      if (controller.signal.aborted || /abort/i.test(String(error?.name))) {
        return {
          text,
          aborted: true,
          stats: {
            promptTokens: this.#countTokens(promptText), // aikit:allow-secret token count
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
    const grammarSignature = `${settings.structuredOutput}|${settings.jsonSchema}`;
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
      grammar = await this.#llama.createGrammarForJsonSchema(schema);
    } else {
      grammar = await this.#llama.getGrammarFor("json");
    }
    this.#grammarCache = { key: grammarSignature, grammar };
    return grammar;
  }

  #countTokens(text) {
    if (!this.#model || !text) return 0;
    try {
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
  }

  async dispose() {
    await this.unload();
    if (this.#llama) {
      await this.#llama.dispose().catch(() => {});
      this.#llama = null;
    }
  }
}
