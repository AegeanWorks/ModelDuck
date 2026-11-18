import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { LlamaEngine } from "./engine.js";
import { cleanPath, locateBinary, parseLlamaVersion } from "./engine-env.js";
import { LlamaServerBackend, OpenAICompatBackend } from "./external-engines.js";

export { cleanPath, parseLlamaVersion };

/**
 * Inference engines the tuner can measure (ADR-155). Each adapter answers two
 * questions about one engine: `detect()` (is it usable here, and why not) and
 * `measure({ entry })` (prompt and generation tokens per second on one model
 * file). Every adapter takes its I/O as constructor arguments with a real
 * default, so tests never need the engine itself.
 */

const execFileAsync = promisify(execFile);

/** The fixed workload every engine is timed on: a prompt of about 256 tokens, 64 tokens out. */
export const WORKLOAD = Object.freeze({
  prompt: `${"The quick brown fox jumps over the lazy dog. ".repeat(24)}Continue the story:`,
  promptTokens: 256,
  genTokens: 64,
});

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
/** [lowest, highest] of the finite values, or null. */
const range = (values) => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? [round(Math.min(...finite)), round(Math.max(...finite))] : null;
};
const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);

/** The runtime that serves a backend and the backend it really started: { version, gpu }. */
async function describeNodeRuntime(backend) {
  const module = await import("node-llama-cpp");
  const llama = await module.getLlama({ gpu: backend === "cpu" ? false : backend, build: "never", progressLogs: false, logLevel: "error" });
  try {
    const release = llama.llamaCppRelease?.release;
    return { version: `node-llama-cpp ${await module.getModuleVersion()}${release ? `, llama.cpp ${release}` : ""}`, gpu: llama.gpu };
  } finally {
    await llama.dispose?.();
  }
}

/** node-llama-cpp inside this process, on one backend (cpu, vulkan, cuda or metal). */
export class NodeBackendAdapter {
  #backend;
  #createEngine;
  #describe;

  constructor({ backend, createEngine = (entry) => new LlamaEngine({ registry: { findById: () => entry } }), describe = describeNodeRuntime }) {
    this.#backend = backend;
    this.#createEngine = createEngine;
    this.#describe = describe;
  }

  get id() {
    return `node-llama-cpp:${this.#backend}`;
  }

  get label() {
    return `node-llama-cpp (${this.#backend})`;
  }

