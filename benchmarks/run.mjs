import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAME, VERSION, defaultThreads, resolvePaths } from "../src/config.js";
import { DownloadManager } from "../src/downloader.js";
import { LlamaEngine } from "../src/engine.js";
import { AppError } from "../src/errors.js";
import { ensureDirectory } from "../src/fs-atomic.js";
import { manifestSummary, PROMPT_FINGERPRINT_VERSION } from "../src/generation-manifest.js";
import { getCatalogModel } from "../src/model-catalog.js";
import { createModelRegistry } from "../src/model-registry.js";
import { systemInfo } from "../src/system.js";
import { currentGitInfo, recordRun } from "./history.mjs";
import { MODEL_MATRIX, buildChatMatrix, flashMatrix, modelMatrix, modelMatrixFor, promptListFor, resultFileName } from "./matrix.mjs";
import { BENCHMARK_MODELS, PROMPTS, SUITE_VERSION, SYSTEM_PROMPT, checkCount, evaluateResponse } from "./suite.mjs";
import { compareRuns, itemSummary, promptOrigin } from "./stats.mjs";
import { benchmarkTestHash, modelIdentityChanges } from "./test-hash.mjs";
import {
  chatBaseSettings,
  loadChatBase,
  resolveChatBase,
  selectChatBase,
} from "../src/benchmark-base.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_MODEL = path.join(HERE, "baseline-model.json");
const BASELINE_CHAT = path.join(HERE, "baseline-chat.json");
const RESULTS_DIR = path.join(HERE, "results");
const LATEST = path.join(RESULTS_DIR, "latest.json");
const HISTORY_DB = path.join(HERE, "history.sqlite");
const HISTORY_LOG = path.join(HERE, "history.jsonl");
const UNSUPPORTED_SETTINGS = {
  physicalBatchSize: "node-llama-cpp 3.22.2 exposes batchSize but not n_ubatch separately",
  unifiedKvCache: "node-llama-cpp 3.22.2 does not expose llama.cpp kv_unified",
  ropeFrequencyScale: "node-llama-cpp 3.22.2 does not expose rope frequency scaling",
  ropeFrequencyBase: "node-llama-cpp 3.22.2 does not expose rope frequency base",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {
    updateBaseline: false,
    download: false,
    json: false,
    events: false,
    help: false,
    phase: "model",
    modelsDir: null,
    contextSize: null,
    threads: null,
    selectBase: null,
    baseVariant: null,
    fullMatrix: false,
    model: null,
    flash: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].includes("=")
      ? argv[index].split(/=(.*)/s, 2)
      : [argv[index], undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new AppError(`Missing value for ${flag}`, { fix: "Run npm run bench -- --help." });
      return argv[index];
    };
    switch (flag) {
      case "--update-baseline":
        options.updateBaseline = true;
        break;
      case "--download":
        options.download = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--events":
        options.events = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--models-dir":
        options.modelsDir = take();
        break;
      case "--phase":
        options.phase = take();
        break;
      case "--context":
        options.contextSize = Number(take());
        break;
      case "--threads":
        options.threads = Number(take());
        break;
      case "--select-base":
        options.selectBase = take();
        break;
      case "--base-variant":
        options.baseVariant = take();
        break;
      case "--full-matrix":
        options.fullMatrix = true;
        break;
      case "--model":
        options.model = take();
        break;
      case "--flash":
        options.flash = true;
        break;
      default:
        throw new AppError(`Unknown option: ${flag}`, { fix: "Run npm run bench -- --help." });
    }
  }
  return options;
}

const HELP = `${APP_NAME} ${VERSION} benchmark

Runs a seeded quality, speed, quantization and KV-cache matrix:
  ${modelMatrix().length} core model-reload variants + ${buildChatMatrix().length} generation variants
  (${MODEL_MATRIX.length} model-reload variants with --full-matrix)

Usage:
  npm run bench -- [options]

Options:
  --update-baseline   Save this run as the comparison baseline
  --download          Download missing benchmark models first
  --models-dir <dir>  Model folder (default: ~/.modelduck/models)
  --phase <name>      model (reload settings) or chat (sampling/system settings)
  --context <n>       Override every variant's context size
  --threads <n>       Override every variant's CPU thread count
  --select-base <id>  Save a model-phase variant as the base for later chat runs
  --base-variant <id> Use that variant for this chat run only (no save)
  --full-matrix       Run all six model families (default: the three core models)
  --model <id>        Sweep reload settings for one model on the smoke set (never replaces a baseline)
  --flash             Base variant per family on the 16-item smoke set, minutes not hours
                      (informational only: never compares or replaces a baseline)
  --json              Print only the machine-readable result
  --events            Stream JSON progress lines on stdout (for the app)
  -h, --help          Show this help

Quality is the percentage of deterministic checks passed. Speed is the median
generated tokens per second. A significant paired item decline or a 5-pt drop exits 1.
`;

