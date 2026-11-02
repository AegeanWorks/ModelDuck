import { getCatalogModel } from "../src/model-catalog.js";
import { SETTING_PRESETS } from "../src/config.js";
import { BENCHMARK_MODELS, SMOKE_PROMPT_IDS } from "./suite.mjs";

const BASE = new Map(BENCHMARK_MODELS.map((model) => [model.catalogId, model]));

function modelFor(catalogId) {
  const catalog = getCatalogModel(catalogId);
  if (!catalog) throw new Error(`Unknown benchmark model ${catalogId}`);
  return catalog;
}

function variant(
  id,
  catalogId,
  {
    family,
    kvCache = "f16",
    contextSize = 2048,
    threads = 8,
    maxThreads = 8,
    batchSize = 512,
    sequences = 1,
    flashAttention = "auto",
    useMmap = "auto",
    gpuLayers = 0,
    checkpoints = true,
    checkpointInterval = 8192,
    checkpointMax = 32,
    preset = null,
    temperature = 0,
    topP = 1,
    topK = 40,
    minP = 0.05,
    repeatPenalty = 1.1,
    promptRepeat = 1,
    reasoning = "off",
    structuredOutput = "none",
    jsonSchema = "",
    seed = 42,
    systemPrompt = null,
    promptIds = null,
  } = {},
) {
  const catalog = modelFor(catalogId);
  const base = BASE.get(catalogId);
  const labelParts = [
    catalog.name.replace(/ · .*$/, ""),
    catalog.quant,
    preset ? `preset ${preset}` : null,
    `KV ${kvCache.toUpperCase()}`,
    `${contextSize} ctx`,
    `batch ${batchSize}`,
    `seq ${sequences}`,
    threads !== 8 ? `${threads} threads` : null,
    maxThreads !== 8 ? `pool ${maxThreads}` : null,
    flashAttention !== "auto" ? `flash ${flashAttention}` : null,
    useMmap !== "auto" ? `mmap ${useMmap}` : null,
    gpuLayers ? `gpu ${gpuLayers}` : null,
    checkpoints ? null : "no checkpoints",
    checkpointInterval !== 8192 ? `ckpt every ${checkpointInterval}` : null,
    checkpointMax !== 32 ? `ckpt max ${checkpointMax}` : null,
  ].filter(Boolean);
  return {
    id,
    catalogId,
    family: family ?? base?.catalogId ?? catalogId,
    fileName: catalog.file,
    aliases: base?.aliases ?? [],
    label: labelParts.join(" · "),
    kind: base?.kind ?? "general",
    quant: catalog.quant,
    preset,
    kvCache,
    contextSize,
    threads,
    maxThreads,
    batchSize,
    sequences,
    flashAttention,
    useMmap,
    gpuLayers,
    checkpoints,
    checkpointInterval,
    checkpointMax,
    temperature,
    topP,
    topK,
    minP,
    repeatPenalty,
    promptRepeat,
    reasoning,
    structuredOutput,
    jsonSchema,
    seed,
    systemPrompt,
    promptIds,
  };
}

/**
 * The benchmark matrix. It runs every base model once, then applies each
 * inference setting to representative model sizes instead of exploding into
 * a full cartesian product that would take hours on a CPU.
 */
