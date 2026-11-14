import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { AppError } from "./errors.js";
import { writeJsonAtomic } from "./fs-atomic.js";
import { readSteps } from "./tune-steps.js";

const SCRIPT = fileURLToPath(new URL("../benchmarks/tune-run.mjs", import.meta.url));
const ALL_STAGES = Object.freeze(["device", "quality", "speed", "sampling", "prompt"]);
const LOG_LINES = 12;
// Matches the tuner's --budget limit (benchmarks/tune-budget.mjs).
const MAX_BUDGET_MINUTES = 1440;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tunes several models side by side (ADR-033). Device probes run one at a
 * time first, since they time answers; then each model's remaining stages run
 * in its lane — CPU or GPU, from its probe — with the lane counts from the
 * user's tune settings. Speed stages inside those tunes take a timing lock so
 * the others pause (src/tune-lock.js).
 */
export class TuneScheduler {
  #homeDir;
  #modelsDir;
  #scriptPath;
  #spawn;
  #readLanes;
  #readLane;
  #logger;
  #queueFile;
  #queueWrite = Promise.resolve();
  #job = null;
  #children = new Set();
  #listeners = new Set();
  #clock;

  constructor({ homeDir, modelsDir, profilesDir = null, tuneStepsFile = null, queueFile = null, scriptPath = SCRIPT, spawnImpl = spawn, readLanes = null, readLane = null, logger = console, clock = Date.now }) {
    this.#clock = clock;
    this.#homeDir = homeDir;
    this.#modelsDir = modelsDir;
    this.#scriptPath = scriptPath;
    this.#spawn = spawnImpl;
    this.#readLanes = readLanes ?? (async () => (await readSteps(tuneStepsFile)).steps.lanes);
    this.#readLane = readLane ?? ((model) => laneFromProfile(profilesDir, model));
    this.#logger = logger;
    this.#queueFile = queueFile;
  }

