import os from "node:os";
import path from "node:path";

import { AppError } from "./errors.js";

export const APP_NAME = "ModelDuck";
export const VERSION = "0.1.0";
export const DEFAULT_PORT = 4141;

export const DEFAULT_SYSTEM_PROMPT =
  "You are ModelDuck, a helpful local AI assistant. Be clear, accurate, and concise. " +
  "If you are unsure, say so instead of inventing an answer.";

export function defaultThreads() {
  const cores =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, cores - 1);
}

export const DEFAULT_SETTINGS = Object.freeze({
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  repeatPenaltyTokens: 64,
  penalizeNewLine: true,
  dryStrength: 0,
  dryBase: 1.75,
  dryAllowedLength: 4,
  responsePrefix: "",
  customStopTriggers: [],
  maxTokens: 512,
  promptRepeat: 1,
  seed: -1,
  contextSize: 16384,
  contextOverflow: "shift",
  reasoning: "off",
  structuredOutput: "none",
  jsonSchema: "",
  threads: defaultThreads(),
  maxThreads: defaultThreads(),
  batchSize: 512,
  sequences: 1,
  flashAttention: "auto",
  useMmap: "auto",
  gpuLayers: 0,
  gpuBackend: "cpu",
  checkpoints: true,
  checkpointInterval: 8192,
  checkpointMax: 32,
  checkpointMemoryMb: 64,
  kvCache: "f16",
  useTunedProfile: true,
  speedPreset: "fastest",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
});

/**
 * IDEA-1627: determinism lockdown for repro comparisons. Batch 512 stays the
 * speed default above; repro work uses batch 1 with each comparison run three
 * times, and a comparison only stands when the triple-run spread is within the
 * noise floor. Bench-only and default off: `withDeterminismLockdown` opts a
 * settings object in without touching the fast defaults.
 */
export const DETERMINISM_LOCKDOWN = Object.freeze({
  batchSize: 1,
  runs: 3,
  maxSpreadPct: 5,
  enabled: false,
});

/** Bench-only repro settings: batch 1 with the determinism flag set. */
export function withDeterminismLockdown(settings = {}) {
  return { ...settings, batchSize: DETERMINISM_LOCKDOWN.batchSize, deterministicRepro: true };
}

/**
 * True when a settings object explicitly opts into the batch-1 repro path.
 * A bare batchSize of 1 is a mistyped fast setting, not an opt-in, so the
 * flag alone decides.
 */
export function isDeterministicRepro(settings = {}) {
  return settings?.deterministicRepro === true;
}

export const SETTING_PRESETS = Object.freeze({
  token_saver: Object.freeze({
    id: "token_saver",
    label: "Token saver",
    description: "Lightest memory: small batch with the Q8 KV cache. Q4 KV saved little more memory but measured a large quality drop on Qwen2.5 0.5B.",
    settings: Object.freeze({
      batchSize: 128,
      maxTokens: 256,
      topK: 20,
      minP: 0.1,
      repeatPenalty: 1.05,
      reasoning: "off",
      kvCache: "q8_0",
      flashAttention: "on",
      useMmap: "auto",
      checkpoints: false,
      sequences: 1,
      gpuLayers: 0,
    }),
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "Balanced",
    description: "Q8 KV cache and a 512-token budget: a good default for CPU chat.",
    settings: Object.freeze({
      batchSize: 512,
      maxTokens: 512,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      reasoning: "auto",
      kvCache: "q8_0",
      flashAttention: "on",
      useMmap: "auto",
      checkpoints: true,
      sequences: 1,
      gpuLayers: 0,
    }),
  }),
  quality: Object.freeze({
    id: "quality",
    label: "Quality first",
    description: "F16 KV cache, full mmap load and a 1024-token budget.",
    settings: Object.freeze({
      batchSize: 1024,
      maxTokens: 1024,
      topK: 60,
      minP: 0.03,
      repeatPenalty: 1.15,
      reasoning: "deep",
      kvCache: "f16",
      flashAttention: "on",
      useMmap: "off",
      checkpoints: true,
      sequences: 1,
      gpuLayers: 0,
    }),
  }),
  cheap: Object.freeze({
    id: "cheap",
    label: "Cheap",
    description:
      "Temperature-as-cost: low temperature (0.2) with truncated top-p (0.8) and min-p 0.1 per tuner v8 sampler profiles; small batch keeps it fast.",
    settings: Object.freeze({
      batchSize: 128,
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      minP: 0.1,
      repeatPenalty: 1.05,
      reasoning: "off",
      kvCache: "q8_0",
      flashAttention: "on",
      useMmap: "auto",
      checkpoints: false,
      sequences: 1,
      gpuLayers: 0,
    }),
  }),
});

export function settingPresets() {
  return Object.values(SETTING_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    settings: { ...preset.settings },
  }));
}

export function applyPreset(name, current = {}) {
  const preset = SETTING_PRESETS[name];
  if (!preset) {
    throw new AppError("Unknown preset", {
      code: "preset_not_found",
      why: `There is no preset named ${name}.`,
      fix: "Choose token_saver, balanced, quality or cheap.",
    });
  }
  return normalizeSettings({
    ...current,
    ...preset.settings,
    systemPrompt: current.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
  });
}