export const BENCHMARK_MATRIX = [
  variant("smollm-135m-q4-f16", "smollm2-135m-instruct-q4"),
  variant("qwen-0.5b-q4-f16", "qwen2.5-0.5b-instruct-q4"),
  variant("qwen-1.5b-q4-f16", "qwen2.5-1.5b-instruct-q4"),
  variant("coder-1.5b-q4-f16", "qwen2.5-coder-1.5b-instruct-q4"),
  variant("llama-3b-q4-f16", "llama-3.2-3b-instruct-q4"),
  variant("phi-3.8b-q4-f16", "phi-3.5-mini-instruct-q4"),

  variant("qwen-0.5b-q4-kv8", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    kvCache: "q8_0",
  }),
  variant("qwen-0.5b-q4-kv4", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    kvCache: "q4_0",
  }),
  variant("llama-3b-q4-kv8", "llama-3.2-3b-instruct-q4", {
    family: "llama-3.2-3b-instruct",
    kvCache: "q8_0",
  }),
  variant("llama-3b-q4-kv4", "llama-3.2-3b-instruct-q4", {
    family: "llama-3.2-3b-instruct",
    kvCache: "q4_0",
  }),
  variant("phi-3.8b-q4-kv8", "phi-3.5-mini-instruct-q4", {
    family: "phi-3.5-mini-instruct",
    kvCache: "q8_0",
  }),
  variant("phi-3.8b-q4-kv4", "phi-3.5-mini-instruct-q4", {
    family: "phi-3.5-mini-instruct",
    kvCache: "q4_0",
  }),

  variant("qwen-0.5b-q5-f16", "qwen2.5-0.5b-instruct-q5", {
    family: "qwen2.5-0.5b-instruct",
  }),
  variant("qwen-0.5b-q8-f16", "qwen2.5-0.5b-instruct-q8", {
    family: "qwen2.5-0.5b-instruct",
  }),
  variant("qwen-0.5b-q8-kv8", "qwen2.5-0.5b-instruct-q8", {
    family: "qwen2.5-0.5b-instruct",
    kvCache: "q8_0",
  }),
  variant("qwen-0.5b-q5-kv8", "qwen2.5-0.5b-instruct-q5", {
    family: "qwen2.5-0.5b-instruct",
    kvCache: "q8_0",
  }),

  variant("qwen-0.5b-q4-f16-4k", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    contextSize: 4096,
  }),
  variant("qwen-0.5b-q4-f16-4threads", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    threads: 4,
  }),
  variant("qwen-0.5b-q4-f16-16threads", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    threads: 16,
  }),
  variant("qwen-0.5b-q4-f16-8k", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    contextSize: 8192,
  }),
  variant("qwen-0.5b-q4-f16-16k", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    contextSize: 16384,
  }),
  variant("qwen-0.5b-q4-batch128", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    batchSize: 128,
  }),
  variant("qwen-0.5b-q4-batch256", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    batchSize: 256,
  }),
  variant("qwen-0.5b-q4-batch1024", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    batchSize: 1024,
  }),
  variant("qwen-0.5b-q4-batch2048", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    batchSize: 2048,
  }),
  variant("qwen-0.5b-q4-batch4096-8k", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    batchSize: 4096,
    contextSize: 8192,
  }),
  variant("qwen-0.5b-q4-pool4", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    maxThreads: 4,
  }),
  variant("qwen-0.5b-q4-pool16", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    maxThreads: 16,
  }),
  variant("qwen-0.5b-q4-seq2", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    sequences: 2,
  }),
  variant("qwen-0.5b-q4-seq4", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    sequences: 4,
  }),
  variant("qwen-0.5b-q4-flash-on", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    flashAttention: "on",
  }),
  variant("qwen-0.5b-q4-flash-off", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    flashAttention: "off",
  }),
  variant("qwen-0.5b-q4-mmap-on", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    useMmap: "on",
  }),
  variant("qwen-0.5b-q4-mmap-off", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    useMmap: "off",
  }),
  variant("qwen-0.5b-q4-no-checkpoints", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    checkpoints: false,
  }),
  variant("qwen-0.5b-q4-ckpt-512", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    checkpointInterval: 512,
  }),
  variant("qwen-0.5b-q4-ckpt-2048", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    checkpointInterval: 2048,
  }),
  variant("qwen-0.5b-q4-ckpt-max4", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    checkpointInterval: 512,
    checkpointMax: 4,
  }),
  variant("qwen-0.5b-q4-gpu1", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    gpuLayers: 1,
  }),
  variant("preset-token-saver", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    preset: "token_saver",
    ...SETTING_PRESETS.token_saver.settings,
  }),
  variant("preset-balanced", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    preset: "balanced",
    ...SETTING_PRESETS.balanced.settings,
  }),
  variant("preset-quality", "qwen2.5-0.5b-instruct-q4", {
    family: "qwen2.5-0.5b-instruct",
    preset: "quality",
    ...SETTING_PRESETS.quality.settings,
  }),
];

