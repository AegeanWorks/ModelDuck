import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../src/errors.js";
import { watchParent } from "../src/tune-lock.js";
import { readSteps, writeSteps } from "../src/tune-steps.js";
import { javascriptTestCacheStats } from "./suite.mjs";
import { TASKS, neededContextFor } from "./tasks.mjs";
import { estimateTune, expectedAnswers, normalizeSteps, settingNames, timeLeft } from "./tune-grid.mjs";
import { BUILTIN_DESCRIPTORS, createEngineCatalog, engineContext, loadEnginePlugin } from "../src/engine-catalog.js";
import { assessEngines, createEngineRegistry, defaultEngines, deviceBackendsFrom, externalEngineFor, externalSetFrom, formatAssessment } from "../src/inference-engines.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { openTarget, runTune, summary } from "./tune-job.mjs";
import { STAGES } from "./tune.mjs";
import { askSteps } from "./tune-prompt.mjs";
import { parseBudget } from "./tune-budget.mjs";
import { formatFailures } from "./tune-failures.mjs";
import { parseParallel } from "./tune-parallel.mjs";
import { formatTiming } from "./tune-timing.mjs";

const USAGE = `Usage: npm run tune -- --model <catalogId|file.gguf> [options]

Finds the best load settings for one installed model, then the best sampling
settings for each task, and saves them as that model's profile. A saved
profile is reused: only tasks it lacks are tuned, and a profile measured on an
older test, runtime, CPU or model file is kept with a warning until --force.

  --model <id>       catalog id or installed file name (required)
  --tasks <list>     comma-separated subset of ${TASKS.map((task) => task.id).join(",")}
  --settings <list>  tune only these settings, even if tuned before, e.g. threads,batchSize
                     (names: ${settingNames().join(",")})
  --stages <list>    comma-separated subset of ${STAGES.join(",")} (in this order); a saved
                     profile keeps finished stages, and untuned settings stay default
  --max-runs <n>     stop after this many item answers (default 20000)
  --passes <n>       coordinate-descent passes per stage (default 2)
  --force            re-tune even when a saved profile already covers the tasks;
                     starts a new profile, so other stages are measured again
  --grid <file>      step lists to search (default: <home>/tune-grid.json, else built-in)
  --interactive      ask for every setting's steps first and save them to <home>/tune-grid.json
  --engines          the start of the device (CPU/GPU) stage: time every inference engine on this
  --no-engines       model (in-process CPU, Vulkan, CUDA and Metal; every installed llama.cpp
                     variant; Ollama; servers attached with --openai-engine) and print prompt and
                     generation tokens/s with each engine's version. On by default whenever the
                     device stage runs; --no-engines skips it. The device stage then tries every
                     in-process backend that measured (unless your tune-grid.json names backends),
                     and llama-server, Ollama and attached servers also answer its items, so their
                     speed and accuracy are judged like a GPU's. The tune is built on the fastest accurate
                     engine the app can start itself (the in-process runtime, llama-server, Ollama):
                     every later stage runs on it, the profile names it and the app serves through it.
                     An attached server is measured only. Saved beside the profile as <model>.engines.json. Install the llama.cpp builds with
                     npm run engines:install.
  --llama-bench <f>  a native llama.cpp llama-bench binary to include (times only)
  --llama-server <f> a llama.cpp llama-server binary of your own (for example an ik_llama.cpp build)
  --ollama-model <t> the Ollama model to use (default: a tag matching the file)
  --engine-plugin <file>  add an engine from a JS module that exports its descriptor (see src/engine-catalog.js);
                     repeat for several
  --openai-engine <name=url[#model]>  attach a running OpenAI-compatible server (vLLM, SGLang, TGI,
                     mistral.rs, koboldcpp, llamafile, LM Studio...); repeat for several. A key, if
                     it needs one, is read from MODELDUCK_ENGINE_KEY.
  --home <folder>    data folder that receives profiles/<model>.json
  --models-dir <dir> models folder
  --events           JSON progress lines on stdout (used by the app)
  --continue         finish an unfinished run: measure only what is not done yet
  --restore-budget   replay saved answers newest-first under hard caps of 20000 rows,
                     32 MiB and 4 files instead of the default three newest runs
  --quick            provisional first-rung pass; the app follows it with a full continue
  --guard            stop the remaining tasks when a held-back check falls back (full pass only; a quick pass presets first and guards on its full continue)
  --full-final       score each final preset on every task item, not only the last search rung (slower, higher power)
  --parallel <n|auto> answer up to n items at once in the untimed stages (1-4, default 1). A probe first
                     checks that wide answers match one-at-a-time answers byte for byte, and falls
                     back to one at a time if they differ. Needs the device already chosen: run
                     --stages device first, then the other stages with --parallel.
  --budget <minutes> stop asking new answers after this many minutes (decimals allowed); what
                     was found is saved and --continue finishes the rest later
  --escalate         when a setting beats the current one on the search rung but misses the
                     gate, test it once more alone on pool items the search never used, and
                     keep it only if it wins there (one-sided paired test). More answers, more power.
  --adaptive         experimental (ADR-188): after one warm-up sweep per task, search each task on the
                     items that told settings apart per second of answer time (plus a small random
                     check), and test a setting that looks ahead on the whole rung before it may win.
                     Aims at a much faster tune; check the result against a normal tune first.
`;

