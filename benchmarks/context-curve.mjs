import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROMPT_FINGERPRINT_VERSION } from "../src/generation-manifest.js";
import { AppError } from "../src/errors.js";
import { PROMPTS, SUITE_VERSION, SYSTEM_PROMPT } from "./suite.mjs";
import { taskPrompts } from "./tasks.mjs";
import { openTarget, tuneBase, withEngine } from "./tune-job.mjs";
import { createEvaluator } from "./tune-evaluate.mjs";
import { Measurements, score } from "./tune-measure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURVES_DIR = path.join(HERE, "curves");

/**
 * Long-context quality-vs-length curve with a prefill/decode breakdown
 * (LSA paper Fig. 5 RULER methodology at ModelDuck scale: ~0.1k to 16k).
 *
 * Measurement-only: it reuses the locked suite items (recall task: short
 * lookups, context-category items and the M6 4k/8k/16k needles), the tuner's
 * evaluator and scorer, and never touches the suite, baselines, profiles,
 * tune runs or history. Variants differ in load settings only (typically
 * kvCache or contextSize — the M6 question: does the KV choice hold at the
 * budgeted context?); anything else that drifts between variants refuses
 * the comparison instead of printing it.
 */

/**
 * IDEA-1504: affordable-needle chain scoring. The v17 long-context needles
 * (4k/8k/16k) confirm a KV choice at the budgeted context; a quantized cache
 * that silently drops a needle the f16 cache held is a regression, not noise.
 * The chain is ordered short to long: the score is the passing prefix, and
 * any affordable needle lost breaks the chain. Pure functions, no engine.
 */
export const NEEDLE_CHAIN_IDS = Object.freeze(["recall-long-4k", "recall-long-8k", "recall-long-16k"]);

function needlePassed(outcomes, id) {
  if (!outcomes) return false;
  const value = typeof outcomes.get === "function" ? outcomes.get(id) : outcomes[id];
  if (typeof value === "object" && value !== null) {
    if ("passed" in value && "total" in value) {
      return Number(value.total) > 0 && Number(value.passed) === Number(value.total) && !value.error;
    }
    if ("passed" in value) return Boolean(value.passed);
    return false;
  }
  return value === true || value === 1 || value === "1";
}

/**
 * Score one run's needle outcomes as a chain. `affordable` lists the needles
 * that fit the budgeted context; longer needles outside the budget stay out
 * instead of failing the chain.
 */
export function scoreNeedleChain(outcomes, { affordable = null } = {}) {
  const ids = [...(affordable ?? NEEDLE_CHAIN_IDS)];
  const results = ids.map((id) => ({ id, passed: needlePassed(outcomes, id) }));
  const passed = results.filter((row) => row.passed).length;
  let prefix = 0;
  for (const row of results) {
    if (row.passed) prefix += 1;
    else break;
  }
  const brokenAt = results.find((row) => !row.passed)?.id ?? null;
  const chainPassed = results.length > 0 && brokenAt === null;
  return { ids, total: results.length, passed, prefix, brokenAt, chainPassed, verdict: chainPassed ? "pass" : "fail", results };
}

/**
 * Catch a silent KV regression: any affordable needle the base held but the
 * candidate drops fails the gate; gains alone never fail it.
 */
export function compareNeedleChains(baseOutcomes, candidateOutcomes, { affordable = null } = {}) {
  const ids = [...(affordable ?? NEEDLE_CHAIN_IDS)];
  const regressed = ids.filter((id) => needlePassed(baseOutcomes, id) && !needlePassed(candidateOutcomes, id));
  const improved = ids.filter((id) => !needlePassed(baseOutcomes, id) && needlePassed(candidateOutcomes, id));
  return {
    ids,
    regressed,
    improved,
    verdict: regressed.length ? "fail" : "pass",
    reasons: regressed.map((id) => `${id}: held by the base, dropped by the candidate (silent KV regression)`),
  };
}

// Load settings a curve variant may change. GPU offload stays out: the
// curve runs the CPU lane so prefill/decode numbers stay comparable.
export const CURVE_LOAD_KEYS = Object.freeze([
  "contextSize",
  "kvCache",
  "threads",
  "batchSize",
  "flashAttention",
  "useMmap",
]);

