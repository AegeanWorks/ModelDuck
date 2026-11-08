import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { AppError } from "./errors.js";
import { BENCHMARK_MACHINE, moveTo } from "./state-machine.js";

const SCRIPT = fileURLToPath(new URL("../benchmarks/run.mjs", import.meta.url));
const TUNE_SCRIPT = fileURLToPath(new URL("../benchmarks/tune-run.mjs", import.meta.url));
const DEFAULT_BENCHMARK_DIR = fileURLToPath(new URL("../benchmarks", import.meta.url));
const PHASES = new Set(["model", "chat", "tune"]);
const LOG_LINES = 20;
const KILL_GRACE_MS = 10_000;

/**
 * Runs one benchmark child process at a time. The child writes JSON progress
 * lines on stdout (`--events`); every other line is kept as a short log tail.
 * Starting, cancelling and status reads are synchronous and never block the
 * HTTP server while a multi-hour run is in progress.
 */
export class BenchmarkRunner {
  #benchmarkDir;
  #modelsDir;
  #scriptPath;
  #tuneScriptPath;
  #homeDir;
  #spawn;
  #logger;
  #job = null;
  #child = null;

  constructor({
    benchmarkDir = DEFAULT_BENCHMARK_DIR,
    modelsDir = null,
    scriptPath = SCRIPT,
    tuneScriptPath = TUNE_SCRIPT,
    homeDir = null,
    spawnImpl = spawn,
    logger = console,
  } = {}) {
    this.#benchmarkDir = benchmarkDir;
    this.#modelsDir = modelsDir;
    this.#scriptPath = scriptPath;
    this.#tuneScriptPath = tuneScriptPath;
    this.#homeDir = homeDir;
    this.#spawn = spawnImpl;
    this.#logger = logger;
  }

