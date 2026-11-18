import { spawn } from "node:child_process";
import net from "node:net";

import { normalizeSettings } from "./config.js";
import { cleanPath } from "./engine-env.js";
import { publicModel } from "./engine.js";
import { AppError } from "./errors.js";
import { buildSystemPrompt, repeatPrompt } from "./generation-manifest.js";
import { splitKvCache } from "./memory-fit.js";

/**
 * Engines outside this process, behind the interface the tuner's evaluator and
 * the app's /v1 layer use on `LlamaEngine` (ADR-156, ADR-159): `load`,
 * `reconfigure`, `status`, `chat`, `complete`, `abort`, `dropSession`, `unload`.
 * A `ServerEngine` owns the interface and the result mapping; a backend owns
 * one server's protocol (`start`, `generate`, `complete`, `stop`, and
 * `unsupported`, the settings it cannot honour). A setting an engine cannot
 * honour is refused with a Why and a Fix, never silently changed.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A free local TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const refusal = (title, code, why, fix, status = 500) => new AppError(title, { code, status, why, fix });

/** The conversation a chat request sends: the (reasoning-aware) system prompt, then the turns. */
function conversation(systemPrompt, messages, reasoning) {
  const system = buildSystemPrompt(systemPrompt, reasoning ?? "off");
  return [...(system ? [{ role: "system", content: system }] : []), ...messages.map(({ role, content }) => ({ role, content }))];
}

/** Sampling and output controls in the names OpenAI-style servers share (llama.cpp, vLLM, koboldcpp...). */
function openAiFields(settings, { vllmNames = false } = {}) {
  const body = {
    temperature: settings.temperature,
    top_p: settings.topP,
    top_k: settings.topK,
    min_p: settings.minP,
    repeat_penalty: settings.repeatPenalty,
    ...(vllmNames && { repetition_penalty: settings.repeatPenalty }),
    seed: settings.seed,
    max_tokens: settings.maxTokens,
  };
  if (settings.customStopTriggers?.length) body.stop = settings.customStopTriggers;
  if (settings.dryStrength > 0) {
    body.dry_multiplier = settings.dryStrength;
    body.dry_base = settings.dryBase;
    body.dry_allowed_length = settings.dryAllowedLength;
  }
  if (settings.structuredOutput === "json_object") body.response_format = { type: "json_object" };
  if (settings.structuredOutput === "json_schema" && settings.jsonSchema) {
    body.response_format = { type: "json_schema", json_schema: { name: "response", schema: JSON.parse(settings.jsonSchema) } };
  }
  return body;
}

/** Parsed `data:` events of a server-sent stream; `[DONE]` ends it. */
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let cut;
    while ((cut = pending.indexOf("\n\n")) !== -1) {
      const event = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

/** Parsed lines of a newline-delimited JSON stream (Ollama). */
async function* ndjsonEvents(body) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, cut).trim();
      pending = pending.slice(cut + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (pending.trim()) yield JSON.parse(pending);
}

/** One OpenAI-style stream read to the end: the text, how it stopped, and the server's own counts and timings. */
async function readOpenAiStream(response, { pieceOf, onToken, started }) {
  let text = "";
  let finish = null;
  let usage = null;
  let timings = null;
  let firstAt = null;
  for await (const event of sseEvents(response.body)) {
    const choice = event.choices?.[0];
    const piece = pieceOf(choice) ?? "";
    if (piece) {
      firstAt ??= performance.now();
      text += piece;
      onToken?.(piece);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (event.usage) usage = event.usage;
    if (event.timings) timings = event.timings;
  }
  const endedAt = performance.now();
  const outputTokens = usage?.completion_tokens ?? timings?.predicted_n ?? null;
  const decodeMs = firstAt === null ? 0 : endedAt - firstAt;
  const derived = outputTokens > 1 && decodeMs > 0 ? Number(((outputTokens - 1) / (decodeMs / 1000)).toFixed(2)) : null;
  return {
    text,
    stopReason: finish === "length" ? "maxTokens" : "eogToken",
    promptTokens: usage?.prompt_tokens ?? (timings ? (timings.prompt_n ?? 0) + (timings.cache_n ?? 0) : null),
    outputTokens,
    tokensPerSecond: Number.isFinite(timings?.predicted_per_second) ? Number(timings.predicted_per_second.toFixed(2)) : derived,
    firstTokenMs: Number.isFinite(timings?.prompt_ms) ? Math.round(timings.prompt_ms) : firstAt === null ? null : Math.round(firstAt - started),
  };
}

const chatPiece = (choice) => choice?.delta?.content;
const textPiece = (choice) => choice?.text;

async function post(fetchImpl, url, body, signal, headers = { "content-type": "application/json" }, who = "The engine") {
  const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    throw refusal(`${who} refused the request`, "engine_request_failed", `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`, "Check the prompt against the context size, and the model name.");
  }
  return response;
}

