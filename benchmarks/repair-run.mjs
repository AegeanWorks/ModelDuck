import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../src/errors.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { LOAD_KEYS, loadProfile, presetFor } from "../src/model-profiles.js";
import { REPAIR_MODES, repairEligible, runRepair, summarizeRepair } from "./repair-evaluate.mjs";
import { SYSTEM_PROMPT } from "./suite.mjs";
import { taskPrompts } from "./tasks.mjs";
import { openTarget, withEngine } from "./tune-job.mjs";

const RESULTS_DIR = fileURLToPath(new URL("./results/", import.meta.url));

const USAGE = `Usage: npm run bench:repair -- --model <catalogId|file.gguf> [options]

Answers every code item, runs its tests, and when one fails tells the model
which call failed (what it should return and what it did) so it can try
again in the same conversation. Reports the solved rate after each round.
Only one failing case is shown per round and every round is scored on all
cases. Opt-in: it never touches a tune, a profile, a baseline or the gate.

  --model <id>       catalog id or installed file name (required)
  --rounds <n>       repairs after the first answer, 1-5 (default 2)
  --seed <n>         sampling seed (default 42); the first answer is greedy and does not depend on it
  --limit <n>        only the first n code items (default: all)
  --defaults         use app defaults (greedy) even when the model has a tuned code preset
  --show <n>         failing calls named in each feedback, 1-10 (default 1)
  --mode <chat|fresh|retry> chat: one conversation (default); fresh: each repair in a new
                     conversation with the failed code quoted, so it is not the model's own turn;
                     retry: the control, the same question again with a new seed and no feedback
  --repair-temperature <t>  sample repairs at this temperature (default: the answer's own)
  --home <folder>    data folder with profiles/ (default ~/.modelduck)
  --models-dir <dir> models folder
  --out <file>       results file (default benchmarks/results/latest-repair-<model>.json)
`;

function parseArgs(argv) {
  const options = { rounds: 2, limit: null, defaults: false, show: 1, repairTemperature: null, mode: "chat", seed: 42 };
  const take = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new AppError("Missing option value", { code: "bad_option", why: `${name} needs a value.`, fix: USAGE });
    return value;
  };
  const whole = (value, name, min, max) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new AppError(`${name} needs a whole number`, { code: "bad_option", why: `"${value}" is not a whole number from ${min} to ${max}.`, fix: USAGE });
    return number;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--model") options.model = take(index++, arg);
    else if (arg === "--rounds") options.rounds = whole(take(index++, arg), arg, 1, 5);
    else if (arg === "--limit") options.limit = whole(take(index++, arg), arg, 1, 10000);
    else if (arg === "--defaults") options.defaults = true;
    else if (arg === "--show") options.show = whole(take(index++, arg), arg, 1, 10);
    else if (arg === "--seed") options.seed = whole(take(index++, arg), arg, 0, 2 ** 31 - 1);
    else if (arg === "--mode") {
      options.mode = take(index++, arg);
      if (!REPAIR_MODES.includes(options.mode)) throw new AppError("Unknown repair mode", { code: "bad_option", why: `"${options.mode}" is not ${REPAIR_MODES.join(" or ")}.`, fix: USAGE });
    }
    else if (arg === "--repair-temperature") {
      const value = Number(take(index++, arg));
      if (!(Number.isFinite(value) && value >= 0 && value <= 2)) throw new AppError("--repair-temperature needs a number from 0 to 2", { code: "bad_option", why: `"${argv[index]}" is not a temperature.`, fix: USAGE });
      options.repairTemperature = value;
    }
    else if (arg === "--home") options.home = take(index++, arg);
    else if (arg === "--models-dir") options.modelsDir = take(index++, arg);
    else if (arg === "--out") options.out = take(index++, arg);
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not an option.`, fix: USAGE });
  }
  return options;
}

/** The closing lines: solved after each round, what feedback rescued, and per question type. */
export function repairReport(summary) {
  const rounds = summary.byRound.map((round) => `${round.round === 0 ? "first answer" : `after repair ${round.round}`} ${round.solved}/${summary.items} (${round.rate}%)`).join(" · ");
  const types = Object.entries(summary.byCategory).map(([category, entry]) => `${category} ${entry.first}→${entry.final}/${entry.items}`).join(" · ");
  return [
    `Repair: ${rounds}`,
    `${summary.mode === "retry" ? "Retries" : "Feedback"} rescued ${summary.rescued} items for ${summary.answers - summary.items} extra answers${summary.resent ? ` · ${summary.resent} repairs resent the same answer` : ""}${summary.errors ? ` · ${summary.errors} errors` : ""}`,
    `By type (first → final): ${types}`,
  ].join("\n");
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!options.model) throw new AppError("Choose a model", { code: "bad_option", why: "--model is required.", fix: USAGE });
  const items = taskPrompts("code").filter(repairEligible).slice(0, options.limit ?? undefined);
  const target = await openTarget({ model: options.model, home: options.home, modelsDir: options.modelsDir });
  const saved = options.defaults ? null : await loadProfile(target.paths.profiles, target.profileId, target.fingerprint).catch(() => null);
  const preset = saved ? presetFor(saved.profile, "code") : null;
  // Each item keeps its own answer budget; the tuned preset decides how the model samples.
  const { maxTokens: _maxTokens, systemPrompt = SYSTEM_PROMPT, ...settings } = preset ?? {};
  const load = Object.fromEntries(Object.entries(settings).filter(([key]) => LOAD_KEYS.includes(key)));
  const sampling = Object.fromEntries(Object.entries(settings).filter(([key]) => !LOAD_KEYS.includes(key)));
  process.stdout.write(`Repair on ${target.entry.fileName}: ${items.length} code items, up to ${options.rounds} repairs each, ${preset ? "its tuned code preset" : "app defaults (greedy)"}, ${options.mode} mode, ${options.show} failing call(s) shown${options.repairTemperature !== null ? `, repairs at T=${options.repairTemperature}` : ""}\n`);
  const started = Date.now();
  const results = await withEngine(target, async (engine) => {
    await engine.load({ modelId: target.entry.id, ...load });
    const out = [];
    for (const prompt of items) {
      const result = await runRepair({ engine, prompt, rounds: options.rounds, settings: sampling, systemPrompt, show: options.show, repairTemperature: options.repairTemperature, mode: options.mode, seed: options.seed });
      out.push(result);
      const marks = result.rounds.map((round) => `${round.passed}/${round.total}`).join(" → ");
      process.stdout.write(`${result.solvedAt === null ? "  " : result.solvedAt === 0 ? "ok" : "++"} ${prompt.id}: ${marks}\n`);
    }
    return out;
  });
  const summary = summarizeRepair(results, options.rounds);
  process.stdout.write(`${repairReport(summary)}\nTime ${Math.round((Date.now() - started) / 1000)}s\n`);
  const file = options.out ?? path.join(RESULTS_DIR, `latest-repair-${target.profileId}.json`);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, {
    kind: "modelduck-repair",
    model: target.entry.fileName,
    profileId: target.profileId,
    fingerprint: target.fingerprint,
    settings: { source: preset ? "tuned code preset" : "defaults", load, sampling, systemPrompt, show: options.show, repairTemperature: options.repairTemperature, mode: options.mode, seed: options.seed },
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
    process.exitCode = error.code === "bad_option" ? 2 : 1;
  });
}
