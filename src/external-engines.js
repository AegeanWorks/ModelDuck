import { spawn } from "node:child_process";
import net from "node:net";

import { AppError } from "./errors.js";
import { buildSystemPrompt } from "./generation-manifest.js";
import { cleanPath } from "./engine-env.js";
import { splitKvCache } from "./memory-fit.js";

/**
 * Engines outside this process, driven through the same interface the tuner's
 * evaluator uses on `LlamaEngine` (ADR-156): `load`, `reconfigure`, `status`,
 * `chat`, `dropSession`, `unload`. A `ServerEngine` owns the interface and maps
 * the result; a backend owns one server's protocol (`start`, `generate`,
 * `stop`). Backends: llama.cpp's `llama-server` (spawned per load) and a
 * running Ollama.
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

/** Sampling the evaluator sends, in the names both servers share. */
function sampling(settings) {
  return {
    temperature: settings.temperature,
    top_p: settings.topP,
    top_k: settings.topK,
    min_p: settings.minP,
    repeat_penalty: settings.repeatPenalty,
    seed: settings.seed,
  };
}

/** llama.cpp's llama-server, started for one load and stopped on the next. */
export class LlamaServerBackend {
  #binary;
  #spawn;
  #fetch;
  #startTimeoutMs;
  #child = null;
  #base = null;

  constructor({ binary, spawnImpl = spawn, fetchImpl = globalThis.fetch, startTimeoutMs = 120_000 }) {
    this.#binary = binary;
    this.#spawn = spawnImpl;
    this.#fetch = fetchImpl;
    this.#startTimeoutMs = startTimeoutMs;
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
    // A tune that dies must not leave a server holding the model.
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

  async generate({ messages, settings, signal }) {
    const response = await this.#fetch(`${this.#base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: settings.maxTokens, stream: false, cache_prompt: false, ...sampling(settings) }),
      signal,
    });
    if (!response.ok) throw refusal("llama-server refused the request", "engine_request_failed", `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`, "Check the prompt against the context size.");
    const body = await response.json();
    const choice = body.choices?.[0] ?? {};
    const timings = body.timings ?? {};
    return {
      text: choice.message?.content ?? "",
      stopReason: choice.finish_reason === "length" ? "maxTokens" : "eogToken",
      promptTokens: body.usage?.prompt_tokens ?? timings.prompt_n ?? null,
      outputTokens: body.usage?.completion_tokens ?? timings.predicted_n ?? null,
      tokensPerSecond: Number.isFinite(timings.predicted_per_second) ? Number(timings.predicted_per_second.toFixed(2)) : null,
      firstTokenMs: Number.isFinite(timings.prompt_ms) ? Math.round(timings.prompt_ms) : null,
    };
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

  async generate({ messages, settings, signal }) {
    const { temperature, top_p, top_k, min_p, repeat_penalty, seed } = sampling(settings);
    const body = await this.#json("/api/chat", {
      model: this.#tag,
      messages,
      stream: false,
      keep_alive: "10m",
      options: { ...this.#options, temperature, top_p, top_k, min_p, repeat_penalty, seed, num_predict: settings.maxTokens },
    }, signal);
    return {
      text: body.message?.content ?? "",
      stopReason: body.done_reason === "length" ? "maxTokens" : "eogToken",
      promptTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
      tokensPerSecond: body.eval_duration > 0 ? Number((body.eval_count / (body.eval_duration / 1e9)).toFixed(2)) : null,
      firstTokenMs: body.prompt_eval_duration > 0 ? Math.round(body.prompt_eval_duration / 1e6) : null,
    };
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

  async generate({ messages, settings, signal }) {
    const started = performance.now();
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        model: this.#tag, messages, stream: true, stream_options: { include_usage: true },
        max_tokens: settings.maxTokens, temperature: settings.temperature, top_p: settings.topP, seed: settings.seed,
        top_k: settings.topK, min_p: settings.minP, repetition_penalty: settings.repeatPenalty, repeat_penalty: settings.repeatPenalty,
      }),
      signal,
    });
    if (!response.ok) throw refusal("The engine refused the request", "engine_request_failed", `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`, "Check the model name and the prompt length against the server's context.");
    let text = "";
    let finish = null;
    let usage = null;
    let firstAt = null;
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = pending.indexOf("\n\n")) !== -1) {
        const event = pending.slice(0, cut);
        pending = pending.slice(cut + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        const piece = choice?.delta?.content ?? "";
        if (piece) {
          firstAt ??= performance.now();
          text += piece;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (parsed.usage) usage = parsed.usage;
      }
    }
    const endedAt = performance.now();
    const outputTokens = usage?.completion_tokens ?? null;
    const decodeMs = firstAt === null ? 0 : endedAt - firstAt;
    return {
      text,
      stopReason: finish === "length" ? "maxTokens" : "eogToken",
      promptTokens: usage?.prompt_tokens ?? null,
      outputTokens,
      tokensPerSecond: outputTokens > 1 && decodeMs > 0 ? Number(((outputTokens - 1) / (decodeMs / 1000)).toFixed(2)) : null,
      firstTokenMs: firstAt === null ? null : Math.round(firstAt - started),
    };
  }

  async stop() {
    // Not ours to stop: someone else started this server.
    this.#tag = null;
  }
}

