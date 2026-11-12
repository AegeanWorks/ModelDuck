import { createHash } from "node:crypto";

import { AppError } from "../src/errors.js";
import { LOAD_KEYS } from "../src/model-profiles.js";
import { PROMPTS, SYSTEM_PROMPT, checkCount, evaluateResponse } from "./suite.mjs";

const LOAD_DEFAULTS = Object.freeze({
  contextSize: 16384,
  threads: 8,
  batchSize: 512,
  sequences: 1,
  flashAttention: "auto",
  useMmap: "auto",
  gpuLayers: 0,
  gpuBackend: "cpu",
  checkpoints: true,
  checkpointInterval: 8192,
  checkpointMax: 32,
  kvCache: "f16",
});

const SAMPLING_DEFAULTS = Object.freeze({
  temperature: 0,
  topP: 1,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  penalizeNewLine: true,
  dryStrength: 0,
  dryBase: 1.75,
  dryAllowedLength: 4,
  responsePrefix: "",
  customStopTriggers: [],
  maxTokens: 512,
  reasoning: "off",
  promptRepeat: 1,
});

const digestOf = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

const pick = (settings, keys) => Object.fromEntries(keys.filter((key) => key in settings).map((key) => [key, settings[key]]));

/** Model-level load keys: changing one costs a full model reload. */
export const MODEL_LEVEL_KEYS = Object.freeze(["useMmap", "gpuLayers", "gpuBackend"]);

/** Context-level load keys: changing one only re-creates the context (ADR-095). */
export const CONTEXT_LEVEL_KEYS = Object.freeze(["contextSize", "threads", "batchSize", "sequences", "flashAttention", "kvCache", "checkpoints", "checkpointInterval", "checkpointMax"]);

/** The runtime thread cap lifted above every axis candidate, so a context
 * rebuilt at a thread count is never silently clipped to a previous setting. */
const THREAD_CAP = 64;

/**
 * The `evaluate(settings, itemIds, seed)` the tuner drives, on a real engine.
 * A model-level setting change reloads the model; a context-level change
 * rebuilds the context in place on the resident model (ADR-095), so threads,
 * batch, context, KV and attention sweeps pay ~60-80 ms instead of a full
 * model reload. Answers are byte-identical either way: a rebuilt context is
 * the same options a dedicated load would have created. With `parallel` > 1
 * the model is loaded with that many sequences and that many items are
 * answered at once; `settings.parallelism: 1` (the timing stages) answers one
 * at a time.
 */
