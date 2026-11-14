import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../src/errors.js";
import { ensureDirectory } from "../src/fs-atomic.js";
import { resolvePaths } from "../src/config.js";
import { answerDigest, answerFingerprint, cachedRowCount, gateCacheFile, generationDigest, loadGateCache, mergeAnswerGroups, probeDisagrees, saveGateCache, tripwireWindow } from "./gate-cache.mjs";
import { currentGitInfo, recordRun } from "./history.mjs";
import { CORE_MODEL_IDS } from "./matrix.mjs";
import { BENCHMARK_MODELS } from "./suite.mjs";
import { TASKS, taskParaphrase, tuneRungs } from "./tasks.mjs";
import { measurePresets } from "./tune.mjs";
import { runPool } from "./model-pool.mjs";
import { BASELINE_SCHEMA, TUNER_VERSION, baselineEntry, comparability, compareToBaseline, hardwareWarning, presetSettings, requireBaselineModels } from "./tune-baseline.mjs";
import { createEvaluator } from "./tune-evaluate.mjs";
import { openTarget, runTune, tuneBase, withEngine } from "./tune-job.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, "baseline-profiles.json");
const LATEST = path.join(HERE, "results", "latest-tune-gate.json");
const TASK_IDS = TASKS.map((task) => task.id);