/** llama.cpp's llama-server, started for one load and stopped on the next. */
export class LlamaServerBackend {
  #binary;
  #spawn;
  #fetch;
  #startTimeoutMs;
  #cachePrompt;
  #child = null;
  #base = null;

  /** `cachePrompt`: reuse the prompt cache between requests (serving); a tune sets it off so every answer pays for its own prompt. */
  constructor({ binary, spawnImpl = spawn, fetchImpl = globalThis.fetch, startTimeoutMs = 120_000, cachePrompt = false }) {
    this.#binary = binary;
    this.#spawn = spawnImpl;
    this.#fetch = fetchImpl;
    this.#startTimeoutMs = startTimeoutMs;
    this.#cachePrompt = cachePrompt;
  }

  /** The command line one load asks for; `-ngl` is only sent when a GPU backend was requested. */
  static args({ entry, load, port }) {
    const kv = splitKvCache(load.kvCache);
    const sequences = Math.max(1, Number(load.sequences) || 1);
    const gpu = load.gpuBackend && load.gpuBackend !== "cpu";
    const layers = !gpu ? 0 : load.gpuLayers === "max" || load.gpuLayers === "auto" ? 999 : Number(load.gpuLayers) || 0;
    return [
      "-m", entry.path, "--host", "127.0.0.1", "--port", String(port), "--no-webui",
      "-c", String((Number(load.contextSize) || 4096) * sequences), "-np", String(sequences),
      "-t", String(load.threads || 4), "-b", String(load.batchSize || 512),
      "-ngl", String(layers), "-ctk", kv.key, "-ctv", kv.value,
      "-fa", load.flashAttention === "on" ? "on" : load.flashAttention === "off" ? "off" : "auto",
      ...(load.useMmap === false || load.useMmap === "off" ? ["-lm", "none"] : load.useMmap === true || load.useMmap === "on" ? ["-lm", "mmap"] : []),
    ];
  }

  /** What llama-server's chat endpoint cannot do, so it is refused instead of changed. */
  unsupported(settings) {
    const reasons = [];
    if (settings.responsePrefix) reasons.push("responsePrefix (the chat endpoint cannot force a reply to start with given text)");
    if (settings.penalizeNewLine === false) reasons.push("penalizeNewLine off (the server has no such switch)");
    return reasons;
  }

