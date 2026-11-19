import { normalizeSettings } from "./config.js";
import { publicModel } from "./engine.js";
import { conversation, refusal } from "./external-engines.js";
import { repeatPrompt } from "./generation-manifest.js";

/**
 * The engine interface over one backend. It serves the app (`/v1`, verified
 * code) and the tuner's evaluator alike, so it streams, can be aborted, and
 * returns the same `{ text, stats }` the in-process engine does.
 */
export class ServerEngine {
  #registry;
  #backend;
  #id;
  #state = { status: "idle", model: null };
  #entry = null;
  #load = null;
  #effective = null;
  #startLoad = null;
  #restarts = 0;
  #loadedAt = null;
  #active = new Map();
  #running = 0;
  #lastStats = null;

  constructor({ id, registry, backend }) {
    this.#id = id;
    this.#registry = registry;
    this.#backend = backend;
  }

  get engineId() {
    return this.#id;
  }

  get loadedId() {
    return this.#state.status === "ready" ? this.#state.model?.id ?? null : null;
  }

  get busy() {
    return this.#running > 0;
  }

  get phase() {
    return this.#state.status;
  }

  async startBackend() {}

  async status() {
    const entry = this.#entry;
    const load = this.#effective ?? {};
    return {
      ...this.#state,
      phase: this.phase,
      engine: this.#id,
      requestedContextSize: load.requestedContextSize ?? null,
      contextSize: load.contextSize ?? null,
      trainContextSize: entry?.contextLength ?? null,
      threads: load.threads ?? null,
      maxThreads: load.maxThreads ?? null,
      batchSize: load.batchSize ?? null,
      sequences: load.sequences ?? 1,
      flashAttention: load.flashAttention ?? null,
      useMmap: load.useMmap ?? null,
      gpuLayers: load.gpuLayers ?? null,
      gpuBackend: load.gpuBackend ?? "cpu",
      kvCache: load.kvCache ?? null,
      loadedAt: this.#loadedAt,
      restarts: this.#restarts,
      lastStats: this.#lastStats,
      fit: null,
      contextFallback: null,
      // An external engine's memory is not ours to read.
      memory: null,
    };
  }

  async load(options) {
    const entry = this.#registry.findById(options.modelId);
    if (!entry) throw refusal("Model not found", "model_not_found", "That model is no longer in the library.", "Choose an installed model.", 404);
    this.#state = { status: "loading", model: publicModel(entry) };
    // The same rule as the in-process engine (ADR-089): at least 16K, never more than the model was trained for.
    const requested = Math.max(16384, Number(options.contextSize) || 16384);
    const effective = { ...options, contextSize: Math.max(512, Math.min(requested, Number(entry.contextLength) || Infinity)) };
    try {
      await this.#backend.start({ entry, load: effective });
    } catch (error) {
      this.#state = { status: "error", model: this.#state.model, error: error.message };
      throw error;
    }
    this.#entry = entry;
    this.#load = options;
    this.#effective = { ...effective, requestedContextSize: requested };
    this.#startLoad = effective;
    this.#restarts = 0;
    this.#loadedAt = new Date().toISOString();
    this.#state = { status: "ready", model: publicModel(entry), error: null };
    return this.status();
  }

  /** A server cannot rebuild its context in place, so a context-level change restarts it. */
  async reconfigure(options) {
    if (!this.#entry) throw refusal("No model is loaded", "model_not_loaded", `${this.#id} has no model loaded.`, "Load a model first.", 409);
    return this.load({ ...this.#load, ...options, modelId: this.#entry.id });
  }

  #assertReady() {
    if (this.#state.status !== "ready") throw refusal("No model is loaded", "model_not_loaded", `${this.#id} has no model loaded.`, "Load a model first.", 409);
  }

  #assertSupported(settings) {
    const reasons = this.#backend.unsupported?.(settings) ?? [];
    if (reasons.length) {
      throw refusal("This engine cannot honour a setting", "engine_setting_unsupported", `${this.#id} cannot apply: ${reasons.join("; ")}.`, "Remove that setting, or load the model on the in-process engine.", 400);
    }
  }

  /**
   * A crashed engine process is restarted once, and only before the request produced anything: a client that already
   * received part of an answer must not be sent it twice. A second crash, or a restart that fails, is the result.
   */
  async #withRecovery(attempt, mayRetry) {
    try {
      return await attempt();
    } catch (error) {
      if (error?.code !== "engine_crashed" || !mayRetry() || !this.#entry) throw error;
      try {
        await this.#backend.start({ entry: this.#entry, load: this.#startLoad });
      } catch (restartError) {
        this.#state = { status: "error", model: this.#state.model, error: restartError.message };
        this.#entry = null;
        throw restartError;
      }
      this.#restarts += 1;
      return attempt();
    }
  }

  /** One request: tracked for abort and for `busy`, and a cancel returns what was produced so far, as the in-process engine does. */
  async #run(conversationId, signal, work) {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.#active.set(conversationId, controller);
    this.#running += 1;
    const started = Date.now();
    let text = "";
    try {
      const result = await this.#withRecovery(() => work(merged, (piece) => { text += piece; }), () => text === "" && !merged.aborted);
      const stats = { ms: Date.now() - started, tokensPerSecond: result.tokensPerSecond, outputTokens: result.outputTokens, stopReason: result.stopReason, promptTokens: result.promptTokens, firstTokenMs: result.firstTokenMs };
      this.#lastStats = stats;
      return { text: result.text, stats, manifest: null };
    } catch (error) {
      if (merged.aborted) {
        const stats = { ms: Date.now() - started, tokensPerSecond: null, outputTokens: null, stopReason: "abort", promptTokens: null, firstTokenMs: null };
        return { text, stats, manifest: null };
      }
      throw error;
    } finally {
      this.#running -= 1;
      if (this.#active.get(conversationId) === controller) this.#active.delete(conversationId);
    }
  }

  async chat({ conversationId = "chat", messages, systemPrompt, settings = {}, signal, onToken = () => {} }) {
    this.#assertReady();
    const normalized = normalizeSettings(settings);
    this.#assertSupported(normalized);
    const turns = messages.map(({ role, content }) => ({ role, content }));
    const last = turns.at(-1);
    if (last?.role === "user") last.content = repeatPrompt(last.content, normalized.promptRepeat);
    const sent = conversation(systemPrompt, turns, normalized.reasoning);
    return this.#run(conversationId, signal, (merged, count) => this.#backend.generate({ messages: sent, settings: normalized, signal: merged, onToken: (piece) => { count(piece); onToken(piece); } }));
  }

  async complete({ conversationId = "complete", prompt, settings = {}, signal, onToken = () => {} }) {
    this.#assertReady();
    const normalized = normalizeSettings(settings);
    this.#assertSupported(normalized);
    return this.#run(conversationId, signal, (merged, count) => this.#backend.complete({ prompt: String(prompt ?? ""), settings: normalized, signal: merged, onToken: (piece) => { count(piece); onToken(piece); } }));
  }

  abort(conversationId) {
    const controller = this.#active.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  dropSession() {}

  async unload() {
    for (const controller of this.#active.values()) controller.abort();
    await this.#backend.stop();
    this.#entry = null;
    this.#load = null;
    this.#effective = null;
    this.#state = { status: "idle", model: null };
  }

  async teardown() {
    const modelId = this.#state.model?.id ?? null;
    await this.unload();
    return { modelId, disposedAt: new Date().toISOString(), errors: [] };
  }

  async dispose() {
    await this.unload();
  }
}