const USAGE = `Usage: npm run tune:gate [-- --update-baseline [--models <ids>] [--passes <n>] [--from-profile <home>]] [--models-dir <dir>] [--max-runs <n>] [--fresh]

Re-measures each core model's baseline settings per task and fails when a task's
pass rate drops by more than one item (G-001). --update-baseline re-tunes the
three core models and replaces benchmarks/baseline-profiles.json deliberately (G-003);
--models (comma-separated core model ids) tunes only those, and --passes limits the
descent's passes, for a quicker baseline. --from-profile <home> uses the already
measured profiles/<model>.json from that home instead of tuning; a missing profile
is measured as the app defaults. The gate checks the models the baseline has.
Cached answers: identical settings/seed/item rows from the last gate are reused
when the answer world is unchanged (suite, tasks, tuner, model, runtime, hardware
and the answer-side file contents: the engine closure and prompt/settings
assembly); a judge-only change re-judges the same answers; an answer-side change
re-measures everything.
--fresh ignores and overwrites the cache.
--models-parallel <n> measures up to n models at once (default: all core models,
up to 3). Answers are unchanged; under contention the latency column reads
noisier, so pass 1 for strict sequential latency readings.
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
    else if (arg === "--models-parallel") options.modelsParallel = Math.max(1, Math.round(Number(argv[++index])) || 1);
    else if (arg === "--fresh") options.fresh = true;
    else if (arg === "--from-profile") options.fromProfile = argv[++index];
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
    identity = identityOf(target.fingerprint);
    if (options.fromProfile) {
      const file = path.join(options.fromProfile, "profiles", `${catalogId}.json`);
      let profile = null;
      try {
        profile = JSON.parse(await readFile(file, "utf8"));
      } catch {
        // A missing profile is measured as defaults, never invented.
      }
      if (profile) {
        const changed = comparability({ schema: BASELINE_SCHEMA, ...(profile.fingerprint ?? {}) }, identity);
        if (changed.length) {
          throw new AppError("The saved profile is not comparable", {
            code: "tune_profile_incomparable",
            why: `${file} was measured with a different ${changed.join(", ")}.`,
            fix: "Re-tune that model, or choose a profile measured under the current suite, runtime and tuner version.",
          });
        }
        process.stdout.write(`Re-measuring ${catalogId} from ${file}…\n`);
      } else {
        process.stdout.write(`No profile at ${file}; measuring ${catalogId} defaults…\n`);
      }
      const preset = presetSettings(profile, TASK_IDS);
      // A profile carries the load it was tuned on. With none, measure on the
      // fastest local backend so the baseline is not needlessly CPU-slow.
      const load = Object.keys(preset.load).length ? preset.load : { gpuBackend: "vulkan", gpuLayers: "max" };
      const presets = Object.fromEntries(TASK_IDS.map((task) => [task, preset.tasks[task].settings]));
      const measured = await withEngine(target, (engine) => measurePresets({
        evaluate: createEvaluator({ engine, modelId: target.entry.id }),
        load: { ...tuneBase(), ...load },
        presets,
        rungs: tuneRungs(TASK_IDS),
      }));
      for (const task of TASK_IDS) {
        const stats = measured[task];
        process.stdout.write(`  ${task}: ${stats.rate}% · ${stats.items} items · ${stats.latencyMs} ms\n`);
      }
      models[catalogId] = baselineEntry({
        load: { settings: load },
        tasks: Object.fromEntries(TASK_IDS.map((task) => [task, { settings: presets[task], stats: measured[task] }])),
      }, { hardware: { cpu: target.system.cpu, threads: target.system.parallelism } });
      continue;
    }
    process.stdout.write(`Tuning ${catalogId} for the baseline…\n`);
    // One line per finished setting, so a run of hours shows where it is.
    const onEvent = (event) => {
      if (event.type === "sweep") process.stdout.write(`  ${event.stage}${event.task ? `:${event.task}` : ""} ${event.axis} -> ${JSON.stringify(event.winner)} · ${event.runs} answers\n`);
    };
    const { profile } = await runTune(target, { tasks: TASK_IDS, force: true, maxRuns: options.maxRuns, passes: options.passes, onEvent });
    models[catalogId] = baselineEntry(profile, { hardware: { cpu: target.system.cpu, threads: target.system.parallelism } });
  }
  const note = options.fromProfile
    ? `Deliberate baseline update: tuned task presets were re-measured from ${options.fromProfile}; missing profiles were measured as defaults. Do not replace this to make a change pass.`
    : "Deliberate baseline update: each core model was re-tuned by tune:gate --update-baseline. Do not replace this to make a change pass.";
  const baseline = { schema: BASELINE_SCHEMA, tunerVersion: TUNER_VERSION, ...identity, createdAt: new Date().toISOString(), note, models };
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
  requireBaselineModels(baseline);
  const current = {};
  const paraphrase = {};
  const hardwareNow = {};
  let identity = null;
  const repoRoot = path.join(HERE, "..");
  // IDEA-1764: the reuse fingerprint covers the whole world identity plus the
  // answer half of the code (engine closure and the drivers that frame
  // prompts and settings), so a cached answer always comes from a
  // bit-identical answer world; judge code runs fresh on every gate.
  const codeDigest = await generationDigest(repoRoot);
  const answersDigest = await answerDigest(repoRoot);
  // The models are independent measurements (own engine, own cache file), so
  // they run concurrently in a bounded pool: wall time becomes the slowest
  // model instead of the sum. Answers cannot change — each model keeps its
  // recorded serial inference path — but under contention an item's own
  // latency reading inflates, so latency rows read lower-fidelity while
  // --models-parallel 1 keeps the strictly sequential run.
  const parallelWidth = options.modelsParallel ?? Math.min(3, Object.keys(baseline.models).length);
  const measured = await runPool(
    Object.entries(baseline.models),
    async ([catalogId, entry]) => {
      try {
        return { catalogId, error: null, currentTasks: await measureModel(catalogId, entry, { baseline, options, home, repoRoot, codeDigest, answersDigest }) };
      } catch (error) {
        // A lane's failure never poisons the others' results; the gate aborts
        // on the first failure in model order once every lane has settled.
        return { catalogId, error, currentTasks: null };
      }
    },
    parallelWidth,
  );
  for (const item of measured) {
    if (item.error) throw item.error;
    current[item.catalogId] = item.currentTasks.tasks;
    if (item.currentTasks.paraphrase) paraphrase[item.catalogId] = item.currentTasks.paraphrase;
    hardwareNow[item.catalogId] = item.currentTasks.hardware;
    if (identity === null) identity = item.currentTasks.identity;
  }

  /**
   * One model's whole gate measurement: comparability check, restored cache,
   * tripwire window measurement and cache save. Isolated so the pool can run
   * models concurrently without sharing any mutable state.
   */
  async function measureModel(catalogId, entry, { baseline, options, home, repoRoot, codeDigest, answersDigest }) {
  const target = await openTarget({ model: fileOf(catalogId), home, modelsDir: options.modelsDir });
  const identity = identityOf(target.fingerprint);
  const changed = comparability(baseline, identity);
  if (changed.length) {
    throw new AppError("The tune baseline is not comparable", {
        code: "tune_baseline_incomparable",
        why: `It was recorded with a different ${changed.join(", ")} (G-003).`,
        fix: "Update it deliberately with npm run tune:gate -- --update-baseline, and note why in benchmarks/CHANGELOG.md.",
      });
    }
    const presets = Object.fromEntries(Object.entries(entry.tasks).map(([task, saved]) => [task, saved.settings]));
    const fingerprint = answerFingerprint(target.fingerprint, answersDigest);
    const cacheFile = gateCacheFile(repoRoot, catalogId);
    const cached = options.fresh ? null : await loadGateCache(cacheFile, fingerprint).catch(() => null);
    const restore = cached?.groups?.length ? cached.groups : [];
    const reusedRows = cachedRowCount(restore);
    // IDEA-1765: each gate checks a rotating window of the last rung; a
    // drift signal escalates the task to the full measurement.
    const rotation = cached?.runs ?? 0;
    const freshGroups = [];
    process.stdout.write(`Measuring ${catalogId} on its baseline settings…${reusedRows ? ` (${reusedRows} cached answers, window ${rotation + 1})` : ""}\n`);
    const onAnswers = (settings, seed, rows) => {
      const kept = rows.filter((row) => row && !row.error);
      if (kept.length) freshGroups.push({ settings, seed, rows: kept });
    };
    // ADR-100: the paraphrase probes ride the holdout side, so after the
    // paired verdict the same settings also answer requests worded unlike
    // anything the search tuned on. Informational only: they never enter
    // the Holm family.
    const { measured: measuredPresets, paraphrase } = await withEngine(target, async (engine) => {
      const evaluate = createEvaluator({ engine, modelId: target.entry.id });
      const measured = await measurePresets({
        evaluate,
        load: { ...tuneBase(), ...entry.load },
        presets,
        rungs: tuneRungs(Object.keys(presets)),
        restore,
        // IDEA-1765: the tripwire window for this run, rotating per gate.
        tripwire: (task, allIds) => tripwireWindow(allIds, rotation),
        escalate: (task, probeStats) =>
          probeStats?.failed === true ||
          probeDisagrees(entry.tasks[task]?.outcomes, probeStats?.outcomes),
        // Transient errors are not measurements: a failed load must not be
        // cached and replayed as a real answer (the tuner's G2 store skips them the same way).
        onAnswers,
      });
      const paraRungs = Object.fromEntries(Object.keys(presets).map((task) => [task, [taskParaphrase(task)]]));
      const probed = Object.values(paraRungs).every(([ids]) => !ids.length)
        ? null
        : await measurePresets({ evaluate, load: { ...tuneBase(), ...entry.load }, presets, rungs: paraRungs, restore, onAnswers });
      const paraphrase = probed
        ? Object.fromEntries(Object.entries(presets).filter(([task]) => paraRungs[task][0].length).map(([task]) => [task, { rate: probed[task].rate, items: probed[task].items }]))
        : null;
      return { measured, paraphrase };
    });
    const { reusedAnswers, freshAnswers, ...currentTasks } = measuredPresets;
    process.stdout.write(`  answers: ${reusedAnswers} reused, ${freshAnswers} fresh${reusedRows || freshAnswers ? "" : " (cache cold)"}