export function createEvaluator({ engine, modelId, prompts = PROMPTS, systemPrompt = SYSTEM_PROMPT, timeoutMs = 120_000, parallel = 1, beforeAnswer = async () => {}, onItem = () => {} }) {
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  let modelSignature = null;
  let contextSignature = null;
  let memoryBytes = null;
  let gpuVram = null;

  async function ensureLoaded(settings) {
    const load = { ...LOAD_DEFAULTS, ...pick(settings, LOAD_KEYS), sequences: Math.max(1, parallel) };
    const nextModel = JSON.stringify(pick(load, MODEL_LEVEL_KEYS));
    const nextContext = JSON.stringify(pick(load, CONTEXT_LEVEL_KEYS));
    if (modelSignature === nextModel && contextSignature === nextContext) return load;
    const reloadModel = modelSignature !== nextModel;
    modelSignature = null;
    contextSignature = null;
    if (reloadModel) {
      await engine.load({ modelId, ...load, maxThreads: THREAD_CAP });
    } else {
      await engine.reconfigure(load);
    }
    const memory = (await engine.status())?.memory ?? null;
    memoryBytes = memory?.cpuRam ?? null;
    // M9: the KV cache lives in VRAM on a GPU, so the tie-break needs both.
    gpuVram = memory?.gpuVram ?? null;
    await warmUp(load);
    modelSignature = nextModel;
    contextSignature = nextContext;
    return load;
  }

  /** One short untimed answer so the first timed item does not pay for cold pages and caches. */
  async function warmUp(load) {
    const conversationId = `tune-${modelId}-warmup`;
    try {
      await engine.chat({
        conversationId,
        messages: [{ role: "user", content: "Say hi." }],
        systemPrompt,
        settings: { ...SAMPLING_DEFAULTS, maxTokens: 8, seed: 42, contextOverflow: "shift", contextSize: load.contextSize, threads: load.threads, kvCache: load.kvCache },
        signal: AbortSignal.timeout(timeoutMs),
        onToken: () => {},
      });
    } catch {
      // A failed warm-up only means the first item runs cold; the item itself reports real errors.
    } finally {
      engine.dropSession(conversationId);
    }
  }

  async function answer(prompt, settings, load, seed) {
    const conversationId = `tune-${modelId}-${prompt.id}-${seed}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const result = await engine.chat({
        conversationId,
        messages: [{ role: "user", content: prompt.prompt }],
        systemPrompt: settings.systemPrompt ?? systemPrompt,
        settings: {
          ...SAMPLING_DEFAULTS,
          ...pick(settings, Object.keys(SAMPLING_DEFAULTS)),
          maxTokens: settings.maxTokens ?? prompt.maxTokens ?? SAMPLING_DEFAULTS.maxTokens,
          seed,
          contextOverflow: "shift",
          contextSize: load.contextSize,
          threads: load.threads,
          kvCache: load.kvCache,
        },
        signal: controller.signal,
        onToken: () => {},
      });
      const evaluation = await evaluateResponse(prompt, result.text);
      return {
        passed: evaluation.passed,
        total: evaluation.total,
        unreadable: evaluation.unreadable,
        text: result.text,
        error: null,
        ms: result.stats?.ms ?? Date.now() - started,
        tokensPerSecond: result.stats?.tokensPerSecond ?? null,
        outputTokens: result.stats?.outputTokens ?? null,
        // Serving evidence (M1/M9/V4): the budget cap, prompt size and TTFT stay
        // with every answer instead of being dropped like before.
        stopReason: result.stats?.stopReason ?? null,
        promptTokens: result.stats?.promptTokens ?? null,
        firstTokenMs: result.stats?.firstTokenMs ?? null,
        digest: digestOf(result.text),
      };
    } catch (error) {
      return { passed: 0, total: checkCount(prompt), error: error.message, ms: Date.now() - started, tokensPerSecond: null, outputTokens: null, stopReason: null, promptTokens: null, firstTokenMs: null, digest: null };
    } finally {
      clearTimeout(timer);
      engine.dropSession(conversationId);
    }
  }

  const evaluate = async function evaluate(settings, itemIds, seed) {
    const items = itemIds.map((id) => {
      const prompt = byId.get(id);
      if (prompt) return prompt;
      throw new AppError("Unknown benchmark item", { code: "unknown_item", why: `No suite item has the id "${id}".`, fix: "Rebuild the tuning rungs from the current suite." });
    });
    let load;
    try {
      load = await ensureLoaded(settings);
    } catch (error) {
      // Unstable KV types can refuse to load; that is a result for these settings, not a reason to stop the tune.
      const reason = `load failed: ${error.message}`;
      return { prompts: items.map((prompt) => ({ id: prompt.id, passed: 0, total: checkCount(prompt), error: reason, ms: null, tokensPerSecond: null })), memoryBytes: null, gpuVram: null };
    }
    const results = new Array(items.length);
    const width = settings.parallelism === 1 ? 1 : Math.max(1, parallel);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        // Untimed answers wait here while another tune times something (ADR-033).
        if (!settings.timed) await beforeAnswer();
        results[index] = { id: items[index].id, ...(await answer(items[index], settings, load, seed)) };
        onItem(results[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
    return { prompts: results, memoryBytes, gpuVram };
  };
  // The context budget loads the model first so the GPU's free memory can be read (ADR-043).
  evaluate.ensureLoaded = ensureLoaded;
  return evaluate;
}
