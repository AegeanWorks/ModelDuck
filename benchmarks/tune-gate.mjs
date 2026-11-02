import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../src/errors.js";
import { ensureDirectory } from "../src/fs-atomic.js";
import { currentGitInfo, recordRun } from "./history.mjs";
import { CORE_MODEL_IDS } from "./matrix.mjs";
import { BENCHMARK_MODELS } from "./suite.mjs";
import { TASKS, tuneRungs } from "./tasks.mjs";
import { measurePresets } from "./tune.mjs";
import { BASELINE_SCHEMA, TUNER_VERSION, baselineEntry, comparability, compareToBaseline, hardwareWarning } from "./tune-baseline.mjs";
import { createEvaluator } from "./tune-evaluate.mjs";
import { openTarget, runTune, tuneBase, withEngine } from "./tune-job.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "baseline-profiles.json");
const LATEST = path.join(HERE, "results", "latest-tune-gate.json");
const TASK_IDS = TASKS.map((task) => task.id);

const USAGE = `Usage: npm run tune:gate [-- --update-baseline [--models <ids>] [--passes <n>]] [--models-dir <dir>] [--max-runs <n>]

Re-measures each core model's baseline settings per task and fails when a task's
pass rate drops by more than one item (G-001). --update-baseline re-tunes the
three core models and replaces benchmarks/baseline-profiles.json deliberately (G-003);
--models (comma-separated core model ids) tunes only those, and --passes limits the
descent's passes, for a quicker baseline. The gate checks the models the baseline has.
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--update-baseline") options.updateBaseline = true;
    else if (arg === "--models-dir") options.modelsDir = argv[++index];
    else if (arg === "--max-runs") options.maxRuns = Number(argv[++index]);
    else if (arg === "--models") options.models = String(argv[++index] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--passes") options.passes = Number(argv[++index]);
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not a tune:gate option.`, fix: USAGE });
  }
  return options;
}

const fileOf = (catalogId) => BENCHMARK_MODELS.find((model) => model.catalogId === catalogId)?.fileName ?? catalogId;
const identityOf = (fingerprint) => ({ suiteVersion: fingerprint.suiteVersion, taskHash: fingerprint.taskHash, nodeLlamaCpp: fingerprint.nodeLlamaCpp, tunerVersion: fingerprint.tunerVersion });

async function updateBaseline(options, home) {
  const models = {};
  let identity = null;
  const chosen = options.models?.length ? options.models : CORE_MODEL_IDS;
  const unknown = chosen.filter((catalogId) => !CORE_MODEL_IDS.includes(catalogId));
  if (unknown.length) {
    throw new AppError("Not a core model", { code: "bad_option", why: `${unknown.join(", ")} is not one of the core models.`, fix: `Use any of: ${CORE_MODEL_IDS.join(", ")}.` });
  }
  for (const catalogId of chosen) {
    const target = await openTarget({ model: fileOf(catalogId), home, modelsDir: options.modelsDir });
    process.stdout.write(`Tuning ${catalogId} for the baseline…\n`);
    // One line per finished setting, so a run of hours shows where it is.
    const onEvent = (event) => {
      if (event.type === "sweep") process.stdout.write(`  ${event.stage}${event.task ? `:${event.task}` : ""} ${event.axis} -> ${JSON.stringify(event.winner)} · ${event.runs} answers\n`);
    };
    const { profile } = await runTune(target, { tasks: TASK_IDS, force: true, maxRuns: options.maxRuns, passes: options.passes, onEvent });
    models[catalogId] = baselineEntry(profile, { hardware: { cpu: target.system.cpu, threads: target.system.parallelism } });
    identity = identityOf(target.fingerprint);
  }
  const baseline = { schema: BASELINE_SCHEMA, tunerVersion: TUNER_VERSION, ...identity, createdAt: new Date().toISOString(), models };
  await writeFile(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`Wrote ${BASELINE}\n`);
}

