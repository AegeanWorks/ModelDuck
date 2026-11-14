import path from "node:path";

import { DEFAULT_SETTINGS, resolvePaths } from "../src/config.js";
import { LlamaEngine } from "../src/engine.js";
import { AppError } from "../src/errors.js";
import { getCatalogModel } from "../src/model-catalog.js";
import { currentFingerprint, loadProfile, measuredOnAfter, measuredUnderAfter, planTune, profileFromTune, profileIdFor, saveProfile } from "../src/model-profiles.js";
import { createModelRegistry } from "../src/model-registry.js";
import { systemInfo } from "../src/system.js";
import { createTimingLock } from "../src/tune-lock.js";
import { readSteps } from "../src/tune-steps.js";
import { cachedAnswers, itemOutcomes, startRun } from "../src/tune-runs.js";
import { PROMPTS, SYSTEM_PROMPT } from "./suite.mjs";
import { codeGroupOf, taskIdOfCategory, tuneRungs, withDiscriminatingRungs } from "./tasks.mjs";
import { STAGES, resultFrom, tune } from "./tune.mjs";
import { expectedAnswers, promptAxes, qualityAxes, quickRungs, samplingAxes, speedAxes } from "./tune-grid.mjs";
import { createEvaluator } from "./tune-evaluate.mjs";
import { budgetDeadline } from "./tune-budget.mjs";
import { summarizeFailures } from "./tune-failures.mjs";
import { PROBE_ITEMS, chooseParallel, probeItemIds, probeParallel } from "./tune-parallel.mjs";
import { createPhaseTimer } from "./tune-timing.mjs";

/** One installed model, ready to tune or measure: where it is, its profile name and what it runs on. */
export async function openTarget({ model, home, modelsDir }) {
  const paths = resolvePaths({ home, models: modelsDir });
  const registry = createModelRegistry({ modelsDir: paths.models });
  const fileName = (getCatalogModel(model)?.file ?? model).toLowerCase();
  const wanted = (file, { id }) => id === model || path.basename(file).toLowerCase() === fileName;
  // Read only the requested model's metadata: a full scan of a large library cost seconds per process.
  await registry.scan({ only: wanted });
  const match = registry.listPublic().find((item) => item.id === model || path.basename(item.fileName).toLowerCase() === fileName);
  if (!match) {
    throw new AppError("That model is not installed", {
      code: "tune_model_missing",
      why: `No installed model matches "${model}".`,
      fix: "Install it from Models → Discover, or pass the catalog id or file name of an installed model.",
    });
  }
  const entry = registry.findById(match.id);
  const system = systemInfo();
  return { paths, registry, entry, profileId: profileIdFor(entry.fileName), system, fingerprint: await currentFingerprint(entry, { system }) };
}

/** Run `fn(engine)` on a fresh engine and always release the model. */
export async function withEngine(target, fn) {
  const engine = new LlamaEngine({ registry: target.registry });
  try {
    return await fn(engine);
  } finally {
    await engine.unload().catch(() => {});
    await engine.dispose().catch(() => {});
  }
}

const CATEGORY_OF = new Map(PROMPTS.map((prompt) => [prompt.id, prompt.category]));
const TASK_OF = new Map(PROMPTS.map((prompt) => [prompt.id, taskIdOfCategory(prompt.category)]));
// Function and codebase ids for the cluster-aware guards (S4): comprehension
// prompts carry their function, other items fall back to per-item clusters.
const CLUSTER_OF = new Map(PROMPTS.map((prompt) => [prompt.id, prompt.group ?? null]));

/** Where every tune starts and every gate measures from: app defaults, answering like the benchmark (suite system prompt, reasoning off). */
export function tuneBase() {
  const { systemPrompt: _systemPrompt, ...defaults } = DEFAULT_SETTINGS;
  return { ...defaults, systemPrompt: SYSTEM_PROMPT, reasoning: "off", promptRepeat: 1 };
}

/** A provisional pass: the first rung of each task and stage, with no held-back check yet. */

/**
 * One answer as the run record stores it. `parallel` is the width the call
 * really ran at (absent when serial, as serial rows always were), and
 * `tuneParallel` the width the tune asked for (absent for a serial tune), so
 * cachedAnswers can give a serial tune every serial answer, including the
 * speed stage and narrowed calls of a wide tune.
 */