const KV_CACHE_TYPES = new Set(["f16", "q8_0", "q4_0", "q8_0:q4_0"]);
const FLASH_ATTENTION_TYPES = new Set(["auto", "on", "off"]);
const USE_MMAP_TYPES = new Set(["auto", "on", "off"]);
const REASONING_TYPES = new Set(["off", "auto", "deep"]);
const STRUCTURED_OUTPUT_TYPES = new Set(["none", "json_object", "json_schema"]);
const CONTEXT_OVERFLOW_TYPES = new Set(["shift", "strict", "truncate"]);
const GPU_BACKENDS = new Set(["cpu", "auto", "cuda", "vulkan", "metal"]);

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function normalizeGpuLayers(value) {
  if (value === "auto" || value === "max") return value;
  return clampInteger(value, 0, 200, 0);
}

// Stop lists clamp like numbers do: junk entries are dropped and the list is
// capped at four, but a list that is already clean is kept as is — so a fifth
// user stop can no longer wipe the tuned fence stop, and every value the tuner
// can choose still survives normalisation unchanged.
function normalizeStops(value) {
  if (!Array.isArray(value)) return [...DEFAULT_SETTINGS.customStopTriggers];
  const kept = value.filter((stop) => typeof stop === "string" && stop.length > 0);
  if (kept.length === value.length && kept.length <= 4) return [...value];
  return kept.slice(0, 4);
}

function normalizeBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["false", "0", "no", "off", ""].includes(lowered)) return false;
    if (["true", "1", "yes", "on"].includes(lowered)) return true;
    return fallback;
  }
  return Boolean(value);
}

export function normalizeSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const kvCache = String(source.kvCache ?? "f16").toLowerCase();
  const flashAttention = String(source.flashAttention ?? "auto").toLowerCase();
  const useMmap = String(source.useMmap ?? "auto").toLowerCase();
  // IDEA-1627: the repro flag survives normalization, and only then is batch
  // 1 legal. Every other path keeps the 32 floor so the app never silently
  // runs a slow repro batch.
  const deterministicRepro = source.deterministicRepro === true;
  return {
    temperature: clampNumber(source.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    topP: clampNumber(source.topP, 0.05, 1, DEFAULT_SETTINGS.topP),
    topK: clampInteger(source.topK, 0, 200, DEFAULT_SETTINGS.topK),
    minP: clampNumber(source.minP, 0, 1, DEFAULT_SETTINGS.minP),
    repeatPenalty: clampNumber(source.repeatPenalty, 1, 2, DEFAULT_SETTINGS.repeatPenalty),
    repeatPenaltyTokens: clampInteger(
      source.repeatPenaltyTokens,
      1,
      1024,
      DEFAULT_SETTINGS.repeatPenaltyTokens,
    ),
    penalizeNewLine: source.penalizeNewLine === undefined ? true : normalizeBoolean(source.penalizeNewLine, true),
    dryStrength: clampNumber(source.dryStrength, 0, 1, DEFAULT_SETTINGS.dryStrength),
    dryBase: (() => {
      const coerced = Number(source.dryBase);
      return Number.isFinite(coerced) && coerced > 0 ? coerced : DEFAULT_SETTINGS.dryBase;
    })(),
    dryAllowedLength: clampInteger(source.dryAllowedLength, 1, 32, DEFAULT_SETTINGS.dryAllowedLength),
    responsePrefix: typeof source.responsePrefix === "string" ? source.responsePrefix.slice(0, 200) : DEFAULT_SETTINGS.responsePrefix,
    customStopTriggers: normalizeStops(source.customStopTriggers),
    maxTokens: clampInteger(source.maxTokens, 16, 8192, DEFAULT_SETTINGS.maxTokens), // aikit:allow-secret token limit
    promptRepeat: clampInteger(source.promptRepeat, 1, 3, DEFAULT_SETTINGS.promptRepeat),
    seed: clampInteger(source.seed, -1, 2147483647, DEFAULT_SETTINGS.seed),
    contextSize: clampInteger(source.contextSize, 16384, 32768, DEFAULT_SETTINGS.contextSize),
    contextOverflow: CONTEXT_OVERFLOW_TYPES.has(String(source.contextOverflow ?? "shift"))
      ? String(source.contextOverflow ?? "shift")
      : DEFAULT_SETTINGS.contextOverflow,
    reasoning: REASONING_TYPES.has(String(source.reasoning ?? DEFAULT_SETTINGS.reasoning))
      ? String(source.reasoning ?? DEFAULT_SETTINGS.reasoning)
      : DEFAULT_SETTINGS.reasoning,
    structuredOutput: STRUCTURED_OUTPUT_TYPES.has(String(source.structuredOutput ?? "none"))
      ? String(source.structuredOutput ?? "none")
      : DEFAULT_SETTINGS.structuredOutput,
    jsonSchema: typeof source.jsonSchema === "string" ? source.jsonSchema.slice(0, 12000) : "",
    threads: clampInteger(source.threads, 1, 64, DEFAULT_SETTINGS.threads),
    maxThreads: clampInteger(source.maxThreads, 1, 64, DEFAULT_SETTINGS.maxThreads),
    batchSize: clampInteger(source.batchSize, deterministicRepro ? 1 : 32, 8192, DEFAULT_SETTINGS.batchSize),
    deterministicRepro,
    sequences: clampInteger(source.sequences, 1, 8, DEFAULT_SETTINGS.sequences),
    flashAttention: FLASH_ATTENTION_TYPES.has(flashAttention)
      ? flashAttention
      : DEFAULT_SETTINGS.flashAttention,
    useMmap: USE_MMAP_TYPES.has(useMmap) ? useMmap : DEFAULT_SETTINGS.useMmap,
    gpuLayers: normalizeGpuLayers(source.gpuLayers),
    gpuBackend: GPU_BACKENDS.has(String(source.gpuBackend ?? "cpu"))
      ? String(source.gpuBackend ?? "cpu")
      : DEFAULT_SETTINGS.gpuBackend,
    checkpoints: source.checkpoints === undefined ? true : normalizeBoolean(source.checkpoints, true),
    checkpointInterval: clampInteger(
      source.checkpointInterval,
      128,
      32768,
      DEFAULT_SETTINGS.checkpointInterval,
    ),
    checkpointMax: clampInteger(source.checkpointMax, 1, 64, DEFAULT_SETTINGS.checkpointMax),
    // IDEA-1087: 0 = unlimited checkpoint memory, capped at 256 MiB.
    checkpointMemoryMb: clampInteger(
      source.checkpointMemoryMb,
      0,
      256,
      DEFAULT_SETTINGS.checkpointMemoryMb,
    ),
    kvCache: KV_CACHE_TYPES.has(kvCache) ? kvCache : DEFAULT_SETTINGS.kvCache,
    useTunedProfile: source.useTunedProfile === undefined ? true : normalizeBoolean(source.useTunedProfile, true),
    speedPreset: ["fastest", "light", "quiet"].includes(source.speedPreset) ? source.speedPreset : "fastest",
    systemPrompt:
      typeof source.systemPrompt === "string"
        ? source.systemPrompt.slice(0, 8000)
        : DEFAULT_SETTINGS.systemPrompt,
  };
}