`);
    await saveGateCache(cacheFile, { fingerprint, judgeDigest: codeDigest, groups: mergeAnswerGroups(restore, freshGroups), runs: cached?.runs ?? 0 }).catch((error) => {
      process.stdout.write(`  note: the answer cache could not be saved (${error.message}); the next gate re-measures.
`);
    });
    return { identity, tasks: currentTasks, paraphrase, hardware: { cpu: target.system.cpu, threads: target.system.parallelism } };
  }
  const comparison = compareToBaseline(baseline, current);
  const warned = new Set();
  for (const row of comparison.rows) {
    const verdict = row.missing ? "MISSING" : row.regression ? "FAIL" : "ok";
    const latency = row.latencyDeltaMs === null || row.latencyDeltaMs === undefined ? "" : ` · latency ${row.latencyDeltaMs >= 0 ? "+" : ""}${row.latencyDeltaMs} ms`;
    // IDEA-1765: a tripwire row shows what was actually checked; rows kept
    // out of the Holm pool carry their un-adjusted p.
    const tripwireNote = row.tripwire ? ` · checked ${row.tripwire.checked}/${row.tripwire.of}` : "";
    const paired = row.b !== undefined ? ` · paired b=${row.b} c=${row.c} p=${row.pValue}${row.pAdjusted !== undefined ? ` Holm p=${row.pAdjusted}` : ""}` : "";
    const items = row.regressed?.length ? ` · regressed: ${row.regressed.slice(0, 8).join(", ")}${row.regressed.length > 8 ? ` (+${row.regressed.length - 8} more)` : ""}` : "";
    process.stdout.write(`${verdict.padEnd(7)} ${row.model} ${row.task}: ${row.missing ? "not measured" : `${row.baselineRate}% → ${row.rate}% (${row.delta >= 0 ? "+" : ""}${row.delta}, tolerance ${row.tolerance})${tripwireNote}${paired}${items}${latency}`}\n`);
    if (row.regression && !warned.has(row.model)) {
      warned.add(row.model);
      const warning = hardwareWarning(baseline, hardwareNow[row.model] ?? null, row.model);
      if (warning) process.stdout.write(`  note: ${warning}\n`);
    }
  }
  // ADR-100: the paraphrase probes report informationally after the verdict rows.
  for (const [catalogId, lanes] of Object.entries(paraphrase)) {
    process.stdout.write(`paraphrase ${catalogId}: ${Object.entries(lanes).map(([task, stats]) => `${task} ${stats.rate ?? "?"}% (${stats.items} probes)`).join(" · ")}