export function answerRow(settings, seed, answer, tuneWidth = 1) {
  const callWidth = answer.width ?? tuneWidth;
  return {
    settings, seed, item: answer.id, passed: answer.passed, total: answer.total, ms: answer.ms ?? null,
    outputTokens: answer.outputTokens ?? null, tokensPerSecond: answer.tokensPerSecond ?? null, digest: answer.digest ?? null, error: answer.error ?? null,
    unreadable: Boolean(answer.unreadable), text: answer.text ?? null,
    stopReason: answer.stopReason ?? null, promptTokens: answer.promptTokens ?? null, firstTokenMs: answer.firstTokenMs ?? null,
    ...(callWidth > 1 && { parallel: callWidth }),
    ...(tuneWidth > 1 && { tuneParallel: tuneWidth }),
    failure: answer.failure ?? null,
  };
}

/**
 * Tune a target in stages, reusing its saved profile (ADR-028, ADR-030).
 * The profile is saved after every finished setting, so stopping keeps what
 * was found and a later run resumes. Resolves `{ skipped, warnings, profile, result }`.
 */
export async function runTune(target, { tasks, stages = STAGES, only = null, steps = null, force = false, continueRun = false, quick = false, guard = false, fullFinal = false, maxRuns = 0, passes = 0, parallel: requestedParallel = 1, budgetMinutes = null, escalate = false, onEvent = () => {}, onStart = () => {}, onNote = () => {} }) {
  const saved = force ? null : await loadProfile(target.paths.profiles, target.profileId, target.fingerprint);
  const plan = planTune(saved, tasks, stages, only, { continueRun });
  const warnings = saved?.warnings ?? [];
  if (plan.skip) return { skipped: true, warnings, profile: saved.profile, result: null };
  const baseline = Object.fromEntries(Object.entries(saved?.profile?.tasks ?? {})
    .map(([task, preset]) => [task, preset?.stats?.rate])
    .filter(([, rate]) => Number.isFinite(rate)));
  onStart(plan);
  const base = tuneBase();
  const logicalCores = target.system.parallelism;
  const used = steps ?? (await readSteps(target.paths.tuneGrid)).steps;
  // Items no recorded setting has flipped cannot separate settings for this model, so the
  // search leaves them out; the final check keeps the whole set (ADR-064, S6).
  const { saturated } = await itemOutcomes(target.paths.tuneRuns, { profileId: target.profileId, fingerprint: target.fingerprint });
  // Public coding items may be in the model's training data: they stay in the final check and
  // the gate, but the search is chosen on ModelDuck's own code items (ADR-070).
  for (const prompt of PROMPTS) if (prompt.category === "public-code") saturated.add(prompt.id);
  // A rotating 10% of saturated items is re-admitted each tune, so drift is caught (S6).
  const { rungs, tunedOn } = withDiscriminatingRungs(tuneRungs(tasks), saturated, tasks, { salt: target.profileId });
  const activeRungs = quick ? quickRungs(rungs, tasks) : rungs;
  const save = async (result) => {
    const measuredUnder = measuredUnderAfter(saved, target.fingerprint, result.stages, plan.rerun ?? []);
    const measuredOn = measuredOnAfter(saved, result.stages, plan.rerun ?? [], result.load.settings.gpuBackend ?? "cpu");
    const profile = profileFromTune({ ...result, steps: used }, { catalogId: target.profileId, fingerprint: target.fingerprint, measuredUnder, measuredOn });
    await saveProfile(target.paths.profiles, profile);
    return profile;
  };
  // Tunes running side by side pause while one of them times something (ADR-033).
  const lock = createTimingLock({ dir: path.join(target.paths.home, "tune-lanes") });
  await lock.register();
  // Even if the process is stopped mid-tune, its registration must not linger.
  const cleanUp = () => lock.unregisterSync();
  process.once("exit", cleanUp);
  // Without a device probe this run, the tune starts on the saved device; a GPU that cannot
  // start stops it here, in a second, instead of after a round of failed answers (ADR-044).
  const probes = stages.includes("device") && (!only?.length || only.includes("device"));
  const startOn = plan.resume?.device?.settings?.gpuBackend ?? saved?.profile.load?.settings?.gpuBackend ?? base.gpuBackend ?? "cpu";
  // A continue or re-tune reuses exact settings/seed/item matches from earlier answers (G8).
  // Which ones is known once the width is: answers made at another width are never mixed in.
  let restore = [];
  let width = 1;
  let parallelInfo = { requested: requestedParallel, used: 1, reason: null, probe: null };
  // Every run is recorded with every answer, whatever its outcome (ADR-050).
  const run = await startRun(target.paths.tuneRuns, {
    profileId: target.profileId,
    model: target.entry.fileName,
    request: { stages, tasks, only, force, continueRun, quick, guard, maxRuns, passes, parallel: requestedParallel, budgetMinutes, escalate, rerun: plan.rerun ?? [] },
    fingerprint: target.fingerprint,
    expectedAnswers: expectedAnswers(used, { logicalCores, tasks, stages, only, quick }),
  });
  const earlierSweeps = plan.resume?.sweeps?.length ?? 0;
  const earlierAnswers = plan.resume?.runs ?? 0;
  const snapshot = (state) => {
    const result = resultFrom(state, { tunedOn });
    return { answers: state.runs - earlierAnswers, sweeps: state.sweeps.slice(earlierSweeps), result: { load: result.load, speed: result.speed, device: result.device, tasks: result.tasks, stages: result.stages } };
  };
  const onAnswers = (settings, seed, answers) => {
    void run.answers(answers.map((answer) => answerRow(settings, seed, answer, width)));
    for (const answer of answers) fresh.push({ task: TASK_OF.get(answer.id) ?? null, failure: answer.failure });
  };
  // Answers measured by this process (not restored), for the failure report.
  const fresh = [];
  let lastState = null;
  // The time budget starts here, so the model load and any probe count against it.
  const deadline = budgetDeadline(budgetMinutes);
  // Where this process spends its wall-clock time; stored with the run and printed at the end.
  const timer = createPhaseTimer();
  const result = await withEngine(target, async (engine) => {
    if (!probes && startOn !== "cpu") {
      await engine.startBackend(startOn).catch((error) => {
        throw new AppError("The tune did not start: the GPU could not start", {
          code: "tune_gpu_failed",
          why: error.why ?? error.message,
          fix: "Restart the computer or update the GPU driver, or run the Device stage again to fall back to the CPU. Nothing was measured or saved.",
        });
      });
    }
    const evaluate = createEvaluator({ engine, modelId: target.entry.id, beforeAnswer: () => lock.pauseIfNeeded(), timer });
    if (requestedParallel !== 1) {
      const decision = chooseParallel({ requested: requestedParallel, logicalCores });
      parallelInfo = { requested: requestedParallel, used: 1, reason: decision.reason, probe: null };
      if (probes) {
        // The device chosen mid-run could differ from the one probed, so the probe waits for a known device.
        parallelInfo.reason = "the device stage runs in this process, so the backend is not chosen yet; run --stages device first, then the other stages with --parallel";
      } else if (decision.n > 1) {
        const settings = { ...base, gpuBackend: startOn, temperature: 0, repeatPenalty: 1, maxTokens: 96 };
        const ids = probeItemIds({ ids: tasks.flatMap((task) => activeRungs[task]?.[0] ?? []), width: decision.n, limit: PROBE_ITEMS, settings });
        // Greedy and sampled: the sampling and prompt stages answer above temperature 0.
        parallelInfo.probe = await probeParallel({ evaluate, width: decision.n, items: ids, settings, sampled: { temperature: 0.7 }, seed: 42 });
        if (parallelInfo.probe.ok) {
          width = decision.n;
          parallelInfo.used = width;
        } else {
          parallelInfo.reason = parallelInfo.probe.reason;
        }
      }
      onNote(width > 1
        ? `Parallel: answering ${width} at a time in the untimed stages (${parallelInfo.probe.speedup}× faster on the probe, ${parallelInfo.probe.matched} of ${parallelInfo.probe.total} answers byte-identical). Their latency figures are concurrent, not serial; the speed stage still times one answer at a time.`
        : `Parallel: answering one at a time, because ${parallelInfo.reason}.`);
    }
    restore = await cachedAnswers(target.paths.tuneRuns, { profileId: target.profileId, fingerprint: target.fingerprint, parallel: width }).catch(() => []);
    return tune({
      parallel: width,
      evaluate,
      // Question types, so each task's result is broken down (ADR-056), and coding views for the balance rule (ADR-070).
      typeOf: (id) => CATEGORY_OF.get(id) ?? null,
      groupOf: (id) => codeGroupOf(CATEGORY_OF.get(id)),
      itemTask: (id) => TASK_OF.get(id) ?? null,
      clusterOf: (id) => CLUSTER_OF.get(id) ?? null,
      // Long-context KV confirmation items (M6): searched never.
      longContext: PROMPTS.filter((prompt) => prompt.longContext).map((prompt) => ({ id: prompt.id, estTokens: Math.ceil(prompt.prompt.length / 4) })),
      timing: { acquire: () => lock.acquire(), release: () => lock.release() },
      base,
      tasks,
      stages,
      only,
      quick,
      guard,
      fullFinal,
      baseline,
      resume: plan.resume,
      rungs: activeRungs,
      tunedOn,
      restore,
      hardware: { logicalCores },
      deviceBackends: used.device.backends,
      modelLayers: target.entry.kvShape?.layers ?? 0,
      qualityAxes: qualityAxes(used.load),
      speedAxes: speedAxes({ logicalCores }, used.load),
      samplingAxes: (task) => samplingAxes(task, used.sampling),
      promptAxes: (task) => promptAxes(used.prompt, task),
      options: { ...(maxRuns > 0 && { maxRuns }), ...(passes > 0 && { passes }), ...(Number.isFinite(deadline) && { deadline }), ...(escalate && { escalate: true }) },
      onEvent,
      onAnswers,
      onProgress: async (state) => {
        lastState = state;
        await save(resultFrom(state, { tunedOn }));
        await run.update(snapshot(state));
      },
    });
  }).catch(async (error) => {
    await run.finish({ outcome: "failed", error: error.why ?? error.message, timing: timer.summary(), parallel: parallelInfo, ...(lastState && snapshot(lastState)) });
    throw error;
  }).finally(() => {
    process.off("exit", cleanUp);
    return lock.unregister();
  });
  const timing = timer.summary();
  const failures = summarizeFailures(fresh);
  await run.finish({ outcome: result.stopped ? "stopped" : "done", error: result.stopped ?? null, timing, parallel: parallelInfo, failures, ...snapshot({ ...result.progress, sweeps: result.sweeps, runs: result.runs }) });
  // A tune that could not load the model at all has nothing to save; what earlier axes found is already saved.
  if (result.stopped) {
    throw new AppError("The tune stopped: the model could not be loaded", {
      code: "tune_load_failed",
      why: result.stopped,
      fix: "Check the GPU driver and free memory (a restart often clears a stuck GPU), or pick the CPU backend, then run the tune again. Results saved before this point are kept.",
    });
  }
  return { skipped: false, warnings, profile: await save(result), result, timing, parallel: parallelInfo, failures };
}