  async detect() {
    // A runtime that cannot say what it is never makes an engine unavailable; one that started a different backend does.
    const described = async () => {
      const info = await this.#describe(this.#backend).catch(() => null);
      return typeof info === "string" ? { version: info, gpu: undefined } : { version: info?.version ?? null, gpu: info?.gpu };
    };
    const started = (gpu) => (this.#backend === "cpu" ? gpu === undefined || gpu === false : gpu === undefined || gpu === this.#backend);
    if (this.#backend === "cpu") {
      const info = await described();
      return { available: started(info.gpu), reason: started(info.gpu) ? null : `asked for cpu but node-llama-cpp started ${info.gpu}`, version: info.version };
    }
    const engine = this.#createEngine({ id: "probe" });
    try {
      await engine.startBackend(this.#backend);
      const info = await described();
      if (!started(info.gpu)) {
        return { available: false, reason: `asked for ${this.#backend} but node-llama-cpp started ${info.gpu || "cpu"} instead; this build has no ${this.#backend} backend here.`, version: info.version };
      }
      return { available: true, reason: null, version: info.version };
    } catch (error) {
      return { available: false, reason: error?.why || error?.message || String(error), version: null };
    } finally {
      await engine.dispose?.().catch(() => {});
    }
  }

  async measure({ entry, runs = 3 }) {
    const engine = this.#createEngine(entry);
    try {
      const state = await engine.load({
        modelId: entry.id,
        gpuBackend: this.#backend,
        gpuLayers: this.#backend === "cpu" ? 0 : "max",
        contextSize: 4096,
      });
      if (this.#backend !== "cpu" && state.gpuBackend && state.gpuBackend !== this.#backend) {
        throw new Error(`ran on ${state.gpuBackend}, not ${this.#backend}; the result would not describe ${this.#backend}`);
      }
      const prompts = [];
      const gens = [];
      // The first run warms caches and kernels; it is asked but not counted.
      for (let run = 0; run <= runs; run += 1) {
        const result = await engine.complete({
          conversationId: `engine-speed-${run}`,
          prompt: WORKLOAD.prompt,
          settings: { maxTokens: WORKLOAD.genTokens, temperature: 0 },
          onToken: () => {},
        });
        if (run === 0) continue;
        const stats = result.stats ?? {};
        if (stats.firstTokenMs > 0 && stats.promptTokens > 0) prompts.push(stats.promptTokens / (stats.firstTokenMs / 1000));
        gens.push(Number(stats.tokensPerSecond));
      }
      return {
        promptTps: round(median(prompts)),
        genTps: round(median(gens)),
        genRange: range(gens),
        runs,
        detail: `${state.gpuBackend ?? "cpu"}, ${state.gpuLayers ?? 0} GPU layers`,
      };
    } finally {
      await engine.dispose?.().catch(() => {});
    }
  }
}

/** A run's output as text: a plain string, or the chosen stream(s) of { stdout, stderr }. */
function outputText(output, stream = "all") {
  if (typeof output === "string") return output;
  return stream === "stdout" ? output.stdout ?? "" : `${output.stdout ?? ""}
${output.stderr ?? ""}`;
}


/** A native llama.cpp build, measured with its own `llama-bench`. */
export class LlamaBenchAdapter {
  #binary;
  #run;
  #exists;

  constructor({
    binary = null,
    home = os.homedir(),
    platform = process.platform,
    exists = (file) => fs.existsSync(file),
    run = (file, args, timeoutMs) => execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PATH: cleanPath(process.env.PATH, platform) } }).then(({ stdout, stderr }) => ({ stdout, stderr })),
  } = {}) {
    const name = platform === "win32" ? "llama-bench.exe" : "llama-bench";
    this.#exists = exists;
    this.#run = run;
    this.#binary = locateBinary([binary, path.join(home, ".llama-bench", "build-release", "bin", name), path.join(home, ".llama-bench", "build", "bin", name)], exists);
  }

  get id() {
    return "llama-bench";
  }

  get label() {
    return "llama.cpp (native llama-bench)";
  }

  async detect() {
    if (!this.#binary) {
      return { available: false, reason: "llama-bench was not found (set --llama-bench <file>, or build llama.cpp into ~/.llama-bench/build-release).", version: null };
    }
    // The binary must start before the engine counts as available; its version comes from the same call.
    try {
      return { available: true, reason: null, version: parseLlamaVersion(outputText(await this.#run(this.#binary, ["--version"], 20_000))) };
    } catch (error) {
      return { available: false, reason: `${this.#binary} did not start (${error?.code ?? error?.message}); a DLL on PATH usually conflicts with it.`, version: null };
    }
  }

  async measure({ entry, runs = 3 }) {
    const stdout = outputText(await this.#run(this.#binary, ["-m", entry.path, "-p", String(WORKLOAD.promptTokens), "-n", String(WORKLOAD.genTokens), "-r", String(runs), "-o", "json"], 300_000), "stdout");
    const rows = JSON.parse(stdout.slice(stdout.indexOf("[")));
    const prompt = rows.find((row) => row.n_prompt > 0 && !(row.n_gen > 0));
    const gen = rows.find((row) => row.n_gen > 0);
    if (!prompt && !gen) throw new Error("llama-bench printed no timing rows");
    const first = rows[0] ?? {};
    return {
      promptTps: round(prompt?.avg_ts),
      genTps: round(gen?.avg_ts),
      runs,
      detail: `${first.backends ?? "unknown backend"} build ${first.build_commit ?? "unknown"}`,
      ...(first.build_commit && { version: `commit ${first.build_commit}` }),
    };
  }
}

const GPU_NAMES = Object.freeze({ vulkan: "vulkan", cuda: "cuda", metal: "metal" });

/** GPU backends named in `llama-server --list-devices` ("  Vulkan0: NVIDIA ..."), lower-cased. */
export function parseDevices(text) {
  const found = [...String(text ?? "").matchAll(/^\s+(Vulkan|CUDA|Metal)\w*:/gim)].map((match) => GPU_NAMES[match[1].toLowerCase()]);
  return [...new Set(found)];
}

/**
 * llama.cpp's own server, started on the model for the measurement and stopped
 * after. Unlike llama-bench it generates text, so the tuner can use it too.
 */
export class LlamaServerAdapter {
  #binary;
  #variant;
  #release;
  #run;
  #makeBackend;
  #gpu = null;

  /**
   * `variant` names the build (cpu, vulkan, cuda, metal) when it comes from an
   * install, so each variant is its own engine with its own speed. Without one
   * (a binary passed by hand) the build's own device list says what it can use.
   */
  constructor({
    binary = null,
    variant = null,
    release = null,
    platform = process.platform,
    run = (file, args, timeoutMs) => execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, PATH: cleanPath(process.env.PATH, platform) } }).then(({ stdout, stderr }) => ({ stdout, stderr })),
    makeBackend = (file) => new LlamaServerBackend({ binary: file }),
  } = {}) {
    this.#run = run;
    this.#makeBackend = makeBackend;
    this.#binary = binary;
    this.#variant = variant;
    this.#release = release;
  }

  get id() {
    return `llama-server${this.#variant ? `:${this.#variant}` : ""}`;
  }

  get label() {
    return `llama.cpp${this.#release ? ` ${this.#release}` : ""} llama-server${this.#variant ? ` (${this.#variant})` : ""}`;
  }

  async detect() {
    if (!this.#binary) {
      return { available: false, reason: "llama-server is not installed (run: npm run engines:install, or pass --llama-server <file>).", version: null };
    }
    try {
      const version = parseLlamaVersion(outputText(await this.#run(this.#binary, ["--version"], 20_000)));
      const devices = parseDevices(outputText(await this.#run(this.#binary, ["--list-devices"], 20_000)));
      const wanted = this.#variant ?? devices[0] ?? "cpu";
      // A GPU build on a machine without that GPU would quietly run on the CPU; say so instead.
      if (wanted !== "cpu" && !devices.includes(wanted)) {
        return { available: false, reason: `this build uses ${wanted} but ${this.#binary} found no ${wanted} device on this machine.`, version };
      }
      this.#gpu = wanted === "cpu" ? null : wanted;
      return { available: true, reason: null, version, backends: this.#variant ? [wanted] : ["cpu", ...devices], location: this.#binary };
    } catch (error) {
      return { available: false, reason: `${this.#binary} did not start (${error?.code ?? error?.message}); a DLL on PATH usually conflicts with it.`, version: null };
    }
  }

  async measure({ entry, runs = 3 }) {
    const backend = this.#makeBackend(this.#binary);
    const gpu = this.#gpu;
    try {
      await backend.start({ entry, load: { contextSize: 4096, threads: 8, batchSize: 512, sequences: 1, gpuBackend: gpu ?? "cpu", gpuLayers: gpu ? "max" : 0 } });
      const prompts = [];
      const gens = [];
      for (let run = 0; run <= runs; run += 1) {
        const result = await backend.generate({ messages: [{ role: "user", content: WORKLOAD.prompt }], settings: { maxTokens: WORKLOAD.genTokens, temperature: 0, seed: 1 } });
        if (run === 0) continue;
        if (result.firstTokenMs > 0 && result.promptTokens > 0) prompts.push(result.promptTokens / (result.firstTokenMs / 1000));
        gens.push(Number(result.tokensPerSecond));
      }
      return { promptTps: round(median(prompts)), genTps: round(median(gens)), genRange: range(gens), runs, detail: `${gpu ?? "cpu"}, served over HTTP` };
    } finally {
      await backend.stop();
    }
  }
}

/** A running Ollama server, measured through its own timing fields. */
export class OllamaAdapter {
  #baseUrl;
  #fetch;
  #model;

  constructor({ baseUrl = "http://127.0.0.1:11434", model = null, fetchImpl = globalThis.fetch } = {}) {
    this.#baseUrl = baseUrl;
    this.#model = model;
    this.#fetch = fetchImpl;
  }

  get id() {
    return "ollama";
  }

  get label() {
    return "Ollama";
  }

  async #json(route, init) {
    const response = await this.#fetch(`${this.#baseUrl}${route}`, { ...init, signal: AbortSignal.timeout(init?.timeoutMs ?? 2000) });
    if (!response.ok) throw new Error(`Ollama answered ${response.status} for ${route}`);
    return response.json();
  }

  async detect() {
    try {
      const { version } = await this.#json("/api/version");
      return { available: true, reason: null, version: version ?? null };
    } catch {
      return { available: false, reason: `No Ollama server answered at ${this.#baseUrl}.`, version: null };
    }
  }

  async measure({ entry, runs = 3 }) {
    const tag = this.#model ?? (await this.#matchingTag(entry));
    if (!tag) throw new Error(`Ollama has no model matching ${entry.fileName}; pass --ollama-model <tag> to name one.`);
    const prompts = [];
    const gens = [];
    // The first run loads the model into Ollama and is not counted.
    for (let run = 0; run <= runs; run += 1) {
      const body = await this.#json("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: tag, prompt: `${WORKLOAD.prompt} ${run}`, stream: false, options: { temperature: 0, num_predict: WORKLOAD.genTokens } }),
        timeoutMs: 300_000,
      });
      if (run === 0) continue;
      if (body.prompt_eval_duration > 0) prompts.push(body.prompt_eval_count / (body.prompt_eval_duration / 1e9));
      if (body.eval_duration > 0) gens.push(body.eval_count / (body.eval_duration / 1e9));
    }
    return { promptTps: round(median(prompts)), genTps: round(median(gens)), genRange: range(gens), runs, detail: `model ${tag}` };
  }

  /** A tag whose name shares the file's model stem (qwen2.5-0.5b-instruct-q4_k_m.gguf -> qwen2.5:0.5b). */
  async #matchingTag(entry) {
    const { models = [] } = await this.#json("/api/tags");
    const stem = String(entry.fileName ?? "").toLowerCase().replace(/\.gguf$/, "").replace(/[-_.:]/g, "");
    const found = models.find((model) => {
      const name = String(model.name ?? "").toLowerCase().replace(/[-_.:]/g, "");
      return name.length > 3 && stem.includes(name.split("latest")[0] || name);
    });
    return found?.name ?? null;
  }
}

/**
 * Any server that speaks the OpenAI chat API, attached by address: vLLM, SGLang,
 * TGI, mistral.rs, koboldcpp, LocalAI, llamafile, LM Studio. It is not started
 * or configured by ModelDuck, so what is measured is that server as launched.
 */
export class OpenAICompatAdapter {
  #spec;
  #apiKey;
  #fetch;
  #backend;

  constructor({ spec, apiKey = null, fetchImpl = globalThis.fetch }) {
    this.#spec = spec;
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#backend = new OpenAICompatBackend({ baseUrl: spec.baseUrl, model: spec.model, apiKey, fetchImpl });
  }

  get id() {
    return `openai:${this.#spec.name}`;
  }

  get label() {
    return `${this.#spec.name} (OpenAI API)`;
  }

  async detect() {
    const headers = this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
    try {
      const response = await this.#fetch(`${this.#spec.baseUrl}/models`, { headers, signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      return { available: false, reason: `${this.#spec.baseUrl}/models did not answer (${error.message}); is the server running?`, version: null };
    }
    // vLLM and others expose /version beside the API root; a server that does not is still usable.
    let version = null;
    try {
      const origin = new URL(this.#spec.baseUrl).origin;
      const response = await this.#fetch(`${origin}/version`, { headers, signal: AbortSignal.timeout(2000) });
      if (response.ok) version = (await response.json())?.version ?? null;
    } catch {
      version = null;
    }
    return { available: true, reason: null, version, backends: ["cpu"], location: this.#spec.baseUrl };
  }

  async measure({ entry, runs = 3 }) {
    await this.#backend.start({ entry });
    const prompts = [];
    const gens = [];
    // The first request warms the server's caches and is not counted.
    for (let run = 0; run <= runs; run += 1) {
      const result = await this.#backend.generate({ messages: [{ role: "user", content: `${WORKLOAD.prompt} ${run}` }], settings: { maxTokens: WORKLOAD.genTokens, temperature: 0, seed: 1 } });
      if (run === 0) continue;
      if (result.firstTokenMs > 0 && result.promptTokens > 0) prompts.push(result.promptTokens / (result.firstTokenMs / 1000));
      gens.push(Number(result.tokensPerSecond));
    }
    return { promptTps: round(median(prompts)), genTps: round(median(gens)), genRange: range(gens), runs, detail: "server settings as launched; prompt speed includes queueing" };
  }
}