`);
  }
  const finishedAt = new Date().toISOString();
  const result = { schema: 3, phase: "tune-gate", suiteVersion: identity.suiteVersion, testHash: identity.taskHash, runtime: { nodeLlamaCpp: identity.nodeLlamaCpp }, createdAt: finishedAt, finishedAt, tuneGate: { ...comparison, current, paraphrase } };
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
  if (options.fromProfile && !options.updateBaseline) {
    throw new AppError("Not a baseline update", { code: "bad_option", why: "--from-profile only applies with --update-baseline.", fix: USAGE });
  }
  // Gate tunes never touch the user's saved profiles.
  // The temp home isolates profiles and runs, but models must keep resolving
  // to the real folder: resolvePaths derives models from home when
  // --models-dir is absent, and an empty temp models dir makes every model
  // look uninstalled. An explicit --models-dir still wins.
  if (!options.modelsDir) options.modelsDir = resolvePaths({}).models;
  const home = await mkdtemp(path.join(os.tmpdir(), "modelduck-tune-gate-"));
  try {
    if (options.updateBaseline) await updateBaseline(options, home);
    else if (!(await gate(options, home))) process.exitCode = 1;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// A CLI, not a library: importing this module must not run a real gate
// (the same guard report.mjs and merge-shards.mjs already ship).
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n${error.why ? `Why: ${error.why}\n` : ""}${error.fix ? `Fix: ${error.fix}\n` : ""}`);
    process.exitCode = error.code === "bad_option" ? 2 : 1;
  });
}