  async start({ entry, load }) {
    await this.stop();
    const port = await freePort();
    const child = this.#spawn(this.#binary, LlamaServerBackend.args({ entry, load, port }), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ...process.env, PATH: cleanPath(process.env.PATH) },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    let exited = null;
    child.once("exit", (code) => { exited = code ?? "signal"; });
    // A tune or app that dies must not leave a server holding the model.
    const reap = () => child.kill();
    process.once("exit", reap);
    this.#child = Object.assign(child, { reap });
    this.#base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + this.#startTimeoutMs;
    for (;;) {
      if (exited !== null) {
        throw refusal("llama-server did not start", "engine_start_failed", `It exited with ${exited} while loading ${entry.fileName}: ${stderr.trim().split("\n").slice(-3).join(" | ") || "no output"}`, "Check the settings (context size, GPU layers) against this build, or use another engine.");
      }
      try {
        if ((await this.#fetch(`${this.#base}/health`, { signal: AbortSignal.timeout(1500) })).ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw refusal("llama-server did not start in time", "engine_start_timeout", `It was not ready after ${Math.round(this.#startTimeoutMs / 1000)} s.`, "Try a smaller context or model, or use another engine.");
      }
      await sleep(100);
    }
  }

  async generate({ messages, settings, signal, onToken }) {
    const started = performance.now();
    const response = await post(this.#fetch, `${this.#base}/v1/chat/completions`, { messages, stream: true, stream_options: { include_usage: true }, cache_prompt: this.#cachePrompt, ...openAiFields(settings) }, signal, undefined, "llama-server");
    return readOpenAiStream(response, { pieceOf: chatPiece, onToken, started });
  }

  async complete({ prompt, settings, signal, onToken }) {
    const started = performance.now();
    const response = await post(this.#fetch, `${this.#base}/v1/completions`, { prompt, stream: true, stream_options: { include_usage: true }, cache_prompt: this.#cachePrompt, ...openAiFields(settings) }, signal, undefined, "llama-server");
    return readOpenAiStream(response, { pieceOf: textPiece, onToken, started });
  }

  async stop() {
    const child = this.#child;
    this.#child = null;
    this.#base = null;
    if (!child) return;
    process.removeListener("exit", child.reap);
    if (child.exitCode === null) {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([gone, sleep(5000)]);
    }
  }
}

/** A running Ollama server. It owns its own model store, so a model is named by tag. */
export class OllamaBackend {
  #baseUrl;
  #fetch;
  #model;
  #tag = null;
  #options = {};

  constructor({ baseUrl = "http://127.0.0.1:11434", model = null, fetchImpl = globalThis.fetch }) {
    this.#baseUrl = baseUrl;
    this.#model = model;
    this.#fetch = fetchImpl;
  }

  unsupported(settings) {
    const reasons = [];
    if (settings.responsePrefix) reasons.push("responsePrefix (Ollama cannot force a reply to start with given text)");
    if (settings.dryStrength > 0) reasons.push("the DRY repetition sampler (Ollama has none)");
    return reasons;
  }

  async #json(route, body, signal) {
    const response = await this.#fetch(`${this.#baseUrl}${route}`, {
      method: body ? "POST" : "GET",
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw refusal("Ollama refused the request", "engine_request_failed", `HTTP ${response.status} for ${route}: ${(await response.text()).slice(0, 300)}`, "Check that the model is pulled in Ollama.");
    return response.json();
  }

  async start({ entry, load }) {
    try {
      await this.#json("/api/version");
    } catch {
      throw refusal("Ollama is not running", "engine_start_failed", `No Ollama server answered at ${this.#baseUrl}.`, "Start Ollama, or pick another engine.");
    }
    const { models = [] } = await this.#json("/api/tags");
    const stem = String(entry.fileName ?? "").toLowerCase().replace(/\.gguf$/, "").replace(/[-_.:]/g, "");
    const tag = this.#model ?? models.find((model) => {
      const name = String(model.name ?? "").toLowerCase().replace(/[-_.:]/g, "");
      return name.length > 3 && stem.includes(name.split("latest")[0] || name);
    })?.name;
    if (!tag) throw refusal("Ollama has no matching model", "engine_start_failed", `None of its ${models.length} models matches ${entry.fileName}.`, "Pass --ollama-model <tag> to name the model to use.");
    this.#tag = tag;
    const gpu = load.gpuBackend && load.gpuBackend !== "cpu";
    this.#options = {
      num_ctx: Number(load.contextSize) || 4096,
      num_thread: Number(load.threads) || undefined,
      num_batch: Number(load.batchSize) || undefined,
      ...(gpu ? {} : { num_gpu: 0 }),
    };
    // Loading with these options now makes the first answer measure answering, not loading.
    await this.#json("/api/generate", { model: tag, prompt: "", stream: false, keep_alive: "10m", options: this.#options });
  }