export const CURVE_DEFAULTS = Object.freeze({
  contextSize: 16384,
  threads: 10,
  batchSize: 512,
  flashAttention: "auto",
  useMmap: "auto",
  kvCache: "f16",
  temperature: 0,
});

const BUCKETS = Object.freeze([
  { id: "<2k", test: (tokens) => tokens < 2048 },
  { id: "2-8k", test: (tokens) => tokens >= 2048 && tokens < 8192 },
  { id: "8k+", test: (tokens) => tokens >= 8192 },
]);

export function bucketOf(promptTokens) {
  if (!Number.isFinite(promptTokens)) return "unknown";
  return BUCKETS.find((bucket) => bucket.test(promptTokens))?.id ?? "unknown";
}

export function parseVariantSet(text) {
  const [name, rest] = String(text ?? "").split(/:(.*)/s, 2);
  if (!name || rest === undefined) {
    throw new AppError("Bad variant", {
      code: "bad_option",
      why: `"${text}" is not name:key=value,... .`,
      fix: 'Use --variant <name>:<key>=<value>,... e.g. --variant q8:kvCache=q8.',
    });
  }
  const settings = {};
  for (const pair of rest.split(",").map((part) => part.trim()).filter(Boolean)) {
    const [key, value] = pair.split("=", 2);
    if (!CURVE_LOAD_KEYS.includes(key) || value === undefined) {
      throw new AppError("Bad variant setting", {
        code: "bad_option",
        why: `"${pair}" is not an allowed curve setting.`,
        fix: `Allowed keys: ${CURVE_LOAD_KEYS.join(", ")}.`,
      });
    }
    const numeric = Number(value);
    settings[key] = key === "contextSize" || key === "threads" || key === "batchSize"
      ? numeric
      : value;
    if (typeof settings[key] === "number" && !Number.isFinite(settings[key])) {
      throw new AppError("Bad variant value", {
        code: "bad_option",
        why: `"${pair}" is not a number.`,
        fix: `Allowed keys: ${CURVE_LOAD_KEYS.join(", ")}.`,
      });
    }
  }
  return { name, settings };
}

/** Hash of everything BOTH variants share: the test definition minus load settings. */
export function curveTestHash({ suiteVersion, prompts, itemIds, systemPrompt, seed }) {
  const definition = {
    suiteVersion,
    phase: "context-curve",
    systemPrompt,
    promptFingerprintVersion: PROMPT_FINGERPRINT_VERSION,
    prompts: prompts.map((prompt) => prompt.id).sort(),
    itemIds: [...itemIds].sort(),
    sampling: { temperature: 0, seed },
  };
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
}
export function stampOf({ prompts, itemIds, suiteVersion, testHash, runtime, model }) {
  return {
    suiteVersion,
    testHash,
    promptIds: [...itemIds].sort(),
    promptCount: itemIds.length,
    runtime,
    model,
    prompts: prompts.length,
  };
}

/** Refuse a cross-variant comparison unless only load settings differ. */
export function checkComparable(stamps) {
  const [first, ...rest] = stamps;
  for (const stamp of rest) {
    const mismatch =
      stamp.suiteVersion !== first.suiteVersion ? "suiteVersion"
      : stamp.testHash !== first.testHash ? "testHash"
      : JSON.stringify(stamp.promptIds) !== JSON.stringify(first.promptIds) ? "item set"
      : stamp.runtime.nodeLlamaCpp !== first.runtime.nodeLlamaCpp ? "node-llama-cpp"
      : stamp.runtime.node !== first.runtime.node ? "node"
      : stamp.model.size !== first.model.size ? "model file size"
      : (stamp.model.chatTemplateHash ?? null) !== (first.model.chatTemplateHash ?? null) ? "chat template"
      : null;
    if (mismatch) {
      throw new AppError("Variants are not comparable", {
        code: "curve_incomparable",
        why: `Variants differ in ${mismatch}, not just load settings.`,
        fix: "Run every variant with the same suite, items, runtime and model file.",
      });
    }
  }
  return true;
}