  get() {
    if (!this.#job) return null;
    return {
      ...this.#job,
      log: [...this.#job.log],
      progress: this.#job.progress ? { ...this.#job.progress } : null,
    };
  }

  start({ phase = "model", updateBaseline = false, download = false, fullMatrix = false, model = null, tasks = null, stages = null, settings = null, force = false } = {}) {
    if (!PHASES.has(phase)) {
      throw new AppError("Unknown benchmark phase", {
        code: "invalid_benchmark_phase",
        status: 400,
        why: "A benchmark run is the model-reload phase, the chat-usage phase or a settings tune.",
        fix: "Choose model, chat or tune.",
      });
    }
    if (this.#job?.status === "running") {
      throw new AppError("A benchmark is already running", {
        code: "benchmark_in_progress",
        status: 409,
        why: "ModelDuck runs one benchmark at a time so the measurements stay comparable.",
        fix: "Wait for it to finish, or cancel it first.",
      });
    }

    if (phase === "tune" && !model) {
      throw new AppError("Choose a model to tune", {
        code: "tune_model_required",
        status: 400,
        why: "A tune finds the best settings for one installed model.",
        fix: "Pick an installed model, then start the tune.",
      });
    }
    const taskList = Array.isArray(tasks) && tasks.length ? tasks.map(String) : null;
    const args = phase === "tune"
      ? [this.#tuneScriptPath, "--events", "--model", String(model)]
      : [this.#scriptPath, "--phase", phase, "--events"];
    if (updateBaseline) args.push("--update-baseline");
    if (download) args.push("--download");
    if (fullMatrix) args.push("--full-matrix");
    if (model && phase !== "tune") args.push("--model", String(model));
    if (taskList && phase === "tune") args.push("--tasks", taskList.join(","));
    if (force && phase === "tune") args.push("--force");
    const stageList = Array.isArray(stages) && stages.length ? stages.map(String) : null;
    if (stageList && phase === "tune") args.push("--stages", stageList.join(","));
    if (settings?.length && phase === "tune") args.push("--settings", settings.map(String).join(","));
    if (this.#modelsDir) args.push("--models-dir", this.#modelsDir);
    if (this.#homeDir && phase === "tune") args.push("--home", this.#homeDir);

    const job = {
      id: randomUUID(),
      phase,
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      updateBaseline: Boolean(updateBaseline),
      download: Boolean(download),
      fullMatrix: Boolean(fullMatrix),
      model: model ? String(model) : null,
      tasks: phase === "tune" ? taskList : null,
      force: phase === "tune" && Boolean(force),
      stages: phase === "tune" ? stageList : null,
      cancelling: false,
      error: null,
      progress: { type: "starting", phase },
      log: [],
    };
    this.#job = job;

    let child;
    try {
      child = this.#spawn(process.execPath, args, {
        cwd: this.#benchmarkDir,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.#finish(job, "failed", null, {
        message: "The benchmark could not start",
        why: error.message,
        fix: "Run npm run bench:model in a terminal to see the full error.",
      });
      return this.get();
    }
    this.#child = child;

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.#consume(job, line));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => this.#log(job, line));

    child.on("error", (error) => {
      // A replaced job's child must not finish (or null) the newer run.
      if (this.#job !== job) return;
      this.#finish(job, "failed", null, {
        message: "The benchmark process failed",
        why: error.message,
        fix: "Run npm run bench:model in a terminal to see the full error.",
      });
    });
    child.on("close", (code, signal) => {
      stdout.close();
      stderr.close();
      if (this.#job !== job) return;
      this.#child = null;
      if (job.status !== "running") return;
      if (job.cancelling) {
        this.#finish(job, "cancelled", code);
      } else if (code === 0 || job.progress?.type === "complete") {
        this.#finish(job, "complete", code);
      } else {
        this.#finish(job, "failed", code, {
          message: "The benchmark stopped before it finished",
          why: job.log.at(-1) || `The process exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
          fix: "Fix the reported problem, then run the benchmark again.",
        });
      }
    });

    return this.get();
  }

  cancel() {
    const job = this.#job;
    if (!job || job.status !== "running") {
      throw new AppError("No benchmark is running", {
        code: "benchmark_not_running",
        status: 409,
        why: "There is no benchmark child process to stop.",
        fix: "Start a benchmark first.",
      });
    }
    job.cancelling = true;
    job.updatedAt = new Date().toISOString();
    const child = this.#child;
    if (child) {
      this.#kill(child);
      const timer = setTimeout(() => {
        if (job.status === "running") this.#kill(child, "SIGKILL");
      }, KILL_GRACE_MS);
      timer.unref?.();
    }
    return this.get();
  }

  dispose() {
    if (this.#job?.status === "running" && this.#child) {
      this.#job.cancelling = true;
      this.#kill(this.#child, "SIGKILL");
    }
  }

  #kill(child, signal = "SIGTERM") {
    try {
      child.kill(signal);
    } catch (error) {
      this.#logger.warn?.(`[modelduck] Could not stop the benchmark: ${error.message}`);
    }
  }

  #consume(job, line) {
    const text = String(line ?? "").trim();
    if (!text) return;
    if (text.startsWith("{")) {
      try {
        const event = JSON.parse(text);
        if (event && typeof event === "object" && typeof event.type === "string") {
          job.progress = event;
          job.updatedAt = new Date().toISOString();
          return;
        }
      } catch {
        // Not a progress event; keep it in the log below.
      }
    }
    this.#log(job, text);
  }

  #log(job, line) {
    const text = String(line ?? "").trim();
    if (!text) return;
    job.log.push(text.slice(0, 500));
    if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
    job.updatedAt = new Date().toISOString();
  }

  #finish(job, status, exitCode, error = null) {
    // One terminal outcome per job; a late exit cannot rewrite a cancel.
    if (!moveTo(job, BENCHMARK_MACHINE, status)) return;
    job.exitCode = exitCode;
    job.error = error;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.cancelling = false;
  }
}