/**
 * Variants that only change speed or memory (threads, batch, pool, sequences,
 * context size, mmap, checkpoints, GPU layers) run the cross-family smoke subset;
 * model, quantization, KV cache, flash attention and presets run the full suite.
 */
const SPEED_ONLY = /-(4threads|16threads|4k|8k|16k|batch\d+(-8k)?|pool\d+|seq\d+|mmap-(on|off)|no-checkpoints|ckpt-\d+|ckpt-max\d+|gpu1)$/;
for (const entry of BENCHMARK_MATRIX) {
  if (SPEED_ONLY.test(entry.id) && !entry.promptIds) entry.promptIds = [...SMOKE_PROMPT_IDS];
}

export const MODEL_MATRIX = BENCHMARK_MATRIX;

/** The three models the benchmark gate has always required (PRINCIPLE G-001). */
export const CORE_MODEL_IDS = Object.freeze([
  "smollm2-135m-instruct-q4",
  "qwen2.5-0.5b-instruct-q4",
  "qwen2.5-coder-1.5b-instruct-q4",
]);

export const CORE_MODEL_MATRIX = MODEL_MATRIX.filter((entry) =>
  CORE_MODEL_IDS.includes(entry.catalogId),
);

/** The fast default gate, or the full six-model matrix for a deeper review. */
export function modelMatrix({ full = false } = {}) {
  return full ? MODEL_MATRIX : CORE_MODEL_MATRIX;
}

/** A settings sweep for one benchmark model, on the 16-item smoke subset. */
export function modelMatrixFor(catalogId) {
  const spec = BENCHMARK_MODELS.find(
    (model) => model.catalogId === catalogId || model.fileName === catalogId,
  );
  if (!spec) return [];
  const family = spec.catalogId.replace(/-q\d+$/i, "");
  const common = { family, promptIds: [...SMOKE_PROMPT_IDS] };
  const make = (suffix, overrides = {}) =>
    variant(`single-${spec.catalogId}-${suffix}`, spec.catalogId, { ...common, ...overrides });
  return [
    make("base"),
    make("kv8", { kvCache: "q8_0" }),
    make("kv4", { kvCache: "q4_0" }),
    make("ctx4k", { contextSize: 4096 }),
    make("ctx8k", { contextSize: 8192 }),
    make("threads4", { threads: 4 }),
    make("threads16", { threads: 16 }),
    make("batch128", { batchSize: 128 }),
    make("batch256", { batchSize: 256 }),
    make("batch1024", { batchSize: 1024 }),
    make("flash-on", { flashAttention: "on" }),
    make("flash-off", { flashAttention: "off" }),
    make("mmap-on", { useMmap: "on" }),
    make("mmap-off", { useMmap: "off" }),
    make("no-checkpoints", { checkpoints: false }),
    make("ckpt512", { checkpointInterval: 512 }),
    make("ckpt-max4", { checkpointInterval: 512, checkpointMax: 4 }),
  ];
}

export const CHAT_BASE = Object.freeze({
  catalogId: "qwen2.5-0.5b-instruct-q4",
  family: "qwen2.5-0.5b-instruct",
  kvCache: "f16",
  contextSize: 2048,
  threads: 8,
  maxThreads: 8,
  batchSize: 512,
  sequences: 1,
  flashAttention: "auto",
  useMmap: "auto",
  gpuLayers: 0,
  gpuBackend: "cpu",
  checkpoints: true,
  checkpointInterval: 8192,
  checkpointMax: 32,
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  promptRepeat: 1,
  reasoning: "auto",
  structuredOutput: "none",
  jsonSchema: "",
  seed: 42,
});