const shown = (value) => (typeof value === "string" && value.length > 48 ? `"${value.slice(0, 45)}…"` : typeof value === "string" ? `"${value}"` : value);
const line = (settings) => Object.entries(settings).map(([key, value]) => `${key}=${shown(value)}`).join(" ") || "(defaults)";

/** Terse report: how far each stage got, the load and speed presets, and each task's rate with its 95% CI. */
export function summary(profile, result = null) {
  const stages = profile.stages ?? {};
  const perTask = (entry) => Object.entries(entry ?? {}).map(([task, status]) => `${task} ${status}`).join(", ") || "pending";
  const lines = [
    `Stages: device ${stages.device ?? "pending"} · quality ${stages.quality ?? "pending"} · speed ${stages.speed ?? "pending"} · sampling ${perTask(stages.sampling)} · prompt ${perTask(stages.prompt)}`,
    `Load: ${line(profile.load.settings)}`,
  ];
  if (profile.device) lines.push(`Device: ${profile.device.reason}`);
  if (profile.speed) lines.push(`Speed presets: Fastest ${line(profile.speed.fastest)} · Light ${profile.speed.light ? line(profile.speed.light) : "(unavailable: no thread count qualified)"}${profile.speed.quiet ? ` · Quiet ${line(profile.speed.quiet)}` : ""}`);
  for (const [task, preset] of Object.entries(profile.tasks)) {
    const stats = preset.stats;
    const delta = stats?.vsDefault ? ` (${stats.vsDefault.rateDelta >= 0 ? "+" : ""}${stats.vsDefault.rateDelta} pts vs defaults, p=${stats.vsDefault.pValue})` : "";
    lines.push(`${task.padEnd(6)} ${stats ? `${stats.rate}% [${stats.ci95.low}-${stats.ci95.high}] · ${stats.outputTokens ?? "?"} tokens/answer` : "in progress"}${delta}`);
    lines.push(`       ${line(preset.settings)}`);
  }
  if (result) {
    const why = result.timeExhausted ? " (time budget reached; the best settings so far are saved, --continue finishes the rest)"
      : result.budgetExhausted ? " (run budget reached; resume to continue)" : "";
    lines.push(`${result.runs} item answers${why}`);
  }
  return lines.join("\n");
}
