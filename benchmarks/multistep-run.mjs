import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../src/errors.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { LOAD_KEYS, loadProfile, presetFor } from "../src/model-profiles.js";
import { MULTISTEP_CHAINS, MULTISTEP_VERSION, multistepHash } from "./multistep-items.mjs";
import { runChain, summarizeChains } from "./multistep-evaluate.mjs";
import { SYSTEM_PROMPT } from "./suite.mjs";
import { openTarget, withEngine } from "./tune-job.mjs";

const RESULTS_DIR = fileURLToPath(new URL("./results/", import.meta.url));

const USAGE = `Usage: npm run bench:multistep -- --model <catalogId|file.gguf> [options]

Runs the multistep chains: one conversation per chain, where every step changes
or builds on the code the model wrote before, checked with that code loaded.
Reports checks per step and per chain. Opt-in: it never touches a tune, a profile,
a baseline or the gate.

  --model <id>       catalog id or installed file name (required)
  --chains <list>    comma-separated chain ids (default: all ${MULTISTEP_CHAINS.length})
  --seeds <list>     comma-separated seeds (default 42)
  --defaults         use app defaults (greedy) even when the model has a tuned code preset
  --home <folder>    data folder with profiles/ (default ~/.modelduck)
  --models-dir <dir> models folder
  --out <file>       results file (default benchmarks/results/latest-multistep-<model>.json)
`;

function parseArgs(argv) {
  const options = { seeds: [42], chains: null, defaults: false };
  const take = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new AppError("Missing option value", { code: "bad_option", why: `${name} needs a value.`, fix: USAGE });
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--model") options.model = take(index++, arg);
    else if (arg === "--chains") options.chains = take(index++, arg).split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--seeds") options.seeds = take(index++, arg).split(",").map(Number);
    else if (arg === "--defaults") options.defaults = true;
    else if (arg === "--home") options.home = take(index++, arg);
    else if (arg === "--models-dir") options.modelsDir = take(index++, arg);
    else if (arg === "--out") options.out = take(index++, arg);
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not an option.`, fix: USAGE });
  }
  return options;
}

/** The chains to run, refusing an id that is not one. */
export function selectChains(ids) {
  if (!ids?.length) return MULTISTEP_CHAINS;
  const unknown = ids.filter((id) => !MULTISTEP_CHAINS.some((chain) => chain.id === id));
  if (unknown.length) {
    throw new AppError("Unknown chain", {
      code: "multistep_chain_unknown",
      why: `${unknown.join(", ")} is not a multistep chain.`,
      fix: `Use any of: ${MULTISTEP_CHAINS.map((chain) => chain.id).join(", ")}.`,
    });
  }
  return MULTISTEP_CHAINS.filter((chain) => ids.includes(chain.id));
}

/** One line per chain: checks per step, then the chain total. */
export function chainLine(result) {
  const steps = result.steps.map((step) => `${step.step}: ${step.passed}/${step.total}${step.error ? " (error)" : step.unreadable ? " (unreadable)" : ""}`).join(" · ");
  return `${result.id} [seed ${result.seed}] ${steps} → ${result.passed}/${result.total} (${result.rate}%)${result.allSteps ? " · every step solved" : ""}`;
}

/** The closing summary: checks, chains solved in every step, and the rate at each depth. */
export function summaryLine(summary) {
  const depth = summary.byStep.map((step) => `step ${step.step} ${step.rate}%`).join(" · ");
  return `Multistep: ${summary.passed}/${summary.total} checks (${summary.rate}%) · ${summary.allSteps}/${summary.runs} chains solved in every step · ${depth}${summary.errors ? ` · ${summary.errors} step errors` : ""}`;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.model) throw new AppError("Choose a model", { code: "bad_option", why: "--model is required.", fix: USAGE });
  if (options.seeds.some((seed) => !Number.isInteger(seed))) throw new AppError("Seeds must be whole numbers", { code: "bad_option", why: "--seeds takes a comma-separated list such as 42,7.", fix: USAGE });
  const chains = selectChains(options.chains);
  const target = await openTarget({ model: options.model, home: options.home, modelsDir: options.modelsDir });
  const saved = options.defaults ? null : await loadProfile(target.paths.profiles, target.profileId, target.fingerprint).catch(() => null);
  const preset = saved ? presetFor(saved.profile, "code") : null;
  // A tuned code preset says how this model is served; each step keeps its own answer budget.
  const { maxTokens: _maxTokens, systemPrompt = SYSTEM_PROMPT, ...settings } = preset ?? {};
  const load = Object.fromEntries(Object.entries(settings).filter(([key]) => LOAD_KEYS.includes(key)));
  const sampling = Object.fromEntries(Object.entries(settings).filter(([key]) => !LOAD_KEYS.includes(key)));
  process.stdout.write(`Multistep v${MULTISTEP_VERSION} (${multistepHash()}) on ${target.entry.fileName}: ${chains.length} chains × ${options.seeds.length} seed(s), ${preset ? "its tuned code preset" : "app defaults (greedy)"}\n`);
  for (const warning of saved?.warnings ?? []) process.stdout.write(`Warning: ${warning}\n`);
  const started = Date.now();
  const results = await withEngine(target, async (engine) => {
    await engine.load({ modelId: target.entry.id, ...load });
    const out = [];
    for (const seed of options.seeds) {
      for (const chain of chains) {
        const result = await runChain({ engine, chain, settings: sampling, seed, systemPrompt });
        process.stdout.write(`${chainLine(result)}\n`);
        out.push(result);
      }
    }
    return out;
  });
  const summary = summarizeChains(results);
  process.stdout.write(`${summaryLine(summary)}\nTime ${Math.round((Date.now() - started) / 1000)}s\n`);
  const file = options.out ?? path.join(RESULTS_DIR, `latest-multistep-${target.profileId}.json`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, {
    kind: "modelduck-multistep",
    version: MULTISTEP_VERSION,
    hash: multistepHash(),
    model: target.entry.fileName,
    profileId: target.profileId,
    fingerprint: target.fingerprint,
    settings: { source: preset ? "tuned code preset" : "defaults", load, sampling, systemPrompt },
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary,
    results,
  });
  process.stdout.write(`Saved ${file}\n`);
}

// A CLI, not a library: importing this module must not start a run.
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n${error.why ? `Why: ${error.why}\n` : ""}${error.fix ? `Fix: ${error.fix}\n` : ""}`);
    process.exitCode = error.code === "bad_option" || error.code === "multistep_chain_unknown" ? 2 : 1;
  });
}