  #options_(settings) {
    return {
      ...this.#options,
      temperature: settings.temperature, top_p: settings.topP, top_k: settings.topK, min_p: settings.minP,
      repeat_penalty: settings.repeatPenalty, penalize_newline: settings.penalizeNewLine, seed: settings.seed, num_predict: settings.maxTokens,
      ...(settings.customStopTriggers?.length && { stop: settings.customStopTriggers }),
    };
  }

  #format(settings) {
    if (settings.structuredOutput === "json_object") return "json";
    if (settings.structuredOutput === "json_schema" && settings.jsonSchema) return JSON.parse(settings.jsonSchema);
    return undefined;
  }

  async #stream(route, body, { pieceOf, onToken, signal }) {
    const started = performance.now();
    const response = await post(this.#fetch, `${this.#baseUrl}${route}`, body, signal ?? AbortSignal.timeout(300_000), undefined, "Ollama");
    let text = "";
    let last = {};
    let firstAt = null;
    for await (const event of ndjsonEvents(response.body)) {
      const piece = pieceOf(event) ?? "";
      if (piece) {
        firstAt ??= performance.now();
        text += piece;
        onToken?.(piece);
      }
      if (event.done) last = event;
    }
    return {
      text,
      stopReason: last.done_reason === "length" ? "maxTokens" : "eogToken",
      promptTokens: last.prompt_eval_count ?? null,
      outputTokens: last.eval_count ?? null,
      tokensPerSecond: last.eval_duration > 0 ? Number((last.eval_count / (last.eval_duration / 1e9)).toFixed(2)) : null,
      firstTokenMs: last.prompt_eval_duration > 0 ? Math.round(last.prompt_eval_duration / 1e6) : firstAt === null ? null : Math.round(firstAt - started),
    };
  }

  generate({ messages, settings, signal, onToken }) {
    return this.#stream("/api/chat", { model: this.#tag, messages, stream: true, keep_alive: "10m", options: this.#options_(settings), format: this.#format(settings) }, { pieceOf: (event) => event.message?.content, onToken, signal });
  }

  complete({ prompt, settings, signal, onToken }) {
    return this.#stream("/api/generate", { model: this.#tag, prompt, raw: true, stream: true, keep_alive: "10m", options: this.#options_(settings), format: this.#format(settings) }, { pieceOf: (event) => event.response, onToken, signal });
  }

  async stop() {
    // Ollama keeps the model for its keep_alive; it is not ours to stop.
    this.#tag = null;
  }
}