export function resolvePaths({ home, models, env = process.env } = {}) {
  const resolvedHome = path.resolve(
    home || env.MODELDUCK_HOME || path.join(os.homedir(), ".modelduck"),
  );
  const resolvedModels = path.resolve(
    models || env.MODELDUCK_MODELS || path.join(resolvedHome, "models"),
  );
  return {
    home: resolvedHome,
    models: resolvedModels,
    downloads: path.join(resolvedHome, "downloads"),
    settings: path.join(resolvedHome, "settings.json"),
    serverSettings: path.join(resolvedHome, "server-settings.json"),
    profiles: path.join(resolvedHome, "profiles"),
    tuneRuns: path.join(resolvedHome, "tune-runs"),
    tuneGrid: path.join(resolvedHome, "tune-grid.json"),
    lock: path.join(resolvedHome, ".lock"),
  };
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new AppError(`Missing value for ${name}`, {
      code: "cli_missing_value",
      why: `${name} needs a value.`,
      fix: `Run "node src/main.js ${name} <value>".`,
    });
  }
  return value;
}

export function parseArgs(argv = [], env = process.env) {
  const envPort = env.MODELDUCK_PORT === undefined ? DEFAULT_PORT : Number(env.MODELDUCK_PORT);
  if (!Number.isInteger(envPort) || envPort < 0 || envPort > 65535) {
    throw new AppError(`Invalid MODELDUCK_PORT: ${env.MODELDUCK_PORT}`, {
      code: "cli_invalid_port",
      why: "MODELDUCK_PORT must be a whole number between 0 and 65535.",
      fix: "Unset it, or set it to a port such as 4141.",
    });
  }
  const options = {
    port: envPort,
    portExplicit: env.MODELDUCK_PORT !== undefined,
    host: env.MODELDUCK_HOST || "127.0.0.1",
    hostExplicit: env.MODELDUCK_HOST !== undefined,
    open: env.MODELDUCK_NO_OPEN !== "1",
    home: env.MODELDUCK_HOME || null,
    models: env.MODELDUCK_MODELS || null,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inline] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const take = () => inline ?? readOption(argv, index++, flag);
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--port": {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          throw new AppError(`Invalid port: ${value}`, {
            code: "cli_invalid_port",
            why: "A port must be a whole number between 0 and 65535.",
            fix: "Use a port such as 4141, or 0 to let the operating system choose one.",
          });
        }
        options.port = value;
        options.portExplicit = true;
        break;
      }
      case "--host":
        options.host = take();
        options.hostExplicit = true;
        break;
      case "--home":
        options.home = take();
        break;
      case "--models":
        options.models = take();
        break;
      default:
        throw new AppError(`Unknown option: ${flag}`, {
          code: "cli_unknown_option",
          why: "ModelDuck does not recognise this command-line option.",
          fix: 'Run "node src/main.js --help" to see the supported options.',
        });
    }
  }

  return options;
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