export function bucketTable(stats) {
  const rows = [];
  const buckets = new Map();
  for (const [id, passed] of Object.entries(stats.outcomes ?? {})) {
    const tokens = stats.itemPrompt?.get?.(id) ?? stats.itemPrompt?.[id] ?? null;
    const bucket = bucketOf(tokens);
    if (!buckets.has(bucket)) buckets.set(bucket, { items: 0, passed: 0, tokens: [] });
    const row = buckets.get(bucket);
    row.items += 1;
    row.passed += passed ? 1 : 0;
    if (Number.isFinite(tokens)) row.tokens.push(tokens);
  }
  for (const [bucket, row] of buckets) {
    row.rate = row.items ? Math.round((row.passed / row.items) * 1000) / 10 : null;
    row.medianTokens = row.tokens.length
      ? row.tokens.sort((left, right) => left - right)[Math.floor(row.tokens.length / 2)]
      : null;
    delete row.tokens;
    rows.push({ bucket, ...row });
  }
  const order = ["<2k", "2-8k", "8k+", "unknown"];
  return rows.sort((left, right) => order.indexOf(left.bucket) - order.indexOf(right.bucket));
}

function parseArgs(argv) {
  const options = { model: null, variants: [], seed: 42, items: null, out: null, json: false };
  const take = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AppError("Missing option value", { code: "bad_option", why: `${name} needs a value.`, fix: USAGE });
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--model") options.model = take(index++, arg);
    else if (arg === "--variant") options.variants.push(parseVariantSet(take(index++, arg)));
    else if (arg === "--seed") options.seed = Number(take(index++, arg));
    else if (arg === "--items") options.items = take(index++, arg).split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--out") options.out = take(index++, arg);
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not a curve option.`, fix: USAGE });
  }
  return options;
}

const USAGE = `Usage: node benchmarks/context-curve.mjs --model <catalogId|file.gguf> --variant <name:key=value,...> [--variant ...] [options]

Quality-vs-length curve with a prefill/decode breakdown on the locked
recall task (short lookups, context items, M6 4k/8k/16k needles).
Variants differ in load settings only; the comparison is refused when
anything else drifts. Nothing is written to baselines, profiles,
tune runs or history; the report lands in benchmarks/curves/.

  --model <id>       catalog id or installed file name (required)
  --variant <spec>   name:key=value,... at least one (required);
                     keys: ${CURVE_LOAD_KEYS.join(", ")}
                     e.g. --variant f16:kvCache=f16 --variant q8:kvCache=q8
  --seed <n>         answer seed, greedy so one seed decides (default 42)
  --items <ids>      comma-separated subset of recall item ids (smoke only)
  --out <file>       report path (default benchmarks/curves/<model>-<time>.json)
  --json             print the report JSON instead of the table
`;

async function runtimeInfo() {
  const runtimeModule = await import("node-llama-cpp");
  const nodeLlamaCpp = await runtimeModule.getModuleVersion().catch(() => "unknown");
  return { nodeLlamaCpp, node: process.versions.node, promptFingerprintVersion: PROMPT_FINGERPRINT_VERSION };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.model || !options.variants.length) {
    process.stdout.write(USAGE);
    process.exitCode = options.help ? 0 : 2;
    return;
  }
  if (!Number.isFinite(options.seed)) {
    throw new AppError("Bad seed", { code: "bad_option", why: "The seed must be a number.", fix: USAGE });
  }
  const recallIds = taskPrompts("recall").map((prompt) => prompt.id);
  const itemIds = options.items ?? recallIds;
  const unknown = itemIds.filter((id) => !recallIds.includes(id));
  if (!unknown.length && !itemIds.length) {
    throw new AppError("No items", { code: "bad_option", why: "The recall task has no items.", fix: "Check benchmarks/suite.mjs." });
  }
  if (unknown.length) {
    throw new AppError("Unknown item", { code: "bad_option", why: `Not recall items: ${unknown.join(", ")}.`, fix: "Pick ids from the recall task (--items is a subset filter)." });
  }

  const target = await openTarget({ model: options.model });
  const runtime = await runtimeInfo();
  const model = {
    id: target.entry.id,
    fileName: target.entry.fileName,
    size: target.entry.size ?? null,
    chatTemplateHash: target.entry.chatTemplateHash ?? null,
  };
  const byId = new Map(PROMPTS.map((prompt) => [prompt.id, prompt]));
  const prompts = itemIds.map((id) => byId.get(id));

  await withEngine(target, async (engine) => {
    let answered = 0;
    const evaluate = createEvaluator({
      engine,
      modelId: target.entry.id,
      timeoutMs: 600_000,
      onItem: (row) => {
        answered += 1;
        process.stderr.write(`[curve] item ${answered}: ${row.id} ${row.error ? `error ${row.error}` : `${row.ms} ms, prompt ${row.promptTokens ?? "?"} tokens`}\n`);
      },
    });
    const measurements = new Measurements(evaluate, Infinity);
    const outPath = options.out ?? path.join(CURVES_DIR, `${target.profileId ?? model.id}-${Date.now()}.json`);
    await mkdir(path.dirname(outPath), { recursive: true });
    // One hash for every variant: prompts, suite, sampling — never load settings.
    const testHash = curveTestHash({ suiteVersion: SUITE_VERSION, prompts: PROMPTS, itemIds, systemPrompt: SYSTEM_PROMPT, seed: options.seed });
    const results = [];
    for (const variant of options.variants) {
      const settings = { ...tuneBase(), ...CURVE_DEFAULTS, ...variant.settings };
      const stats = await score(measurements, settings, itemIds, [options.seed]);
      if (!stats) throw new AppError("Measurement stopped", { code: "curve_failed", why: "The run budget was spent or the model cannot load.", fix: "Check the model loads in Models first." });
      const result = {
        variant: variant.name,
        settings: Object.fromEntries(CURVE_LOAD_KEYS.map((key) => [key, settings[key] ?? null])),
        stamp: stampOf({ prompts: PROMPTS, itemIds, suiteVersion: SUITE_VERSION, testHash, runtime, model }),
        rate: stats.rate,
        solved: stats.solved,
        ci95: stats.ci95,
        latencyMs: stats.latencyMs,
        promptTokens: stats.promptTokens,
        prefillTps: stats.prefillTps,
        decodeTps: stats.decodeTps,
        tokensPerSecond: stats.tokensPerSecond,
        truncationRate: stats.truncationRate,
        giveUpRate: stats.giveUpRate,
        failed: stats.failed,
        error: stats.error ?? null,
        buckets: bucketTable(stats),
        outcomes: stats.outcomes,
      };
      results.push(result);
      // Partial report after every variant: a killed run keeps what it measured.
      await writeFile(outPath, `${JSON.stringify({ tool: "context-curve", partial: true, suiteVersion: SUITE_VERSION, model, runtime, items: itemIds, seed: options.seed, variants: results }, null, 2)}\n`);
      process.stderr.write(`[curve] ${variant.name}: rate ${result.rate}% prefill ${result.prefillTps ?? "-"} t/s decode ${result.decodeTps ?? "-"} t/s (partial saved)\n`);
    }
    checkComparable(results.map((result) => result.stamp));
    const report = {
      tool: "context-curve",
      suiteVersion: SUITE_VERSION,
      model,
      runtime,
      items: itemIds,
      seed: options.seed,
      comparable: true,
      variants: results,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const result of results) {
        process.stdout.write(`${result.variant}: rate ${result.rate}% solved ${result.solved} prefill ${result.prefillTps ?? "-"} t/s decode ${result.decodeTps ?? "-"} t/s latency ${result.latencyMs ?? "-"} ms\n`);
        for (const row of result.buckets) {
          process.stdout.write(`  ${row.bucket}: ${row.passed}/${row.items} (${row.rate}%) median prompt ${row.medianTokens ?? "-"} tokens\n`);
        }
      }
    }
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!options.json) process.stdout.write(`Wrote ${outPath}\n`);
  });
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const message = error?.message ?? String(error);
    const details = error?.data ?? error?.options ?? null;
    process.stderr.write(`${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`);
    if (error?.fix) process.stderr.write(`Fix: ${error.fix}\n`);
    process.exitCode = error?.code === "bad_option" ? 2 : 1;
  });
}