/**
 * Builds the generation-only matrix on top of one measured model-reload
 * configuration. Sampling defaults stay fixed; the reload settings (model,
 * quantization, KV cache, context, threads, batch, sequences, attention, mmap,
 * GPU layers, checkpoints) come from the model phase the user selected.
 */
export function buildChatMatrix(selection = {}) {
  const base = { ...CHAT_BASE, ...selection };
  const catalogId = base.catalogId ?? CHAT_BASE.catalogId;
  const family = base.family ?? catalogId;
  const chatVariant = (id, title, overrides = {}) => {
    const merged = { ...base, ...overrides, family };
    const built = variant(id, catalogId, merged);
    return {
      ...built,
      ...merged,
      id,
      label: `${built.label} · ${title}`,
    };
  };

  return [
    chatVariant("chat-base", "sampling baseline"),
    chatVariant("chat-topk-20", "top-k 20", { topK: 20 }),
    chatVariant("chat-topk-80", "top-k 80", { topK: 80 }),
    chatVariant("chat-minp-002", "min-p 0.02", { minP: 0.02 }),
    chatVariant("chat-minp-010", "min-p 0.10", { minP: 0.1 }),
    chatVariant("chat-repeat-105", "repeat 1.05", { repeatPenalty: 1.05 }),
    chatVariant("chat-repeat-120", "repeat 1.20", { repeatPenalty: 1.2 }),
    chatVariant("chat-repeat-prompt-2", "prompt repeated twice", { promptRepeat: 2 }),
    chatVariant("chat-reasoning-deep", "deep reasoning", { reasoning: "deep" }),
    chatVariant("chat-reasoning-off", "reasoning off", { reasoning: "off" }),
    chatVariant("chat-system-concise", "concise system prompt", {
      systemPrompt: "Answer in as few words as possible. Obey the requested format exactly.",
    }),
  ];
}

/** Generation-only settings run on the model configuration chosen by the model phase. */
export const CHAT_MATRIX = buildChatMatrix();

/**
 * Flash section: one base variant per model family on the 16-item smoke set,
 * for a minutes-scale signal while the full matrix takes hours. Base variants
 * are the entries that change no setting (family === catalogId), plus the
 * chat base and single-model sweep bases. Informational only: the promptIds
 * override changes the test hash, so a flash run never compares or replaces
 * a baseline.
 */
export function flashMatrix(matrix) {
  const base = matrix.filter(
    (spec) => spec.family === spec.catalogId || spec.id === "chat-base" || spec.id.endsWith("-base"),
  );
  if (matrix.length && !base.length) {
    throw new Error(`flash: no base variants in a ${matrix.length}-variant matrix`);
  }
  const picked = base.length ? base : matrix.slice(0, 1);
  return picked.map((spec) => ({ ...spec, promptIds: [...SMOKE_PROMPT_IDS] }));
}

/**
 * Result file routing for a finished run. Flash runs never touch the shared
 * latest-<phase>.json or latest-single-model.json files: a flash+model run
 * would otherwise clobber the real single-model sweep, and flash model/chat
 * phases would share one file. Kept here (not run.mjs) so unit tests can
 * import it — run.mjs executes on import.
 */
export function resultFileName({ flash, phase, singleModelCatalogId = null }) {
  if (flash) {
    return singleModelCatalogId
      ? `latest-flash-single-${singleModelCatalogId}.json`
      : `latest-flash-${phase}.json`;
  }
  if (singleModelCatalogId) return "latest-single-model.json";
  return `latest-${phase}.json`;
}

export const MATRIX_VERSION = 4;

export const MATRIX_MODELS = [...new Map(
  BENCHMARK_MATRIX.map((entry) => [entry.catalogId, modelFor(entry.catalogId)]),
).values()];