function log(options, ...values) {
  if (options.json) return;
  const stream = options.events ? process.stderr : process.stdout;
  stream.write(`${values.join(" ")}\n`);
}

/** One JSON object per line on stdout; the app's BenchmarkRunner reads these. */
function emit(options, event) {
  if (!options.events) return;
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function categoryScores(prompts) {
  const categories = {};
  for (const prompt of prompts) {
    const category = prompt.category || "other";
    categories[category] ??= { passed: 0, total: 0 };
    categories[category].passed += prompt.passed;
    categories[category].total += prompt.total;
  }
  return Object.fromEntries(
    Object.entries(categories).map(([category, value]) => [
      category,
      {
        ...value,
        score: value.total ? Number(((value.passed / value.total) * 100).toFixed(1)) : 0,
      },
    ]),
  );
}

function categoryLine(categories) {
  return Object.entries(categories)
    .map(([category, value]) => `${category} ${value.score.toFixed(0)}%`)
    .join(" · ");
}

function findModel(registry, spec) {
  const names = new Set(
    [spec.fileName, spec.file, ...(spec.aliases ?? [])]
      .filter(Boolean)
      .map((name) => name.toLowerCase()),
  );
  const publicEntry = registry
    .listPublic()
    .find((model) => names.has(model.fileName.toLowerCase()));
  return publicEntry ? registry.findById(publicEntry.id) : null;
}

async function downloadMissing(registry, specs, modelsDir, options) {
  const manager = new DownloadManager({ modelsDir });
  for (const spec of specs) {
    if (findModel(registry, spec)) continue;
    const catalog = getCatalogModel(spec.catalogId);
    if (!catalog) throw new AppError(`Unknown benchmark model ${spec.catalogId}`);
    log(options, `  Downloading ${catalog.name} (${formatSize(catalog.size)})...`);
    const job = await manager.start(spec.catalogId);
    let current = job;
    while (current.status === "queued" || current.status === "downloading") {
      await sleep(1500);
      current = manager.get(job.id);
      if (current.percent % 20 === 0) {
        log(options, `    ${current.percent}% ${formatSize(current.received)}`);
      }
    }
    if (current.status !== "complete") {
      throw new AppError(`Could not download ${catalog.name}`, {
        why: current.error?.why || "The download did not finish.",
        fix: current.error?.fix || "Retry with npm run bench -- --download.",
      });
    }
    await registry.scan();
  }
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(0)} MB`;
}

function failedVariant(entry, spec, error) {
  const checksTotal = promptListFor(spec).reduce((sum, prompt) => sum + checkCount(prompt), 0);
  return {
    key: spec.family,
    variantId: spec.id,
    variantLabel: spec.label,
    label: spec.label,
    kind: spec.kind,
    fileName: entry?.fileName ?? spec.fileName ?? spec.file ?? null,
    modelId: entry?.id ?? null,
    size: entry?.size ?? null,
    params: entry?.params ?? null,
    quant: spec.quant ?? entry?.quant ?? null,
    preset: spec.preset ?? null,
    kvCache: spec.kvCache ?? "f16",
    contextSize: spec.contextSize ?? 2048,
    requestedContextSize: spec.contextSize ?? 2048,
    threads: spec.threads ?? 8,
    maxThreads: spec.maxThreads ?? spec.threads ?? 8,
    batchSize: spec.batchSize ?? 512,
    sequences: spec.sequences ?? 1,
    flashAttention: spec.flashAttention ?? "auto",
    useMmap: spec.useMmap ?? "auto",
    gpuLayers: spec.gpuLayers ?? 0,
    gpuBackend: spec.gpuBackend ?? "cpu",
    checkpoints: spec.checkpoints !== false,
    checkpointInterval: spec.checkpointInterval ?? 8192,
    checkpointMax: spec.checkpointMax ?? 32,
    memoryBytes: null,
    score: 0,
    checksPassed: 0,
    checksTotal,
    byCategory: {},
    tokensPerSecond: 0,
    firstTokenMs: 0,
    runtimeMs: 0,
    totalMs: 0,
    prompts: [],
    error: error?.message || String(error),
    failed: true,
  };
}

async function runModel(engine, entry, spec, options, { index = 0, total = 0 } = {}) {
  const promptList = promptListFor(spec);
  const contextSize = options.contextSize ?? spec.contextSize ?? 2048;
  const threads = options.threads ?? spec.threads ?? 8;
  const kvCache = spec.kvCache ?? "f16";
  log(options, `\n[${spec.label}] loading ${entry.fileName}`);
  const loaded = await engine.load({
    modelId: entry.id,
    contextSize,
    threads,
    maxThreads: spec.maxThreads ?? threads,
    batchSize: spec.batchSize ?? 512,
    sequences: spec.sequences ?? 1,
    flashAttention: spec.flashAttention ?? "auto",
    useMmap: spec.useMmap ?? "auto",
    gpuLayers: spec.gpuLayers ?? 0,
    gpuBackend: spec.gpuBackend ?? "cpu",
    checkpoints: spec.checkpoints !== false,
    checkpointInterval: spec.checkpointInterval ?? 8192,
    checkpointMax: spec.checkpointMax ?? 32,
    kvCache,
  });
  const memoryBytes = (await engine.status())?.memory?.cpuRam ?? null;
  const systemPrompt = spec.systemPrompt ?? SYSTEM_PROMPT;
  const prompts = [];
  for (const [promptIndex, prompt] of promptList.entries()) {
    emit(options, {
      type: "prompt-start",
      phase: options.phase,
      variantId: spec.id,
      variantIndex: index,
      variantsTotal: total,
      label: prompt.label,
      index: promptIndex + 1,
      total: promptList.length,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const started = Date.now();
    let result;
    let error = null;
    try {
      result = await engine.chat({
        conversationId: `bench-${entry.id}-${spec.id}-${prompt.id}`,
        messages: [{ role: "user", content: prompt.prompt }],
        systemPrompt,
        settings: {
          temperature: spec.temperature ?? 0,
          topP: spec.topP ?? 1,
          topK: spec.topK ?? 40,
          minP: spec.minP ?? 0.05,
          repeatPenalty: spec.repeatPenalty ?? 1.1,
          promptRepeat: spec.promptRepeat ?? 1,
          reasoning: spec.reasoning ?? "off",
          structuredOutput: spec.structuredOutput ?? "none",
          jsonSchema: spec.jsonSchema ?? "",
          seed: spec.seed ?? 42,
          contextOverflow: spec.contextOverflow ?? "shift",
          maxTokens: prompt.maxTokens,
          contextSize,
          threads,
          kvCache,
        },
        signal: controller.signal,
        onToken: () => {},
      });
    } catch (caught) {
      error = caught;
      result = { text: "", aborted: false, stats: { ms: Date.now() - started } };
    } finally {
      clearTimeout(timeout);
      engine.dropSession(`bench-${entry.id}-${spec.id}-${prompt.id}`);
    }
    const evaluation = error
      ? { passed: 0, total: checkCount(prompt), checks: Array.from({ length: checkCount(prompt) }, () => ({ type: "error", passed: false, detail: error.message })) }
      : await evaluateResponse(prompt, result.text);
    prompts.push({
      id: prompt.id,
      label: prompt.label,
      category: prompt.category,
      source: prompt.source ?? null,
      passed: evaluation.passed,
      total: evaluation.total,
      checks: evaluation.checks,
      text: String(result.text ?? "").slice(0, 4000),
      aborted: Boolean(result.aborted),
      error: error ? error.message : null,
      stats: result.stats,
      manifest: manifestSummary(result.manifest),
    });
    const score = evaluation.total ? Math.round((evaluation.passed / evaluation.total) * 100) : 0;
    emit(options, {
      type: "prompt",
      phase: options.phase,
      variantId: spec.id,
      promptId: prompt.id,
      label: prompt.label,
      index: promptIndex + 1,
      total: promptList.length,
      passed: evaluation.passed,
      checks: evaluation.total,
      score,
      tokensPerSecond: result.stats?.tokensPerSecond ?? 0,
    });
    log(
      options,
      `  ${score === 100 ? "PASS" : score === 0 ? "FAIL" : "PART"} ${prompt.label} (${evaluation.passed}/${evaluation.total}) ${result.stats?.tokensPerSecond ?? 0} tok/s`,
    );
  }
  await engine.unload();
  const checksPassed = prompts.reduce((sum, prompt) => sum + prompt.passed, 0);
  const checksTotal = prompts.reduce((sum, prompt) => sum + prompt.total, 0);
  const modelResult = {
    key: spec.family,
    variantId: spec.id,
    variantLabel: spec.label,
    label: spec.label,
    kind: spec.kind,
    fileName: entry.fileName,
    catalogId: spec.catalogId ?? null,
    modelId: entry.id,
    size: entry.size,
    params: entry.params,
    quant: spec.quant ?? entry.quant,
    chatTemplateHash: entry.chatTemplateHash ?? null,
    preset: spec.preset ?? null,
    kvCache,
    contextSize: loaded.contextSize,
    requestedContextSize: contextSize,
    threads,
    maxThreads: spec.maxThreads ?? threads,
    batchSize: spec.batchSize ?? 512,
    sequences: spec.sequences ?? 1,
    flashAttention: spec.flashAttention ?? "auto",
    useMmap: spec.useMmap ?? "auto",
    gpuLayers: spec.gpuLayers ?? 0,
    gpuBackend: spec.gpuBackend ?? "cpu",
    checkpoints: spec.checkpoints !== false,
    checkpointInterval: spec.checkpointInterval ?? 8192,
    checkpointMax: spec.checkpointMax ?? 32,
    temperature: spec.temperature ?? 0,
    topP: spec.topP ?? 1,
    topK: spec.topK ?? 40,
    minP: spec.minP ?? 0.05,
    repeatPenalty: spec.repeatPenalty ?? 1.1,
    promptRepeat: spec.promptRepeat ?? 1,
    reasoning: spec.reasoning ?? "off",
    structuredOutput: spec.structuredOutput ?? "none",
    systemPrompt,
    seed: spec.seed ?? 42,
    memoryBytes,
    score: checksTotal ? Number(((checksPassed / checksTotal) * 100).toFixed(2)) : 0,
    checksPassed,
    checksTotal,
    byCategory: categoryScores(prompts),
    items: itemSummary(prompts),
    tokensPerSecond: Number(
      median(prompts.map((prompt) => prompt.stats?.tokensPerSecond ?? 0)).toFixed(2),
    ),
    firstTokenMs: Math.round(
      median(prompts.map((prompt) => prompt.stats?.firstTokenMs ?? 0)),
    ),
    runtimeMs: prompts.reduce((sum, prompt) => sum + (prompt.stats?.ms ?? 0), 0),
    totalMs: prompts.reduce((sum, prompt) => sum + (prompt.stats?.ms ?? 0), 0),
    prompts,
  };
  emit(options, {
    type: "variant",
    phase: options.phase,
    variantId: spec.id,
    label: spec.label,
    index,
    total,
    score: modelResult.score,
    itemsRate: modelResult.items.rate,
    tokensPerSecond: modelResult.tokensPerSecond,
  });
  return modelResult;
}

function printTopLine(result) {
  const overall = result.overall;
  return `${overall.checksPassed}/${overall.checksTotal} checks · ${overall.score.toFixed(1)}% · ${overall.tokensPerSecond.toFixed(1)} tok/s · ${overall.firstTokenMs} ms first token`;
}

function compareToBaseline(result, baseline) {
  const deltas = [];
  const byKey = new Map(
    baseline.models.map((model) => [model.variantId ?? model.key, model]),
  );
  for (const model of result.models) {
    const previous = byKey.get(model.variantId ?? model.key);
    if (!previous) {
      deltas.push(`  ${model.label}: new variant (baseline has none)`);
      continue;
    }
    if (previous.size && previous.size !== model.size) {
      deltas.push(`  ${model.label}: model file size changed (${previous.size} → ${model.size})`);
    }
    const quality = model.score - previous.score;
    const speed = previous.tokensPerSecond
      ? ((model.tokensPerSecond - previous.tokensPerSecond) / previous.tokensPerSecond) * 100
      : 0;
    deltas.push(
      `  ${model.label}: quality ${quality >= 0 ? "+" : ""}${quality.toFixed(1)} pts, ` +
        `speed ${speed >= 0 ? "+" : ""}${speed.toFixed(1)}%`,
    );
  }
  const qualityDelta = result.overall.score - baseline.overall.score;
  const speedDelta = baseline.overall.tokensPerSecond
    ? ((result.overall.tokensPerSecond - baseline.overall.tokensPerSecond) /
        baseline.overall.tokensPerSecond) *
      100
    : 0;
  return { deltas, qualityDelta, speedDelta };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!["model", "chat"].includes(options.phase)) {
    throw new AppError("Invalid benchmark phase", {
      fix: "Use --phase model or --phase chat.",
    });
  }
  let singleModel = null;
  if (options.model) {
    if (options.phase !== "model") {
      throw new AppError("A single model only applies to the model phase", {
        fix: "Drop --model for the chat phase, or use --base-variant.",
      });
    }
    if (options.updateBaseline) {
      throw new AppError("A single-model run cannot replace the baseline", {
        code: "single_model_baseline_refused",
        fix: "Run the core matrix (npm run bench) or --full-matrix to replace a baseline.",
      });
    }
    if (options.fullMatrix) {
      throw new AppError("Choose either --model or --full-matrix", {
        fix: "Drop --full-matrix; a single-model run already selects one family.",
      });
    }
    singleModel = BENCHMARK_MODELS.find(
      (model) => model.catalogId === options.model || model.fileName === options.model,
    );
    if (!singleModel) {
      throw new AppError("Unknown benchmark model", {
        code: "benchmark_model_unknown",
        fix: "Use one of the catalog ids listed in benchmarks/suite.mjs.",
      });
    }
  }
  if (options.selectBase) {
    const selection = await selectChatBase({ benchmarkDir: HERE, variantId: options.selectBase });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
    } else {
      log(options, `Chat base selected: ${selection.label} (${selection.variantId})`);
      log(options, "Run npm run bench:chat when you are ready.");
    }
    return;
  }
  if (options.baseVariant && options.phase !== "chat") {
    throw new AppError("A chat base only applies to the chat phase", {
      fix: "Add --phase chat, or drop --base-variant.",
    });
  }
  let chatBase = null;
  if (options.phase === "chat") {
    chatBase = options.baseVariant
      ? await resolveChatBase({ benchmarkDir: HERE, variantId: options.baseVariant })
      : await loadChatBase({ benchmarkDir: HERE });
  }
  if (options.flash && options.updateBaseline) {
    throw new AppError("A flash run cannot replace the baseline", {
      code: "flash_baseline_refused",
      fix: "Run the core matrix (npm run bench) or --full-matrix to replace a baseline.",
    });
  }
  const matrix = options.flash
    ? flashMatrix(
        options.phase === "chat"
          ? buildChatMatrix(chatBaseSettings(chatBase))
          : singleModel
            ? modelMatrixFor(singleModel.catalogId)
            : modelMatrix({ full: options.fullMatrix }),
      )
    : options.phase === "chat"
      ? buildChatMatrix(chatBaseSettings(chatBase))
      : singleModel
        ? modelMatrixFor(singleModel.catalogId)
        : modelMatrix({ full: options.fullMatrix });
  if (!matrix.length) {
    throw new AppError("That model has no benchmark variants", {
      code: "benchmark_model_unknown",
      fix: "Choose a catalog model that appears in benchmarks/matrix.mjs.",
    });
  }
  // Validate every variant's prompt ids before a model is loaded.
  for (const spec of matrix) promptListFor(spec);
  const baselinePath = options.phase === "chat" ? BASELINE_CHAT : BASELINE_MODEL;
  const runtimeModule = await import("node-llama-cpp");
  const nodeLlamaCpp = await runtimeModule.getModuleVersion().catch(() => "unknown");
  const runtime = {
    nodeLlamaCpp,
    node: process.versions.node,
    promptFingerprintVersion: PROMPT_FINGERPRINT_VERSION,
  };
  const testHash = benchmarkTestHash({
    suiteVersion: SUITE_VERSION,
    phase: options.phase,
    prompts: PROMPTS,
    matrix,
    systemPrompt: SYSTEM_PROMPT,
  });

  if (options.contextSize !== null && (!Number.isFinite(options.contextSize) || options.contextSize < 512)) {
    throw new AppError("Invalid context size", { fix: "Use at least 512." });
  }
  if (options.threads !== null && (!Number.isFinite(options.threads) || options.threads < 1)) {
    throw new AppError("Invalid thread count", { fix: "Use at least 1 thread." });
  }

  const paths = resolvePaths({ models: options.modelsDir });
  await ensureDirectory(paths.models);
  await ensureDirectory(RESULTS_DIR);
  const registry = createModelRegistry({ modelsDir: paths.models });

  log(options, `${APP_NAME} ${VERSION} benchmark · suite v${SUITE_VERSION} · tests ${testHash}`);
  log(options, `Runtime: node-llama-cpp ${runtime.nodeLlamaCpp} · Node ${runtime.node} · manifest v${runtime.promptFingerprintVersion}`);
  log(options, `Models folder: ${paths.models}`);
  if (options.phase === "chat") {
    log(options, `Chat base: ${chatBase ? `${chatBase.label} (${chatBase.variantId})` : "default Qwen2.5 0.5B Q4"}`);
  }
  if (singleModel) {
    log(options, `Single-model settings sweep: ${singleModel.label} (${singleModel.catalogId})`);
  }
  if (options.flash) {
    log(options, `Flash: ${matrix.length} base variants on the 16-item smoke set — informational only, no baseline comparison.`);
  }
  log(options, `Matrix: ${matrix.length} variants · CPU ${systemInfo().cpu}`);
  log(options, `Unsupported by the runtime: ${Object.keys(UNSUPPORTED_SETTINGS).join(", ")}`);
  emit(options, {
    type: "benchmark",
    phase: options.phase,
    suiteVersion: SUITE_VERSION,
    testHash,
    variants: matrix.length,
    models: new Set(matrix.map((spec) => spec.catalogId)).size,
  });

  await registry.scan();
  if (options.download) {
    const downloadSpecs = [...new Map(matrix.map((spec) => [spec.catalogId, spec])).values()];
    await downloadMissing(registry, downloadSpecs, paths.models, options);
  }
  for (const spec of matrix) {
    if (!findModel(registry, spec)) {
      throw new AppError(`Missing benchmark model: ${spec.label}`, {
        code: "benchmark_model_missing",
        why: `${spec.fileName} is not in ${paths.models}.`,
        fix: "Run npm run bench -- --download, or install it from Models → Discover.",
      });
    }
  }

  let baseline = null;
  if (!singleModel && !options.flash) {
    try {
      baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    } catch {
      baseline = null;
    }
  }

  if (baseline) {
    const templateChanges = modelIdentityChanges(
      baseline.models,
      matrix.map((spec) => {
        const entry = findModel(registry, spec);
        return {
          variantId: spec.id,
          size: entry?.size ?? null,
          chatTemplateHash: entry?.chatTemplateHash ?? null,
        };
      }),
    );
    const describe = (change) =>
      `${change.variantId} (${change.previousTemplate ?? "no hash"} -> ${change.currentTemplate ?? "no hash"})`;
    if (templateChanges.length && !options.updateBaseline) {
      throw new AppError("A benchmark model file or chat template changed", {
        code: "benchmark_model_changed",
        why: `The baseline was recorded with different model files or templates: ${templateChanges.map(describe).join(", ")}.`,
        fix: "Inspect the model files, then update the baseline deliberately.",
      });
    }
    if (templateChanges.length) {
      log(options, `\nDeliberate model update: ${templateChanges.map(describe).join(", ")}.`);
    }
  }

  if (baseline && baseline.suiteVersion !== SUITE_VERSION && !options.updateBaseline) {
    throw new AppError("The benchmark suite changed", {
      code: "benchmark_suite_changed",
      why: `${path.basename(baselinePath)} is suite v${baseline.suiteVersion}; this run is v${SUITE_VERSION}.`,
      fix: "Review the new prompts, then run npm run bench -- --update-baseline.",
    });
  }
  if (baseline && baseline.testHash !== testHash && !options.updateBaseline) {
    throw new AppError("The benchmark test definitions changed", {
      code: "benchmark_tests_changed",
      why: `The baseline was recorded with test hash ${baseline.testHash ?? "missing"}; this run uses ${testHash}.`,
      fix: "Review benchmarks/CHANGELOG.md, then update the baseline deliberately.",
    });
  }
  if (
    baseline &&
    baseline.runtime?.nodeLlamaCpp &&
    baseline.runtime.nodeLlamaCpp !== runtime.nodeLlamaCpp &&
    !options.updateBaseline
  ) {
    throw new AppError("The inference runtime changed", {
      code: "benchmark_runtime_changed",
      why: `The baseline used node-llama-cpp ${baseline.runtime.nodeLlamaCpp}; this run uses ${runtime.nodeLlamaCpp}.`,
      fix: "Review the runtime changelog, then update the baseline deliberately.",
    });
  }
  if (
    baseline &&
    baseline.runtime?.promptFingerprintVersion &&
    baseline.runtime.promptFingerprintVersion !== runtime.promptFingerprintVersion &&
    !options.updateBaseline
  ) {
    throw new AppError("The prompt fingerprint changed", {
      code: "benchmark_fingerprint_changed",
      why: `The baseline used manifest v${baseline.runtime.promptFingerprintVersion}; this run uses v${runtime.promptFingerprintVersion}.`,
      fix: "Review src/generation-manifest.js, then update the baseline deliberately.",
    });
  }

  const engine = new LlamaEngine({ registry });
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const models = [];
  try {
    for (const [index, spec] of matrix.entries()) {
      const entry = findModel(registry, spec);
      try {
        models.push(await runModel(engine, entry, spec, options, { index: index + 1, total: matrix.length }));
      } catch (error) {
        log(options, `  FAILED ${spec.label}: ${error.message}`);
        models.push(failedVariant(entry, spec, error));
        emit(options, {
          type: "variant",
          phase: options.phase,
          variantId: spec.id,
          label: spec.label,
          index: index + 1,
          total: matrix.length,
          error: error.message,
        });
        await engine.unload().catch(() => {});
      }
    }
  } finally {
    await engine.dispose().catch(() => {});
  }

  const checksPassed = models.reduce((sum, model) => sum + model.checksPassed, 0);
  const checksTotal = models.reduce((sum, model) => sum + model.checksTotal, 0);
  const testAggregate = {};
  for (const model of models) {
    for (const prompt of model.prompts ?? []) {
      const key = prompt.id;
      testAggregate[key] ??= {
        id: key,
        label: prompt.label,
        category: prompt.category,
        origin: promptOrigin(prompt),
        dataset: prompt.source?.dataset ?? (String(prompt.category).startsWith("public-") ? prompt.category.slice(7) : "own"),
        passed: 0,
        total: 0,
      };
      testAggregate[key].passed += prompt.passed;
      testAggregate[key].total += prompt.total;
    }
  }
  const tests = Object.values(testAggregate)
    .map((test) => ({
      ...test,
      percent: test.total ? Number(((test.passed / test.total) * 100).toFixed(1)) : 0,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const result = {
    schema: 3,
    phase: options.phase,
    suiteVersion: SUITE_VERSION,
    testHash,
    runtime,
    appVersion: VERSION,
    createdAt: startedAt,
    finishedAt: new Date().toISOString(),
    runtimeMs: Date.now() - startedAtMs,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: systemInfo().cpu,
      parallelism: systemInfo().parallelism,
    },
    settings: {
      matrix: true,
      matrixScope: options.flash
        ? "flash"
        : singleModel
          ? `single:${singleModel.catalogId}`
          : options.phase === "model"
            ? options.fullMatrix ? "full" : "core"
            : "chat",
      contextSizeOverride: options.contextSize,
      threadsOverride: options.threads,
      temperature: 0,
      systemPrompt: SYSTEM_PROMPT,
      chatBase: chatBase
        ? {
            variantId: chatBase.variantId,
            catalogId: chatBase.catalogId,
            family: chatBase.family,
            label: chatBase.label,
            fileName: chatBase.fileName,
            settings: chatBase.settings,
          }
        : null,
    },
    capabilities: {
      supported: [
        "contextSize",
        "batchSize",
        "threads",
        "maxThreads",
        "sequences",
        "flashAttention",
        "useMmap",
        "gpuLayers",
        "checkpoints",
        "checkpointInterval",
        "checkpointMax",
        "kvCacheKey",
        "kvCacheValue",
      ],
      unsupported: UNSUPPORTED_SETTINGS,
    },
    overall: {
      score: checksTotal ? Number(((checksPassed / checksTotal) * 100).toFixed(2)) : 0,
      checksPassed,
      checksTotal,
      byCategory: categoryScores(models.flatMap((model) => model.prompts)),
      items: itemSummary(models.flatMap((model) => model.prompts)),
      tokensPerSecond: Number(
        median(models.map((model) => model.tokensPerSecond)).toFixed(2),
      ),
      firstTokenMs: Math.round(median(models.map((model) => model.firstTokenMs))), // aikit:allow-secret timing metric
    },
    tests,
    models,
  };
  if (!options.flash) {
    await writeFile(LATEST, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  await writeFile(
    path.join(RESULTS_DIR, resultFileName({ flash: options.flash, phase: options.phase, singleModelCatalogId: singleModel?.catalogId ?? null })),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );

  log(options, "\nResults");
  log(options, "─".repeat(96));
  for (const model of models) {
    log(
      options,
      `${model.label.padEnd(58)} ${String(model.score.toFixed(1) + "%").padStart(6)}  ` +
        `${String(model.tokensPerSecond.toFixed(1)).padStart(5)} tok/s  ${String(model.firstTokenMs).padStart(5)} ms  ${String(model.memoryBytes ? Math.round(model.memoryBytes / (1024 * 1024)) + " MB" : "—").padStart(8)}`,
    );
  }
  log(options, "─".repeat(96));
  log(options, `OVERALL${" ".repeat(51)} ${String(result.overall.score.toFixed(1) + "%").padStart(6)}  ${String(result.overall.tokensPerSecond.toFixed(1)).padStart(5)} tok/s  ${String(result.overall.firstTokenMs).padStart(5)} ms  ${String((result.runtimeMs / 1000).toFixed(1) + "s").padStart(8)} runtime`);
  log(options, `Categories: ${categoryLine(result.overall.byCategory)}`);
  const items = result.overall.items;
  log(options, `Items fully passed: ${items.passed}/${items.total} = ${items.rate}% (95% CI ${items.ci95.low}-${items.ci95.high}%)`);
  for (const [category, value] of Object.entries(items.byCategory)) {
    log(options, `  ${category.padEnd(14)} ${String(value.rate + "%").padStart(6)}  CI ${value.ci95.low}-${value.ci95.high}%  (${value.passed}/${value.total})`);
  }
  log(options, "\nTests");
  for (const test of tests) {
    log(
      options,
      `  ${String(test.label || test.id).padEnd(28)} ${String(test.percent.toFixed(1) + "%").padStart(6)}  (${test.passed}/${test.total})`,
    );
  }

  if (options.updateBaseline) {
    if (baseline && (baseline.testHash !== testHash || baseline.suiteVersion !== SUITE_VERSION)) {
      log(
        options,
        `\nDeliberate baseline update: suite v${baseline.suiteVersion} (${baseline.testHash ?? "no hash"}) -> v${SUITE_VERSION} (${testHash}).`,
      );
    }
    await writeFile(baselinePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    log(options, `\nBaseline updated: ${baselinePath}`);
  } else if (baseline) {
    const comparison = compareToBaseline(result, baseline);
    log(options, "\nAgainst baseline");
    log(options, comparison.deltas.join("\n"));
    log(
      options,
      `  Overall: quality ${comparison.qualityDelta >= 0 ? "+" : ""}${comparison.qualityDelta.toFixed(2)} pts, ` +
        `speed ${comparison.speedDelta >= 0 ? "+" : ""}${comparison.speedDelta.toFixed(1)}%`,
    );
    const sameMachine = baseline.machine?.cpu === result.machine.cpu;
    if (!sameMachine) {
      log(options, "  Speed comparison skipped: the baseline was recorded on a different CPU.");
    } else if (comparison.speedDelta < -20) {
      log(options, "  WARNING: speed regressed by more than 20%; investigate before accepting the change.");
    }
    // Paired item-level gate (benchmarks/stats.mjs): a floor breach or a decline
    // that survives Holm-corrected exact McNemar fails; smaller declines warn.
    const gate = compareRuns(result, baseline);
    result.gate = gate;
    log(options, `  Items: ${gate.baselineRate}% -> ${gate.currentRate}% (paired over ${gate.variants.length} variants)`);
    for (const variant of gate.variants.filter((item) => item.regressed.length || item.improved.length)) {
      log(
        options,
        `    ${variant.variantId}: -${variant.regressed.length} +${variant.improved.length} (p=${variant.p}, Holm ${variant.pAdjusted})` +
          (variant.regressed.length ? ` regressed: ${variant.regressed.join(", ")}` : ""),
      );
    }
    if (gate.verdict === "fail") {
      log(options, `  QUALITY REGRESSION: ${gate.reasons.join("; ")}. Do not accept this change without an ADR.`);
      process.exitCode = 1;
    } else if (gate.verdict === "warn") {
      log(options, "  WARNING: some items regressed, but not beyond the floor or significance; review them before accepting.");
    } else if (gate.variants.some((item) => item.improved.length)) {
      log(options, "  GAINED EDGE: items improved over baseline with none regressing.");
    } else {
      log(options, "  NO QUALITY CHANGE.");
    }
  } else if (options.flash) {
    log(options, "\nFlash run: base variants on the smoke set. Informational only — the shared baseline was not read, compared or replaced.");
  } else if (singleModel) {
    log(options, "\nSingle-model settings sweep: the shared baseline was not read, compared or replaced.");
  } else {
    log(options, "\nNo baseline yet. Run npm run bench -- --update-baseline once on this machine.");
  }

  const git = currentGitInfo(path.resolve(HERE, ".."));
  const history = await recordRun({
    dbPath: HISTORY_DB,
    historyPath: HISTORY_LOG,
    result,
    git,
    baseline: options.updateBaseline,
  });
  log(options, `\nHistory: ${HISTORY_DB}`);
  if (git.dirty) {
    log(options, "Commit pending: run npm run bench:link after committing the change.");
  }
  log(options, `Run id: ${history.uid}`);
  emit(options, {
    type: "complete",
    phase: options.phase,
    suiteVersion: SUITE_VERSION,
    testHash,
    quality: result.overall.score,
    itemsRate: result.overall.items.rate,
    tokensPerSecond: result.overall.tokensPerSecond,
    runtimeMs: result.runtimeMs,
    baselineUpdated: options.updateBaseline,
    singleModel: singleModel?.catalogId ?? null,
    gate: result.gate?.verdict ?? null,
    runId: history.uid,
  });

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`\n[bench] ${error?.message || error}\n`);
  if (error?.why) process.stderr.write(`  Why: ${error.why}\n`);
  if (error?.fix) process.stderr.write(`  Fix: ${error.fix}\n`);
  process.exit(1);
});