  /** Call `listener` after every change to the job; returns the function that stops it (ADR-055). */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.warn?.(`[modelduck] Tune listener failed: ${error?.message ?? error}`);
      }
    }
  }

  get() {
    if (!this.#job) return null;
    return { ...this.#job, items: this.#job.items.map((item) => ({ ...item, log: [...item.log] })) };
  }

  /** Start tuning `models` ([{ id, fileName, profileId, name }]); resolves immediately with the job. */
  start({ models, tasks = null, stages = null, settings = null, force = false, continueRun = false, quick = false, guard = false, guardQueue = false, budgetMinutes = null }) {
    const budget = budgetMinutes == null ? null : Number(budgetMinutes);
    if (budget !== null && !(Number.isFinite(budget) && budget > 0 && budget <= MAX_BUDGET_MINUTES)) {
      throw new AppError("The time budget must be a number of minutes", {
        code: "tune_budget_invalid",
        status: 400,
        why: `"${budgetMinutes}" is not a number of minutes above 0 and up to ${MAX_BUDGET_MINUTES}.`,
        fix: "Enter minutes per model, such as 5, or leave the budget empty for no limit.",
      });
    }
    if (this.#job?.status === "running" || this.#job?.paused) {
      throw new AppError("A tune is already running", {
        code: "tune_in_progress",
        status: 409,
        why: "ModelDuck schedules one set of tunes at a time so lanes and timing stay fair.",
        fix: "Wait for it to finish, resume or cancel it first.",
      });
    }
    const wanted = (stages?.length ? stages : ALL_STAGES).filter((stage) => ALL_STAGES.includes(stage));
    this.#job = {
      id: randomUUID(),
      status: "running",
      paused: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stages: wanted,
      tasks: tasks?.length ? [...tasks] : null,
      settings: settings?.length ? [...settings] : null,
      force: Boolean(force),
      continueRun: Boolean(continueRun),
      quick: Boolean(quick),
      guard: Boolean(guard),
      guardQueue: Boolean(guardQueue),
      // Minutes each model may tune for; its processes share them (null: no limit).
      budgetMinutes: budget,
      order: models.map((model) => model.profileId),
      items: models.map((model) => ({
        id: model.id, profileId: model.profileId, name: model.name ?? model.profileId, fileName: model.fileName,
        force: Boolean(model.force),
        lane: null, phase: null, status: "queued", progress: null, exitCode: null, error: null, guard: null, provisional: false, log: [], live: emptyLive(),
      })),
    };
    const job = this.#job;
    this.#writeQueue();
    this.#run(job, models).catch((error) => {
      this.#logger.warn?.(`[modelduck] Tune scheduler failed: ${error?.message ?? error}`);
      this.#finish(job, "failed");
    });
    this.#changed();
    return this.get();
  }

  cancel() {
    const job = this.#job;
    if (!job || !["running", "paused"].includes(job.status)) {
      throw new AppError("No tune is running", { code: "tune_not_running", status: 409, why: "There is nothing to stop.", fix: "Start a tune first." });
    }
    job.status = "cancelled";
    job.paused = false;
    job.finishedAt = new Date().toISOString();
    for (const item of job.items) if (item.status === "queued" || item.status === "running") item.status = "cancelled";
    for (const child of this.#children) child.kill();
    this.#writeQueue();
    this.#changed();
    return this.get();
  }

  /** Move one model earlier or later in the pending queue; a running model keeps its lane. */
  async move(profileId, direction) {
    const job = this.#job;
    if (!job || !["running", "paused"].includes(job.status)) {
      throw new AppError("No tune queue", { code: "tune_not_running", status: 409, why: "There is no queue to reorder.", fix: "Start a tune first." });
    }
    const order = job.order ?? job.items.map((item) => item.profileId);
    const index = order.indexOf(profileId);
    const target = index + (direction === "up" ? -1 : 1);
    const item = job.items.find((entry) => entry.profileId === profileId);
    if (index < 0 || item?.status !== "queued") {
      throw new AppError("Model not in the queue", { code: "tune_queue_model", status: 404, why: "That model is not waiting in this tune.", fix: "Pick a model that is still queued." });
    }
    if (target >= 0 && target < order.length) {
      [order[index], order[target]] = [order[target], order[index]];
      job.order = order;
      await this.#writeQueue();
      this.#changed();
    }
    return this.get();
  }

  /** Read a queue left by a stopped app. It comes back paused; Resuming starts it. */
  async restore() {
    if (!this.#queueFile || this.#job) return this.get();
    let saved;
    try {
      saved = JSON.parse(await fs.promises.readFile(this.#queueFile, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") this.#logger.warn?.(`[modelduck] Could not read the tune queue: ${error?.message ?? error}`);
      return null;
    }
    const job = saved?.schema === 1 ? saved.job : null;
    if (!job?.items?.length) return null;
    // A terminal queue was already finished, cancelled or guarded: it stays
    // that way instead of coming back as a paused queue on the next launch.
    if (!["running", "paused"].includes(job.status)) return null;
    this.#job = {
      ...job,
      status: "paused",
      paused: true,
      restored: true,
      continueRun: true,
      finishedAt: null,
      items: job.items.map((item) => ({
        ...item,
        status: item.status === "running" || item.status === "queued" ? "queued" : item.status,
        progress: null,
        provisional: false,
        log: [],
        live: emptyLive(),
      })),
    };
    this.#changed();
    return this.get();
  }

  async #writeQueue() {
    if (!this.#queueFile) return;
    const job = this.#job;
    if (!job || !["running", "paused"].includes(job.status)) {
      this.#queueWrite = this.#queueWrite.then(() => fs.promises.rm(this.#queueFile, { force: true })).catch(() => {});
      return this.#queueWrite;
    }
    const items = job.items.map(({ log: _log, live: _live, ...item }) => ({ ...item }));
    this.#queueWrite = this.#queueWrite.then(() => writeJsonAtomic(this.#queueFile, { schema: 1, job: { ...job, items } })).catch((error) => this.#logger.warn?.(`[modelduck] Could not save the tune queue: ${error?.message ?? error}`));
    return this.#queueWrite;
  }

  #ordered(job, models) {
    const order = job.order ?? models.map((model) => model.profileId);
    const rank = new Map(order.map((profileId, index) => [profileId, index]));
    return models
      .map((model, index) => ({ model, item: job.items[index] }))
      .sort((left, right) => (rank.get(left.model.profileId) ?? Infinity) - (rank.get(right.model.profileId) ?? Infinity));
  }

  #stopQueue(job, guard, keepChild = null) {
    if (job.status !== "running") return;
    job.status = "guarded";
    job.paused = false;
    job.finishedAt = new Date().toISOString();
    job.guard = guard;
    for (const item of job.items) {
      if (item.status === "queued" || item.status === "running") item.status = "cancelled";
    }
    for (const child of this.#children) if (child !== keepChild) child.kill();
    this.#writeQueue();
    this.#changed();
  }

  /** Stop between models; a running child finishes its whole invocation before the pause takes hold. */
  pause() {
    const job = this.#job;
    if (!job || job.status !== "running") {
      throw new AppError("No tune is running", { code: "tune_not_running", status: 409, why: "There is nothing to pause.", fix: "Start a tune first." });
    }
    job.paused = true;
    this.#writeQueue();
    this.#changed();
    return this.get();
  }

  resume() {
    const job = this.#job;
    if (!job || !["running", "paused"].includes(job.status)) {
      throw new AppError("No tune is running", { code: "tune_not_running", status: 409, why: "There is nothing to resume.", fix: "Start a tune first." });
    }
    if (job.status === "paused") {
      job.status = "running";
      job.paused = false;
      job.restored = false;
      const models = job.items.map((item) => ({ id: item.id, profileId: item.profileId, name: item.name, fileName: item.fileName, force: Boolean(item.force) }));
      this.#writeQueue();
      this.#run(job, models).catch((error) => {
        this.#logger.warn?.(`[modelduck] Tune scheduler failed: ${error?.message ?? error}`);
        this.#finish(job, "failed");
      });
    } else {
      job.paused = false;
      this.#writeQueue();
    }
    this.#changed();
    return this.get();
  }

  async #waitIfPaused(job) {
    while (job.paused && job.status === "running") await sleep(100);
  }

  dispose() {
    for (const child of this.#children) child.kill();
  }

  async #run(job, models) {
    const probe = job.stages.includes("device");
    const rest = job.stages.filter((stage) => stage !== "device");
    const forced = new Set();
    const forceOnce = (model) => {
      // Force applies to every model or only to those that ask for it (a stale profile).
      if (!(job.force || model.force) || forced.has(model.profileId)) return false;
      forced.add(model.profileId);
      return true;
    };
    if (probe) {
      for (const { model, item } of this.#ordered(job, models)) {
        if (item.status === "done" || item.status === "skipped" || item.status === "failed" || item.status === "cancelled") continue;
        await this.#waitIfPaused(job);
        if (job.status !== "running") return;
        await this.#runChild(job, item, model, ["device"], "device", forceOnce(model), rest.length > 0, { quick: job.quick });
      }
    }
    if (rest.length && job.status === "running") {
      const lanes = await this.#readLanes();
      const queues = { cpu: [], gpu: [] };
      for (const { model, item } of this.#ordered(job, models)) {
        if (item.status === "done" || item.status === "skipped" || item.status === "failed" || item.status === "cancelled") continue;
        item.lane = (await this.#readLane(model)) === "gpu" && lanes.gpu > 0 ? "gpu" : "cpu";
        queues[item.lane].push({ model, item });
      }
      const lane = async (queue) => {
        while (queue.length && job.status === "running") {
          await this.#waitIfPaused(job);
          if (job.status !== "running" || !queue.length) break;
          // The order can change while a model runs; take the first pending model in the current order.
          const rank = new Map((job.order ?? []).map((profileId, index) => [profileId, index]));
          queue.sort((left, right) => (rank.get(left.item.profileId) ?? Infinity) - (rank.get(right.item.profileId) ?? Infinity));
          const { model, item } = queue.shift();
          const ran = await this.#runChild(job, item, model, rest, "tune", forceOnce(model), false, { quick: job.quick });
          // A quick pass is saved immediately, then continued on the full rungs.
          if (ran && job.quick && job.status === "running" && item.status !== "failed" && item.status !== "cancelled") {
            await this.#waitIfPaused(job);
            if (job.status === "running" && this.#minutesLeft(job, item) !== null && this.#minutesLeft(job, item) <= 0) {
              // Out of time: the quick preset is saved and stays provisional until a later full tune.
              pushLog(item, `The ${job.budgetMinutes}-minute budget for this model is used up; the quick preset is saved and stays provisional. Run the tune again to finish it.`);
              this.#changed();
            } else if (job.status === "running") {
              await this.#runChild(job, item, model, rest, "tune", false, false, { quick: false, continueRun: true });
              // A continue that ran out of budget did not finish; its preset stays provisional.
              item.provisional = item.progress?.timeExhausted === true;
              this.#changed();
            }
          }
        }
      };
      const workers = [];
      for (let count = 0; count < lanes.cpu; count += 1) workers.push(lane(queues.cpu));
      for (let count = 0; count < lanes.gpu; count += 1) workers.push(lane(queues.gpu));
      await Promise.all(workers);
    }
    job.paused = false;
    this.#finish(job, job.status === "running" ? "complete" : job.status);
  }

  /**
   * Minutes this model has left of the job's per-model budget; null without a
   * budget. Only the model's own processes use it (`item.budgetUsedMs`), so
   * waiting for other models or sitting paused costs nothing, and a new job
   * starts with new items and the whole budget.
   */
  #minutesLeft(job, item) {
    if (job.budgetMinutes == null) return null;
    return job.budgetMinutes - (item.budgetUsedMs ?? 0) / 60_000;
  }

  /** Run one tune process for `item`; resolves true once it closed, false when none was started. */
  #runChild(job, item, model, stages, phase, force, more, { quick = false, continueRun = job.continueRun } = {}) {
    const left = this.#minutesLeft(job, item);
    if (left !== null && left <= 0) {
      pushLog(item, `The ${job.budgetMinutes}-minute budget for this model is used up before the ${phase === "device" ? "device probe" : "tune"}; what it saved so far stays. Run the tune again to finish it.`);
      Object.assign(item, { phase, status: "done" });
      this.#changed();
      return Promise.resolve(false);
    }
    const spawnedAt = this.#clock();
    return new Promise((resolve) => {
      const args = [this.#scriptPath, "--events", "--model", model.fileName, "--stages", stages.join(","), "--home", this.#homeDir];
      if (this.#modelsDir) args.push("--models-dir", this.#modelsDir);
      if (job.tasks) args.push("--tasks", job.tasks.join(","));
      if (job.settings) args.push("--settings", job.settings.join(","));
      if (force) args.push("--force");
      if (quick) args.push("--quick");
      if (continueRun) args.push("--continue");
      if (job.guard) args.push("--guard");
      if (left !== null) {
        // At least a few seconds, so a process started just before the end still saves what it has.
        args.push("--budget", String(Math.max(0.1, Math.round(left * 100) / 100)));
      }
      Object.assign(item, { phase, status: "running", progress: { type: "starting", stage: stages[0] }, exitCode: null });
      this.#changed();
      let child;
      try {
        child = this.#spawn(process.execPath, args, { cwd: path.dirname(this.#scriptPath), env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        Object.assign(item, { status: "failed", error: error.message });
        resolve();
        return;
      }
      this.#children.add(child);
      let skipped = false;
      const stdout = createInterface({ input: child.stdout });
      stdout.on("line", (line) => {
        const event = parseEvent(line);
        if (!event) return pushLog(item, line);
        item.progress = event;
        if (event.guard) item.guard = event.guard;
        if (event.guard && job.guardQueue) this.#stopQueue(job, event.guard, child);
        // A quick pass, or a tune stopped by its time budget, saved settings from an unfinished search.
        if (event.type === "complete" && (event.quick || event.timeExhausted)) item.provisional = true;
        followLive(item.live, event);
        if (event.type === "complete" && event.skipped) skipped = true;
        this.#changed();
      });
      createInterface({ input: child.stderr }).on("line", (line) => pushLog(item, line));
      let closed = false;
      child.on("close", (code) => {
        if (closed) return;
        closed = true;
        this.#children.delete(child);
        if (job.budgetMinutes != null) item.budgetUsedMs = (item.budgetUsedMs ?? 0) + Math.max(0, this.#clock() - spawnedAt);
        item.exitCode = code;
        if (job.status === "cancelled" || job.status === "guarded") item.status = code === 0 && job.status === "guarded" ? (skipped ? "skipped" : "done") : "cancelled";
        else if (code === 0) item.status = more ? "queued" : skipped ? "skipped" : "done";
        else Object.assign(item, { status: "failed", error: item.log.at(-1) ?? `The tune exited with code ${code}.` });
        this.#changed();
        resolve(true);
      });
    });
  }

  #finish(job, status) {
    if (job.finishedAt) return;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    this.#writeQueue();
    this.#changed();
  }
}