/** "name=http://host:8000/v1#model": an OpenAI-compatible server to attach, with an optional model id. */
export function parseOpenAiSpec(text) {
  const match = /^([A-Za-z0-9_.-]+)=(https?:\/\/[^#\s]+)(?:#(.+))?$/.exec(String(text ?? "").trim());
  if (!match) {
    throw new AppError("Bad engine address", { code: "bad_option", why: `"${text}" is not name=url.`, fix: "Use name=http://127.0.0.1:8000/v1, optionally followed by #model-id." });
  }
  return { name: match[1], baseUrl: match[2].replace(/\/+$/, ""), model: match[3] ?? null };
}

/**
 * Any server that speaks the OpenAI chat API (vLLM, SGLang, TGI, mistral.rs,
 * koboldcpp, LocalAI, llamafile, LM Studio...). The server was started by
 * someone else with its own settings, so a load only checks it answers and
 * picks the model; context, threads and GPU are whatever it was launched with.
 * Speed is read from the stream: the first content token and the usage total.
 */
export class OpenAICompatBackend {
  #baseUrl;
  #model;
  #apiKey;
  #fetch;
  #tag = null;

  constructor({ baseUrl, model = null, apiKey = null, fetchImpl = globalThis.fetch }) {
    this.#baseUrl = baseUrl;
    this.#model = model;
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
  }

  #headers() {
    return { "content-type": "application/json", ...(this.#apiKey && { authorization: `Bearer ${this.#apiKey}` }) };
  }

  unsupported(settings) {
    const reasons = [];
    if (settings.responsePrefix) reasons.push("responsePrefix (the chat API cannot force a reply to start with given text)");
    if (settings.penalizeNewLine === false) reasons.push("penalizeNewLine off (the OpenAI API has no such switch)");
    return reasons;
  }

  async start({ entry }) {
    let body;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/models`, { headers: this.#headers(), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw refusal("The engine is not reachable", "engine_start_failed", `${this.#baseUrl}/models did not answer (${error.message}).`, "Start the server, or check the address you gave to --openai-engine.");
    }
    const ids = (body.data ?? []).map((model) => model.id);
    const stem = String(entry.fileName ?? "").toLowerCase().replace(/\.gguf$/, "").replace(/[-_.:/]/g, "");
    this.#tag = this.#model ?? ids.find((id) => stem.includes(id.toLowerCase().replace(/[-_.:/]/g, ""))) ?? (ids.length === 1 ? ids[0] : null);
    if (!this.#tag) throw refusal("The engine serves other models", "engine_start_failed", `It lists ${ids.length} models and none matches ${entry.fileName}.`, "Name the model: --openai-engine name=url#model-id.");
  }

  async generate({ messages, settings, signal, onToken }) {
    const started = performance.now();
    const response = await post(this.#fetch, `${this.#baseUrl}/chat/completions`, { model: this.#tag, messages, stream: true, stream_options: { include_usage: true }, ...openAiFields(settings, { vllmNames: true }) }, signal, this.#headers());
    return readOpenAiStream(response, { pieceOf: chatPiece, onToken, started });
  }

  async complete({ prompt, settings, signal, onToken }) {
    const started = performance.now();
    const response = await post(this.#fetch, `${this.#baseUrl}/completions`, { model: this.#tag, prompt, stream: true, stream_options: { include_usage: true }, ...openAiFields(settings, { vllmNames: true }) }, signal, this.#headers());
    return readOpenAiStream(response, { pieceOf: textPiece, onToken, started });
  }

  async stop() {
    // Not ours to stop: someone else started this server.
    this.#tag = null;
  }
}

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

  /** One request: tracked for abort and for `busy`, and a cancel returns what was produced so far, as the in-process engine does. */
  async #run(conversationId, signal, work) {
    const controller = new AbortController();
    const merged = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    this.#active.set(conversationId, controller);
    this.#running += 1;
    const started = Date.now();
    let text = "";
    try {
      const result = await work(merged, (piece) => { text += piece; });
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

/**
 * One engine that is in-process by default and external when a load names
 * `engine` (ADR-156). `external` holds ready engines; `resolve(id)` may build
 * one on demand. Switching engines unloads the one that was running, so two
 * never hold the model. With `fallback`, an external engine that cannot start
 * is replaced by the in-process one and the status says so (the app's choice:
 * a saved profile must never leave the user without a model); without it the
 * failure is the result (the tuner's choice).
 */
export class RoutedEngine {
  #inProcess;
  #external;
  #resolve;
  #fallback;
  #current;
  #fellBack = null;

  constructor({ inProcess, external = {}, resolve = null, fallback = false }) {
    this.#inProcess = inProcess;
    this.#external = { ...external };
    this.#resolve = resolve;
    this.#fallback = fallback;
    this.#current = inProcess;
  }

  get #all() {
    return [this.#inProcess, ...Object.values(this.#external)];
  }

  #engineFor(id) {
    if (!id) return this.#inProcess;
    if (!this.#external[id] && this.#resolve) {
      const built = this.#resolve(id);
      if (built) this.#external[id] = built;
    }
    return this.#external[id] ?? null;
  }

  /** The id of the external engine that is running, or null for the in-process one. */
  get engineId() {
    return this.#current === this.#inProcess ? null : this.#current.engineId ?? null;
  }

  get loadedId() {
    return this.#current.loadedId;
  }

  get busy() {
    return this.#current.busy;
  }

  get phase() {
    return this.#current.phase;
  }

  startBackend(backend) {
    return this.#inProcess.startBackend(backend);
  }

  async status() {
    const status = await this.#current.status();
    return this.#fellBack ? { ...status, engineFallback: this.#fellBack } : status;
  }

  async load(options) {
    this.#fellBack = null;
    const wanted = this.#engineFor(options.engine);
    if (!wanted) {
      const why = `${options.engine} is not an engine this machine can use.`;
      if (!this.#fallback) throw refusal("Unknown engine", "engine_unknown", why, `Use one of: ${Object.keys(this.#external).join(", ") || "none configured"}.`, 400);
      return this.#loadInProcess(options, why);
    }
    if (wanted !== this.#current) await this.#current.unload().catch(() => {});
    this.#current = wanted;
    if (wanted === this.#inProcess) return wanted.load(options);
    try {
      return await wanted.load(options);
    } catch (error) {
      if (!this.#fallback) throw error;
      await wanted.unload().catch(() => {});
      return this.#loadInProcess(options, error.why ?? error.message);
    }
  }

  async #loadInProcess(options, reason) {
    const { engine, ...rest } = options;
    this.#current = this.#inProcess;
    this.#fellBack = { wanted: engine, reason };
    return this.#inProcess.load(rest);
  }

  reconfigure(options) {
    return this.#current.reconfigure(options);
  }

  chat(options) {
    return this.#current.chat(options);
  }

  complete(options) {
    return this.#current.complete(options);
  }

  abort(id) {
    return this.#current.abort?.(id) ?? false;
  }

  dropSession(id) {
    return this.#current.dropSession(id);
  }

  async unload() {
    for (const engine of this.#all) await engine.unload().catch(() => {});
    this.#fellBack = null;
  }

  teardown() {
    return this.#current.teardown();
  }

  async dispose() {
    for (const engine of this.#all) await engine.dispose().catch(() => {});
  }
}