function parseArgs(argv) {
  const options = { tasks: TASKS.map((task) => task.id), stages: [...STAGES] };
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
    else if (arg === "--events") options.events = true;
    else if (arg === "--continue") options.continueRun = true;
    else if (arg === "--restore-budget") options.restoreBudget = true;
    else if (arg === "--quick") options.quick = true;
    else if (arg === "--guard") options.guard = true;
    else if (arg === "--full-final") options.fullFinal = true;
    else if (arg === "--parallel") options.parallel = parseParallel(take(index++, arg));
    else if (arg === "--budget") options.budget = parseBudget(take(index++, arg));
    else if (arg === "--escalate") options.escalate = true;
    else if (arg === "--adaptive") options.adaptive = true;
    else if (arg === "--engines") options.engines = true;
    else if (arg === "--no-engines") options.engines = false;
    else if (arg === "--engine-plugin") (options.enginePlugins ??= []).push(take(index++, arg));
    else if (arg === "--openai-engine") (options.openai ??= []).push(take(index++, arg));
    else if (arg === "--llama-bench") options.llamaBench = take(index++, arg);
    else if (arg === "--llama-server") options.llamaServer = take(index++, arg);
    else if (arg === "--ollama-model") options.ollamaModel = take(index++, arg);
    else if (arg === "--force") options.force = true;
    else if (arg === "--interactive") options.interactive = true;
    else if (arg === "--grid") options.grid = take(index++, arg);
    else if (arg === "--model") options.model = take(index++, arg);
    else if (arg === "--settings") options.only = take(index++, arg).split(",").map((name) => name.trim()).filter(Boolean);
    else if (arg === "--stages") options.stages = take(index++, arg).split(",").map((stage) => stage.trim()).filter(Boolean);
    else if (arg === "--tasks") options.tasks = take(index++, arg).split(",").map((task) => task.trim()).filter(Boolean);
    else if (arg === "--max-runs") options.maxRuns = Number(take(index++, arg));
    else if (arg === "--passes") options.passes = Number(take(index++, arg));
    else if (arg === "--home") options.home = take(index++, arg);
    else if (arg === "--models-dir") options.modelsDir = take(index++, arg);
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not a tune option.`, fix: USAGE });
  }
  return options;
}

const log = (options, text) => (options.events ? process.stderr : process.stdout).write(`${text}\n`);
const emit = (options, event) => options.events && process.stdout.write(`${JSON.stringify(event)}\n`);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.model) {
    process.stdout.write(USAGE);
    process.exitCode = options.help ? 0 : 2;
    return;
  }
  const unknown = options.tasks.filter((task) => !TASKS.some((item) => item.id === task));
  if (unknown.length) throw new AppError("Unknown task", { code: "unknown_task", why: `Unknown task: ${unknown.join(", ")}.`, fix: USAGE });
  const badSettings = (options.only ?? []).filter((name) => !settingNames().includes(name));
  if (badSettings.length) throw new AppError("Unknown setting", { code: "unknown_task", why: `Unknown setting: ${badSettings.join(", ")}.`, fix: USAGE });
  const badStages = options.stages.filter((stage) => !STAGES.includes(stage));
  if (badStages.length) throw new AppError("Unknown stage", { code: "unknown_task", why: `Unknown stage: ${badStages.join(", ")}.`, fix: USAGE });

  if (options.events) {
    // Started by the app: stop if the app is gone, instead of running on unseen.
    watchParent({ onGone: () => {
      process.stderr.write("The app that started this tune has exited; stopping.\n");
      process.exit(1);
    } });
  }
  const target = await openTarget(options);
  // The context is fixed at the 16K floor; this tells the user what the
  // selected tasks need, so a larger real repository is not a surprise.
  log(options, `Tuning at the fixed 16384 context; these tasks' longest prompt needs about ${neededContextFor(options.tasks)} tokens before the answer budget.`);
  const loaded = await readSteps(options.grid ?? target.paths.tuneGrid);
  let steps = loaded.steps;
  if (options.interactive) {
    const saved = await writeSteps(target.paths.tuneGrid, await askSteps(steps));
    steps = saved.steps;
    log(options, `Saved your steps to ${target.paths.tuneGrid}`);
  }
  for (const problem of normalizeSteps(steps).problems.concat(loaded.problems)) log(options, `Steps: ${problem}`);
  // What engines exist is the catalog's business (ADR-160); plugins add to it. The resolver is always set, so a saved
  // profile that names an engine starts it (or fails loudly) even on a run that never tests engines.
  const catalog = createEngineCatalog({ descriptors: [...BUILTIN_DESCRIPTORS, ...await Promise.all((options.enginePlugins ?? []).map(loadEnginePlugin))] });
  const engineOptions = { catalog, llamaBench: options.llamaBench ?? null, llamaServer: options.llamaServer ?? null, ollamaModel: options.ollamaModel ?? null, openai: options.openai ?? [], openaiKey: process.env.MODELDUCK_ENGINE_KEY ?? null };
  target.resolveEngine = (id) => externalEngineFor(id, { ...engineOptions, registry: target.registry });
  target.engineVersionOf = (id) => catalog.version(id, engineContext({ ...engineOptions, registry: target.registry }));
  // The engine speed test opens the device stage, so it runs whenever that stage does, unless turned off.
  if (options.engines ?? options.stages.includes("device")) {
    // Every engine is timed on this model before the tune starts, one after another, so none competes for the cores.
    const registry = createEngineRegistry({ engines: defaultEngines(engineOptions) });
    const assessment = await assessEngines({ registry, entry: target.entry, runs: 2, onProgress: ({ engine, stage }) => emit(options, { type: "engines-progress", phase: "tune", engine, stage }) });
    log(options, formatAssessment(assessment));
    // Backends the user named in their own steps win over what was detected.
    const backends = loaded.custom ? steps.device.backends : deviceBackendsFrom(assessment);
    steps = { ...steps, device: { ...steps.device, backends } };
    const external = externalSetFrom(assessment, { ...engineOptions, registry: target.registry });
    target.externalEngines = external.engines;
    target.externalCandidates = external.candidates;
    target.servableEngines = external.servable;
    const engineNames = [...new Set(external.candidates.map((candidate) => candidate.engine))];
    log(options, `Device stage will try: ${backends.join(", ")}${engineNames.length ? `, and the engines ${engineNames.join(", ")}` : ""}. The tune is built on the fastest accurate one${external.servable.length ? "; ModelDuck will serve through it" : ""}.`);
    await writeJsonAtomic(path.join(target.paths.profiles, `${target.profileId}.engines.json`), { assessedAt: new Date().toISOString(), ...assessment });
    emit(options, { type: "engines", phase: "tune", model: target.profileId, fastest: assessment.fastest, results: assessment.results });
  }
  const estimate = estimateTune(steps, { logicalCores: target.system.parallelism, tasks: options.tasks, stages: options.stages, only: options.only ?? null, quick: Boolean(options.quick) });
  // The time left comes from the answers this run asks and its own measured pace (ADR-045).
  const expected = expectedAnswers(steps, { logicalCores: target.system.parallelism, tasks: options.tasks, stages: options.stages, only: options.only ?? null, quick: Boolean(options.quick) });
  log(options, `This run asks at most ${expected} answers in one pass; the time left shows once the first answers are measured.`);
  emit(options, { type: "estimate", phase: "tune", model: target.profileId, expectedAnswers: expected, ...estimate });
  let startedAt = Date.now();
  const outcome = await runTune(target, {
    tasks: options.tasks,
    stages: options.stages,
    only: options.only ?? null,
    steps,
    force: options.force,
    continueRun: Boolean(options.continueRun),
    quick: Boolean(options.quick),
    guard: Boolean(options.guard),
    fullFinal: Boolean(options.fullFinal),
    parallel: options.parallel ?? 1,
    budgetMinutes: options.budget ?? null,
    escalate: Boolean(options.escalate),
    adaptive: Boolean(options.adaptive),
    restoreBudget: Boolean(options.restoreBudget),
    onNote: (message) => log(options, message),
    maxRuns: options.maxRuns,
    passes: options.passes,
    onStart: (plan) => {
      startedAt = Date.now();
      log(options, `Tuning ${target.entry.fileName}: ${options.stages.join(" → ")} for ${options.tasks.join(", ")}${plan.resume ? ", resuming the saved progress" : ""} on ${target.system.cpu} (${target.system.parallelism} threads)`);
      emit(options, { type: "start", phase: "tune", model: target.profileId, tasks: options.tasks, stages: options.stages, resumed: Boolean(plan.resume) });
    },
    onEvent: (event) => {
      const where = `[${event.stage}${event.task ? `:${event.task}` : ""}]`;
      const eta = timeLeft({ answers: event.runs, expected, elapsedMs: Date.now() - startedAt });
      if (eta) event = { ...event, eta };
      if (event.type === "candidate") {
        log(options, `${where} ${event.axis} ${JSON.stringify(event.patch)} @${event.rung}: ${event.rate}% · ${event.latencyMs} ms · ${event.runs} answers${eta ? ` · ${eta}` : ""}`);
      } else {
        log(options, `${where} pass ${event.pass} ${event.axis} -> ${JSON.stringify(event.winner)}${event.changed ? " (changed)" : ""}${event.kept ? ` — ${event.kept}` : ""}${event.reason ? ` — ${event.reason}` : ""}`);
      }
      emit(options, { ...event, type: `tune-${event.type}`, phase: "tune" });
    },
  });
  for (const warning of outcome.warnings) log(options, `Warning: ${warning}`);
  if (outcome.skipped) {
    log(options, `${target.profileId} is already tuned for ${options.tasks.join(", ")}; using the saved profile. Pass --force to re-tune.`);
    log(options, summary(outcome.profile));
    emit(options, { type: "complete", phase: "tune", model: target.profileId, skipped: true, warnings: outcome.warnings });
    return;
  }
  log(options, summary(outcome.profile, outcome.result));
  const verifierCache = javascriptTestCacheStats();
  log(options, `Verifier cache: ${verifierCache.hits} hits / ${verifierCache.misses} checks run (${verifierCache.size} entries)`);
  if (outcome.timing) log(options, formatTiming(outcome.timing));
  const failureReport = outcome.failures ? formatFailures(outcome.failures) : "";
  if (failureReport) log(options, failureReport);
  log(options, `Saved ${path.join(target.paths.profiles, `${target.profileId}.json`)}`);
    emit(options, { type: "complete", phase: "tune", model: target.profileId, tasks: Object.keys(outcome.profile.tasks), runs: outcome.result.runs, budgetExhausted: outcome.result.budgetExhausted, timeExhausted: Boolean(outcome.result.timeExhausted), quick: Boolean(options.quick), guard: outcome.result.guard ?? null });
}

// A CLI, not a library: importing this module must not start a tune
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
    process.exitCode = error.code === "bad_option" || error.code === "unknown_task" ? 2 : 1;
  });
}