const KEPT_DECISIONS = 30;

const emptyLive = () => ({ expectedAnswers: null, answers: 0, eta: null, axis: null, decisions: [] });

/**
 * What the Bench panel shows while a tune runs: answers so far against the expected
 * count, the time left, the setting being tried with each value's latest round, and
 * the decisions made so far (ADR-055).
 */
function followLive(live, event) {
  if (Number.isFinite(event.runs)) live.answers = event.runs;
  if (event.eta) live.eta = event.eta;
  if (event.type === "estimate" && Number.isFinite(event.expectedAnswers)) live.expectedAnswers = event.expectedAnswers;
  if (event.type === "tune-candidate") {
    const key = `${event.stage}|${event.task ?? ""}|${event.axis}`;
    if (live.axis?.key !== key) live.axis = { key, stage: event.stage, task: event.task ?? null, axis: event.axis, candidates: [] };
    const candidate = { patch: event.patch, rung: event.rung, rate: event.rate, latencyMs: event.latencyMs ?? null, outputTokens: event.outputTokens ?? null };
    const same = live.axis.candidates.findIndex((entry) => JSON.stringify(entry.patch) === JSON.stringify(event.patch));
    if (same >= 0) live.axis.candidates[same] = candidate;
    else live.axis.candidates.push(candidate);
  }
  if (event.type === "tune-sweep") {
    live.decisions.push({ stage: event.stage, task: event.task ?? null, axis: event.axis, winner: event.winner, changed: Boolean(event.changed), kept: event.kept ?? null, reason: event.reason ?? null });
    if (live.decisions.length > KEPT_DECISIONS) live.decisions.shift();
  }
}

function parseEvent(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const event = JSON.parse(text);
    return event && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
}

function pushLog(item, line) {
  const text = String(line ?? "").trim();
  if (!text) return;
  item.log.push(text.slice(0, 300));
  if (item.log.length > LOG_LINES) item.log.splice(0, item.log.length - LOG_LINES);
}

/** "gpu" when the model's profile chose a GPU in its device stage, else "cpu". */
async function laneFromProfile(profilesDir, model) {
  if (!profilesDir) return "cpu";
  try {
    const profile = JSON.parse(await fs.promises.readFile(path.join(profilesDir, `${model.profileId}.json`), "utf8"));
    const backend = profile?.device?.settings?.gpuBackend;
    return backend && backend !== "cpu" ? "gpu" : "cpu";
  } catch {
    return "cpu";
  }
}