/** The evaluator's engine interface over one backend. */
export class ServerEngine {
  #registry;
  #backend;
  #id;
  #state = { status: "idle", model: null };
  #entry = null;
  #load = null;

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
    return false;
  }

  get phase() {
    return this.#state.status;
  }

  async startBackend() {}

  async status() {
    return { ...this.#state, phase: this.phase, memory: null };
  }

  async load(options) {
    const entry = this.#registry.findById(options.modelId);
    if (!entry) throw refusal("Model not found", "model_not_found", "That model is no longer in the library.", "Choose an installed model.", 404);
    this.#state = { status: "loading", model: { id: entry.id, name: entry.name, fileName: entry.fileName } };
    try {
      await this.#backend.start({ entry, load: options });
    } catch (error) {
      this.#state = { status: "error", model: this.#state.model, error: error.message };
      throw error;
    }
    this.#entry = entry;
    this.#load = options;
    this.#state = { status: "ready", model: { id: entry.id, name: entry.name, fileName: entry.fileName }, contextSize: options.contextSize, gpuBackend: options.gpuBackend ?? "cpu" };
    return { ...this.#state };
  }

  /** A server cannot rebuild its context in place, so a context-level change restarts it. */
  async reconfigure(options) {
    if (!this.#entry) throw refusal("No model is loaded", "model_not_loaded", `${this.#id} has no model loaded.`, "Load a model first.", 409);
    return this.load({ ...this.#load, ...options, modelId: this.#entry.id });
  }

  async chat({ messages, systemPrompt, settings = {}, signal }) {
    if (this.#state.status !== "ready") throw refusal("No model is loaded", "model_not_loaded", `${this.#id} has no model loaded.`, "Load a model first.", 409);
    const started = Date.now();
    const result = await this.#backend.generate({ messages: conversation(systemPrompt, messages, settings.reasoning), settings, signal });
    const ms = Date.now() - started;
    return {
      text: result.text,
      stats: { ms, tokensPerSecond: result.tokensPerSecond, outputTokens: result.outputTokens, stopReason: result.stopReason, promptTokens: result.promptTokens, firstTokenMs: result.firstTokenMs },
    };
  }

  dropSession() {}

  async unload() {
    await this.#backend.stop();
    this.#entry = null;
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
 * One engine for the tuner that is in-process by default and external when a
 * load names `engine` (the id of a registered external engine). Switching
 * engines unloads the one that was running, so two never hold the model.
 */
export class RoutedEngine {
  #inProcess;
  #external;
  #current;

  constructor({ inProcess, external = {} }) {
    this.#inProcess = inProcess;
    this.#external = external;
    this.#current = inProcess;
  }

  get #all() {
    return [this.#inProcess, ...Object.values(this.#external)];
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

  status() {
    return this.#current.status();
  }

  async load(options) {
    const wanted = options.engine ? this.#external[options.engine] : this.#inProcess;
    if (!wanted) throw refusal("Unknown engine", "engine_unknown", `${options.engine} is not an engine this tune can use.`, `Use one of: ${Object.keys(this.#external).join(", ") || "none configured"}.`, 400);
    if (wanted !== this.#current) await this.#current.unload().catch(() => {});
    this.#current = wanted;
    return wanted.load(options);
  }

  reconfigure(options) {
    return this.#current.reconfigure(options);
  }

  chat(options) {
    return this.#current.chat(options);
  }

  dropSession(id) {
    return this.#current.dropSession(id);
  }

  async unload() {
    for (const engine of this.#all) await engine.unload().catch(() => {});
  }

  teardown() {
    return this.#current.teardown();
  }

  async dispose() {
    for (const engine of this.#all) await engine.dispose().catch(() => {});
  }
}