async function gate(options, home) {
  let baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  } catch {
    throw new AppError("No tune baseline yet", { code: "tune_baseline_missing", why: `${BASELINE} is missing or unreadable.`, fix: "Run npm run tune:gate -- --update-baseline once, deliberately." });
  }
  const current = {};
  let identity = null;
  for (const [catalogId, entry] of Object.entries(baseline.models)) {
    const target = await openTarget({ model: fileOf(catalogId), home, modelsDir: options.modelsDir });
    identity = identityOf(target.fingerprint);
    const changed = comparability(baseline, identity);
    if (changed.length) {
      throw new AppError("The tune baseline is not comparable", {
        code: "tune_baseline_incomparable",
        why: `It was recorded with a different ${changed.join(", ")} (G-003).`,
        fix: "Update it deliberately with npm run tune:gate -- --update-baseline, and note why in benchmarks/CHANGELOG.md.",
      });
    }
    const presets = Object.fromEntries(Object.entries(entry.tasks).map(([task, saved]) => [task, saved.settings]));
    process.stdout.write(`Measuring ${catalogId} on its baseline settings…\n`);
    current[catalogId] = await withEngine(target, (engine) => measurePresets({
      evaluate: createEvaluator({ engine, modelId: target.entry.id }),
      load: { ...tuneBase(), ...entry.load },
      presets,
      rungs: tuneRungs(Object.keys(presets)),
    }));
  }
  const comparison = compareToBaseline(baseline, current);
  const warned = new Set();
  for (const row of comparison.rows) {
    const verdict = row.missing ? "MISSING" : row.regression ? "FAIL" : "ok";
    const latency = row.latencyDeltaMs === null || row.latencyDeltaMs === undefined ? "" : ` · latency ${row.latencyDeltaMs >= 0 ? "+" : ""}${row.latencyDeltaMs} ms`;
    const paired = row.b !== undefined ? ` · paired b=${row.b} c=${row.c} p=${row.pValue} Holm p=${row.pAdjusted}` : "";
    const items = row.regressed?.length ? ` · regressed: ${row.regressed.slice(0, 8).join(", ")}${row.regressed.length > 8 ? ` (+${row.regressed.length - 8} more)` : ""}` : "";
    process.stdout.write(`${verdict.padEnd(7)} ${row.model} ${row.task}: ${row.missing ? "not measured" : `${row.baselineRate}% → ${row.rate}% (${row.delta >= 0 ? "+" : ""}${row.delta}, tolerance ${row.tolerance})${paired}${items}${latency}`}\n`);
    if (row.regression && !warned.has(row.model)) {
      warned.add(row.model);
      const warning = hardwareWarning(baseline, { cpu: null, threads: null });
      if (warning) process.stdout.write(`  note: ${warning}\n`);
    }
  }
  const finishedAt = new Date().toISOString();
  const result = { schema: 3, phase: "tune-gate", suiteVersion: identity.suiteVersion, testHash: identity.taskHash, runtime: { nodeLlamaCpp: identity.nodeLlamaCpp }, createdAt: finishedAt, finishedAt, tuneGate: { ...comparison, current } };
  await ensureDirectory(path.dirname(LATEST));
  await writeFile(LATEST, `${JSON.stringify(result, null, 2)}\n`);
  await recordRun({ dbPath: path.join(HERE, "history.sqlite"), historyPath: path.join(HERE, "history.jsonl"), result, git: currentGitInfo(HERE) });
  process.stdout.write(comparison.passed ? "Tune gate passed.\n" : "Tune gate failed: a task lost more than one item.\n");
  return comparison.passed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  // Gate tunes never touch the user's saved profiles.
  const home = await mkdtemp(path.join(os.tmpdir(), "modelduck-tune-gate-"));
  try {
    if (options.updateBaseline) await updateBaseline(options, home);
    else if (!(await gate(options, home))) process.exitCode = 1;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n${error.why ? `Why: ${error.why}\n` : ""}${error.fix ? `Fix: ${error.fix}\n` : ""}`);
  process.exitCode = error.code === "bad_option" ? 2 : 1;
});
