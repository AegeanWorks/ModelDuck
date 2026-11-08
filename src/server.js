import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { AppError } from "./errors.js";
import { selectChatBase } from "./benchmark-base.js";
import { loadBenchmarkReport } from "./benchmark-report.js";
import { manifestSummary } from "./generation-manifest.js";
import {
  applyCorsHeaders,
  applySecurityHeaders,
  isApiV1Path,
  isCrossSiteRequest,
  isLoopbackRequest,
  readJsonBody,
  requiresApiAuth,
  sendError,
  sendJson,
  servePublicFile,
  sseComment,
  sseSend,
  sseStart,
} from "./http.js";
import { publicCatalog } from "./model-catalog.js";
import { currentFingerprint, importRecipe, isPartRun, launchRecipe, listProfiles, loadProfile, profileIdFor, profileRecipe, saveProfile, typeWarnings } from "./model-profiles.js";
import { answersFile, answerPaceByProfile, listRuns, loadRun, summarizeAnswers } from "./tune-runs.js";
import { TunedSettings, diffSettings } from "./tuned-settings.js";
import { readSteps, writeSteps } from "./tune-steps.js";
import { DEFAULT_STEPS, estimateTune, expectedAnswers, settingNames } from "../benchmarks/tune-grid.mjs";
import { STAGES } from "../benchmarks/tune.mjs";
import { handleOpenAI } from "./openai.js";
import { settingPresets } from "./config.js";
import { recommendCatalog, recommendModels } from "./recommend.js";
import { systemInfo } from "./system.js";
import { TASKS, suiteSummary } from "../benchmarks/tasks.mjs";

function validateTuneSelection(tasks, stages) {
  const unknownTasks = (tasks ?? []).filter((id) => !TASKS.some((task) => task.id === id));
  if (unknownTasks.length) {
    throw new AppError("Unknown task", {
      code: "unknown_task",
      status: 400,
      why: `${unknownTasks.join(", ")} is not a benchmark task.`,
      fix: `Use one of: ${TASKS.map((task) => task.id).join(", ")}.`,
    });
  }
  const unknownStages = (stages ?? []).filter((stage) => !STAGES.includes(stage));
  if (unknownStages.length) {
    throw new AppError("Unknown tune stage", {
      code: "unknown_stage",
      status: 400,
      why: `${unknownStages.join(", ")} is not a tune stage.`,
      fix: `Use one of: ${STAGES.join(", ")}.`,
    });
  }
}

// Route ids come from the URL path: a malformed escape is a 400 on the
// request, never a 500 from decodeURIComponent.
function decodeRouteId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AppError("Bad route id", {
      code: "route_id_invalid",
      status: 400,
      why: "That path segment is not valid URL encoding.",
      fix: "Use the ids listed by the API instead of hand-writing the URL.",
    });
  }
}

// State-changing routes belong to the computer running the model. A LAN client
// with a key may chat, but it may not rewrite settings, the model library or
// downloads: those change this machine's files and measurements.
function requireLocalAction(req, { code, message, why, fix }) {
  if (!isLoopbackRequest(req)) {
    throw new AppError(message, { code, status: 403, why, fix });
  }
}

// Live tune updates: changes within this window go out together; a comment keeps idle connections open.
const STREAM_BATCH_MS = 250;
const STREAM_HEARTBEAT_MS = 15_000;

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const BENCHMARK_DIR = fileURLToPath(new URL("../benchmarks", import.meta.url));

function openFolder(folder, logger) {
  const command =
    process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [folder], (error) => {
    if (error) logger.warn?.(`[modelduck] Could not open ${folder}: ${error.message}`);
  });
}

export function createHttpServer({
  settings,
  registry,
  engine,
  downloads,
  serverSettings = null,
  jit = null,
  benchmarks = null,
  tunes = null,
  logger = console,
  publicDir = PUBLIC_DIR,
  benchmarkDir = BENCHMARK_DIR,
  profilesDir = null,
  tuneRunsDir = null,
  profileFingerprint = currentFingerprint,
  tuneStepsFile = null,
  instance = null,
}) {
  const tuned = new TunedSettings({ profilesDir, registry, settings, fingerprint: profileFingerprint });
  const tunedInfo = (applied) => applied && { catalogId: applied.catalogId, task: applied.task, speedPreset: applied.speedPreset, stages: applied.stages, systemPrompt: applied.settings.systemPrompt ?? null, rate: applied.rate ?? null, typeWarnings: applied.typeWarnings ?? [], stale: applied.stale, warnings: applied.warnings };

  async function route(req, res) {
    applySecurityHeaders(res);
    const serverConfig = serverSettings?.value ?? {};
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method || "GET";
    const corsRoute = Boolean(serverConfig.enableCors) && isApiV1Path(pathname);
    if (corsRoute) applyCorsHeaders(res);
    if (!isLoopbackRequest(req, { allowLan: Boolean(serverConfig.serveOnLocalNetwork) })) {
      sendJson(res, 403, {
        error: {
          code: "forbidden_host",
          message: "Request refused",
          why: "ModelDuck only accepts requests addressed to this computer.",
          fix: "Open the loopback URL, or enable Serve on Local Network in Server settings.",
        },
      });
      return;
    }

    if (isCrossSiteRequest(req) && !corsRoute) {
      sendJson(res, 403, {
        error: {
          code: "cross_site_refused",
          message: "Request refused",
          why: "A web page from another site tried to use ModelDuck through your browser.",
          fix: "Use the ModelDuck UI itself. Browser apps may call /v1 only when Enable CORS is on and they send an API key.",
        },
      });
      return;
    }

    if (method === "OPTIONS" && corsRoute) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (requiresApiAuth(req, { requireAuth: serverConfig.requireAuth, pathname })) {
      const header = String(req.headers.authorization || "");
      const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      const supplied = bearer || String(req.headers["x-api-key"] || "");
      if (!serverSettings.verifyKey(supplied)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        sendJson(res, 401, {
          error: {
            code: "unauthorized",
            message: "Authentication required",
            why: "Require Authentication is enabled for this server and the request did not carry a valid key.",
            fix: "Send Authorization: Bearer <key> or X-API-Key: <key>, or use the loopback UI on this computer.",
          },
        });
        return;
      }
    }

    if (method === "OPTIONS") {
      sendJson(res, 405, {
        error: { code: "method_not_allowed", message: "Cross-origin requests are not supported" },
      });
      return;
    }

    if (method === "GET" && pathname === "/health") {
      const status = engine ? await engine.status() : { status: "idle" };
      sendJson(res, 200, { ok: true, status: status.status, model: status.model ?? null });
      return;
    }

    if (pathname === "/api/state" && method === "GET") {
      const [models, loaded] = await Promise.all([
        registry ? registry.scan() : [],
        engine ? engine.status() : { status: "idle" },
      ]);
      sendJson(res, 200, {
        app: systemInfo(),
        settings: settings.value,
        presets: settingPresets(),
        serverSettings: serverSettings
          ? {
              ...serverSettings.value,
              apiKeys: serverSettings.listKeys(),
              activeKeys: serverSettings.activeKeys,
            }
          : null,
        modelsDir: registry?.modelsDir ?? null,
        models,
        loaded,
        catalog: publicCatalog(),
        downloads: downloads ? downloads.list() : [],
      });
      return;
    }

    if (pathname === "/api/status" && method === "GET") {
      sendJson(res, 200, {
        loaded: engine ? await engine.status() : { status: "idle" },
        downloads: downloads ? downloads.list() : [],
      });
      return;
    }

    if (pathname === "/api/gpu" && method === "GET") {
      const module = await import("node-llama-cpp");
      const backends = await module.getLlamaGpuTypes();
      sendJson(res, 200, {
        backends,
        rocm: false,
        note: "ROCm is not exposed by node-llama-cpp; use Vulkan for AMD GPUs.",
      });
      return;
    }

    if (pathname === "/api/benchmarks" && method === "GET") {
      sendJson(res, 200, await loadBenchmarkReport({ benchmarkDir }));
      return;
    }

    if (pathname === "/api/benchmarks/suite" && method === "GET") {
      sendJson(res, 200, suiteSummary());
      return;
    }

    if (pathname === "/api/benchmarks/status" && method === "GET") {
      sendJson(res, 200, { job: benchmarks ? benchmarks.get() : null });
      return;
    }

    if (pathname === "/api/benchmarks/base" && method === "POST") {
      if (!benchmarks) throw new AppError("Benchmark runner unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Benchmarks run only on this computer", {
          code: "benchmark_local_only",
          status: 403,
          why: "Choosing the chat base is part of the local benchmark.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      if (benchmarks.get()?.status === "running") {
        throw new AppError("A benchmark is already running", {
          code: "benchmark_in_progress",
          status: 409,
          why: "The chat base cannot change while a benchmark is using it.",
          fix: "Wait for the run to finish, or cancel it first.",
        });
      }
      const body = await readJsonBody(req);
      const selection = await selectChatBase({
        benchmarkDir,
        variantId: String(body.variantId ?? ""),
      });
      sendJson(res, 200, { chatBase: selection });
      return;
    }

    if (pathname === "/api/benchmarks/run" && method === "POST") {
      if (!benchmarks) throw new AppError("Benchmark runner unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Benchmarks run only on this computer", {
          code: "benchmark_local_only",
          status: 403,
          why: "A benchmark loads every model in the matrix and takes the whole CPU for a long time.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      if (engine?.busy) {
        throw new AppError("The duck is already answering", {
          code: "generation_in_progress",
          status: 409,
          why: "Benchmarking and chatting cannot share the CPU without skewing the measurements.",
          fix: "Wait for the reply to finish, then start the benchmark.",
        });
      }
      if (tunes?.get()?.status === "running") {
        throw new AppError("A tune is running", {
          code: "tune_in_progress",
          status: 409,
          why: "Benchmarking beside a tune would skew both measurements.",
          fix: "Wait for the tune to finish, or cancel it first.",
        });
      }
      const body = await readJsonBody(req);
      const phase = body.phase ?? "model";
      const requestedTasks = Array.isArray(body.tasks) && body.tasks.length ? body.tasks.map(String) : null;
      const requestedStages = Array.isArray(body.stages) && body.stages.length ? body.stages.map(String) : null;
      const requestedSettings = Array.isArray(body.settings) && body.settings.length ? body.settings.map(String) : null;
      if (phase !== "tune" && (requestedTasks || requestedStages || requestedSettings)) {
        throw new AppError("Stages, tasks and settings tune only", {
          code: "invalid_benchmark_selection",
          status: 400,
          why: "A model or chat benchmark always runs the whole matrix; stages, tasks and settings select tune work the run would ignore.",
          fix: "Drop stages, tasks and settings, or run phase tune.",
        });
      }
      validateTuneSelection(requestedTasks, requestedStages);
      const unknownSettings = (requestedSettings ?? []).filter((name) => !settingNames().includes(name));
      if (unknownSettings.length) {
        throw new AppError("Unknown setting", {
          code: "unknown_setting",
          status: 400,
          why: `${unknownSettings.join(", ")} is not a tunable setting.`,
          fix: `Use any of: ${settingNames().join(", ")}.`,
        });
      }
      const requestedModel = body.model ? String(body.model) : null;
      // A tune names one installed model; failing here beats a 202 followed by
      // a child process that dies on an unknown id.
      if (phase === "tune" && requestedModel && !registry.listPublic().some((item) => item.id === requestedModel)) {
        throw new AppError("Model not found", {
          code: "model_not_found",
          status: 404,
          why: `${requestedModel} is not in the local model library.`,
          fix: "Pick an installed model, or install it first.",
        });
      }
      // IDEA-1079: same preflight for model and chat benchmarks.
      if (typeof engine?.startBackend === "function") await engine.startBackend(settings.value.gpuBackend);
      sendJson(res, 202, {
        job: benchmarks.start({
          phase,
          updateBaseline: body.updateBaseline === true,
          download: body.download === true,
          fullMatrix: body.fullMatrix === true,
          model: requestedModel,
          tasks: requestedTasks,
          force: body.force === true,
          stages: requestedStages,
          settings: requestedSettings,
        }),
      });
      return;
    }

    if (pathname === "/api/tune/overview" && method === "GET") {
      // Every installed model with its tuned profile, without the sweep log and resume state.
      const models = [];
      for (const model of registry.listPublic()) {
        const profileId = profileIdFor(model.fileName);
        const loaded = profilesDir ? await loadProfile(profilesDir, profileId, await profileFingerprint(model)).catch(() => null) : null;
        const { sweeps: _sweeps, progress: _progress, ...profile } = loaded?.profile ?? {};
        models.push({
          id: model.id,
          name: model.name,
          fileName: model.fileName,
          profileId,
          profile: loaded ? profile : null,
          stale: loaded?.stale ?? [],
          staleParts: loaded?.staleParts ?? [],
          deviceParts: loaded?.deviceParts ?? [],
          warnings: loaded?.warnings ?? [],
          typeWarnings: loaded ? typeWarnings(loaded.profile) : {},
        });
      }
      sendJson(res, 200, { models });
      return;
    }

    // What to run on this machine: measured models first, then catalog estimates (ADR-069).
    if (pathname === "/api/recommendations" && method === "GET") {
      const wanted = new URL(req.url, "http://localhost").searchParams.get("task") ?? "code";
      const task = TASKS.some((item) => item.id === wanted) ? wanted : "code";
      const system = systemInfo();
      const memory = { free: system.freeMemory, total: system.totalMemory };
      const models = registry.listPublic().map((model) => ({ ...model, profileId: profileIdFor(model.fileName) }));
      const profiles = {};
      for (const model of models) {
        const loaded = profilesDir ? await loadProfile(profilesDir, model.profileId, await profileFingerprint(model)).catch(() => null) : null;
        profiles[model.profileId] = loaded?.profile ?? null;
      }
      sendJson(res, 200, {
        task,
        memory,
        installed: recommendModels({ models, profiles, memory, task }),
        catalog: recommendCatalog({ catalog: publicCatalog(), installed: models.map((model) => model.id), memory }),
      });
      return;
    }

    // Every tune run with its statistics and answers (ADR-050).
    if (pathname === "/api/tune/runs" && method === "GET") {
      sendJson(res, 200, { runs: tuneRunsDir ? await listRuns(tuneRunsDir) : [] });
      return;
    }
    const runMatch = pathname.match(/^\/api\/tune\/runs\/([^/]+)(\/answers)?$/);
    if (runMatch && method === "GET") {
      const id = decodeRouteId(runMatch[1]);
      const run = tuneRunsDir ? await loadRun(tuneRunsDir, id) : null;
      if (!run) {
        throw new AppError("Tune run not found", { code: "tune_run_missing", status: 404, why: `There is no saved tune run ${id}.`, fix: "Pick a run from the list of tune runs." });
      }
      if (!runMatch[2]) {
        sendJson(res, 200, { run, answers: await summarizeAnswers(tuneRunsDir, id) });
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": `attachment; filename="tune-run-${id}.jsonl"` });
      const stream = fs.createReadStream(answersFile(tuneRunsDir, id));
      stream.on("error", () => res.end());
      stream.pipe(res);
      return;
    }

    // A running tune, pushed to the Bench panel as it changes (ADR-055).
    if (pathname === "/api/tune/stream" && method === "GET") {
      if (!tunes?.subscribe) throw new AppError("Tune scheduler unavailable", { status: 503 });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      const send = () => res.write(`data: ${JSON.stringify({ job: tunes.get() ?? null })}\n\n`);
      send();
      // Changes come in bursts (every answer); a quarter second is live enough.
      let pending = null;
      const stop = tunes.subscribe(() => {
        pending ??= setTimeout(() => {
          pending = null;
          send();
        }, STREAM_BATCH_MS);
      });
      const heartbeat = setInterval(() => res.write(`: keep-alive\n\n`), STREAM_HEARTBEAT_MS);
      req.on("close", () => {
        stop();
        clearTimeout(pending);
        clearInterval(heartbeat);
      });
      return;
    }

    if (pathname === "/api/tune/status" && method === "GET") {
      sendJson(res, 200, { job: tunes?.get() ?? null });
      return;
    }

    if (pathname === "/api/tune/pause" && method === "POST") {
      if (!tunes) throw new AppError("Tune scheduler unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) throw new AppError("Tunes are controlled only on this computer", { code: "tune_local_only", status: 403, why: "Only the computer running the tune can pause it.", fix: "Open ModelDuck on the computer running the server." });
      sendJson(res, 200, { job: tunes.pause() });
      return;
    }

    if (pathname === "/api/tune/resume" && method === "POST") {
      if (!tunes) throw new AppError("Tune scheduler unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) throw new AppError("Tunes are controlled only on this computer", { code: "tune_local_only", status: 403, why: "Only the computer running the tune can resume it.", fix: "Open ModelDuck on the computer running the server." });
      sendJson(res, 200, { job: tunes.resume() });
      return;
    }

    if (pathname === "/api/tune/priority" && method === "POST") {
      if (!tunes) throw new AppError("Tune scheduler unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) throw new AppError("Tunes are controlled only on this computer", { code: "tune_local_only", status: 403, why: "Only the computer running the tune can reorder it.", fix: "Open ModelDuck on the computer running the server." });
      const body = await readJsonBody(req);
      const direction = body.direction === "up" ? "up" : body.direction === "down" ? "down" : null;
      if (!direction || typeof body.profileId !== "string") {
        throw new AppError("Choose a queue move", { code: "tune_priority_invalid", status: 400, why: "Priority needs a model and up or down.", fix: "Send { profileId, direction: \"up\" | \"down\" }." });
      }
      sendJson(res, 200, { job: await tunes.move(body.profileId, direction) });
      return;
    }

    if (pathname === "/api/tune/start" && method === "POST") {
      if (!tunes) throw new AppError("Tune scheduler unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Tunes run only on this computer", {
          code: "tune_local_only",
          status: 403,
          why: "A tune loads models one after another and takes the CPU and GPU for a long time.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      if (engine?.busy || benchmarks?.get()?.status === "running") {
        throw new AppError("The duck is busy", {
          code: "generation_in_progress",
          status: 409,
          why: "A reply or benchmark is running; tuning beside it would skew both.",
          fix: "Wait for it to finish, then start the tune.",
        });
      }
      const body = await readJsonBody(req);
      const installed = registry.listPublic();
      const wanted =
        body.models === "all"
          ? installed.map((model) => model.id)
          : Array.isArray(body.models)
            ? body.models.map(String)
            : typeof body.models === "string" && body.models.trim()
              ? [body.models.trim()]
              : [];
      const models = wanted.map((id) => {
        const model = installed.find((item) => item.id === id);
        if (!model) {
          throw new AppError("Model not found", { code: "model_not_found", status: 404, why: `${id} is not in the local model library.`, fix: "Pick an installed model." });
        }
        return { id: model.id, fileName: model.fileName, profileId: profileIdFor(model.fileName), name: model.name };
      });
      const only = Array.isArray(body.settings) && body.settings.length ? body.settings.map(String) : null;
      const stages = Array.isArray(body.stages) ? body.stages.map(String) : null;
      // An empty task list means every task, like the runner already treats it; keeping [] would
      // mark the run a task subset and skip or part-run nothing instead of tuning the model.
      const tasks = Array.isArray(body.tasks) && body.tasks.length ? body.tasks.map(String) : null;
      validateTuneSelection(tasks, stages);
      // forceStale starts over only where the saved profile was measured on another suite, runtime or machine,
      // and only for a whole tune: a part run re-measures its parts on top of the saved rest (ADR-040).
      // A task subset is a part run too: starting it over would save a profile without the other tasks.
      // Continuing never starts over: it finishes what the earlier run left (ADR-051).
      const taskSubset = Array.isArray(tasks) && tasks.length < TASKS.length;
      if (body.forceStale === true && profilesDir && !isPartRun(stages, only) && !taskSubset && body.continue !== true) {
        for (const model of models) {
          const entry = installed.find((item) => item.id === model.id);
          const saved = await loadProfile(profilesDir, model.profileId, await profileFingerprint(entry)).catch(() => null);
          model.force = Boolean(saved?.stale.length);
        }
      }
      const unknownSettings = (only ?? []).filter((name) => !settingNames().includes(name));
      if (unknownSettings.length) {
        throw new AppError("Unknown setting", { code: "unknown_setting", status: 400, why: `${unknownSettings.join(", ")} is not a tunable setting.`, fix: `Use any of: ${settingNames().join(", ")}.` });
      }
      if (!models.length) throw new AppError("Choose a model to tune", { code: "tune_model_required", why: "No model was named.", fix: "Pick an installed model, or send models: \"all\"." });
      // IDEA-1079: fail fast on a broken GPU before the first answer, not mid-run.
      if (typeof engine?.startBackend === "function") await engine.startBackend(settings.value.gpuBackend);
      sendJson(res, 202, {
        job: tunes.start({
          models,
          tasks,
          stages,
          settings: only,
          force: body.force === true,
          continueRun: body.continue === true,
          quick: body.quick === true,
          guard: body.guard === true,
          guardQueue: body.guardQueue === true,
        }),
      });
      return;
    }

    if (pathname === "/api/tune/cancel" && method === "POST") {
      if (!tunes) throw new AppError("Tune scheduler unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Tunes are controlled only on this computer", {
          code: "tune_local_only",
          status: 403,
          why: "Tunes take the CPU and GPU for a long time; only the computer running them may start, stop or reconfigure them.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      sendJson(res, 200, { job: tunes.cancel() });
      return;
    }

    if (pathname === "/api/tune/estimate" && method === "GET") {
      if (!tuneStepsFile) throw new AppError("Tune steps unavailable", { status: 503 });
      const query = new URL(req.url, "http://localhost").searchParams;
      const list = (key, fallback) => {
        const raw = query.get(key);
        return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
      };
      const tasks = list("tasks", TASKS.map((task) => task.id));
      const stages = list("stages", [...STAGES]);
      const only = list("settings", null);
      validateTuneSelection(tasks, stages);
      const unknownSettings = (only ?? []).filter((name) => !settingNames().includes(name));
      if (unknownSettings.length) {
        throw new AppError("Unknown setting", { code: "unknown_setting", status: 400, why: `${unknownSettings.join(", ")} is not a tunable setting.`, fix: `Use any of: ${settingNames().join(", ")}.` });
      }
      const result = await readSteps(tuneStepsFile);
      const logicalCores = systemInfo().parallelism;
      const installed = registry.listPublic();
      const paces = tuneRunsDir ? await answerPaceByProfile(tuneRunsDir) : new Map();
      const perModel = installed.map((model) => {
        const profileId = profileIdFor(model.fileName);
        const pace = paces.get(profileId) ?? null;
        // Without history, keep the conservative fixed pace.
        const seconds = pace?.secondsPerAnswer ?? 3;
        const low = pace?.low ?? seconds;
        const high = pace?.high ?? seconds;
        const estimate = (quick, secondsPerAnswer) => ({ answersPerModel: expectedAnswers(result.steps, { logicalCores, tasks, stages, only, quick }), estimate: estimateTune(result.steps, { logicalCores, tasks, stages, only, secondsPerAnswer, quick }) });
        return {
          id: model.id,
          name: model.name,
          profileId,
          pace,
          quick: { ...estimate(true, seconds), lowSeconds: Math.min(estimate(true, low).estimate.onePassSeconds, estimate(true, high).estimate.onePassSeconds), highSeconds: Math.max(estimate(true, low).estimate.onePassSeconds, estimate(true, high).estimate.onePassSeconds) },
          full: { ...estimate(false, seconds), lowSeconds: Math.min(estimate(false, low).estimate.onePassSeconds, estimate(false, high).estimate.onePassSeconds), highSeconds: Math.max(estimate(false, low).estimate.onePassSeconds, estimate(false, high).estimate.onePassSeconds) },
        };
      });
      const quick = perModel[0]?.quick ?? { answersPerModel: expectedAnswers(result.steps, { logicalCores, tasks, stages, only, quick: true }), estimate: estimateTune(result.steps, { logicalCores, tasks, stages, only, quick: true }) };
      sendJson(res, 200, {
        tasks,
        stages,
        settings: only,
        logicalCores,
        models: perModel.length,
        perModel,
        answersPerModel: perModel[0]?.full.answersPerModel ?? expectedAnswers(result.steps, { logicalCores, tasks, stages, only }),
        estimate: perModel[0]?.full.estimate ?? estimateTune(result.steps, { logicalCores, tasks, stages, only }),
        quick,
      });
      return;
    }

    if (pathname === "/api/tune/steps" && (method === "GET" || method === "PUT")) {
      if (!tuneStepsFile) throw new AppError("Tune steps unavailable", { status: 503 });
      if (method === "PUT") {
        if (!isLoopbackRequest(req)) {
          throw new AppError("Tunes are controlled only on this computer", {
            code: "tune_local_only",
            status: 403,
            why: "Tunes take the CPU and GPU for a long time; only the computer running them may start, stop or reconfigure them.",
            fix: "Open the ModelDuck UI on the computer running the server.",
          });
        }
      }
      const result = method === "PUT"
        ? await writeSteps(tuneStepsFile, (await readJsonBody(req)).steps ?? {})
        : await readSteps(tuneStepsFile);
      const logicalCores = systemInfo().parallelism;
      sendJson(res, 200, { ...result, defaults: DEFAULT_STEPS, settingNames: settingNames(), logicalCores, estimate: estimateTune(result.steps, { logicalCores }) });
      return;
    }

    if (pathname === "/api/profiles" && method === "GET") {
      sendJson(res, 200, { profiles: profilesDir ? await listProfiles(profilesDir) : [] });
      return;
    }

    const profileExport = pathname.match(/^\/api\/profiles\/([^/]+)\/export$/);
    if (profileExport && method === "GET") {
      if (!profilesDir) throw new AppError("Profiles are unavailable", { status: 503 });
      const id = decodeRouteId(profileExport[1]);
      const entry = registry.listPublic().find((model) => profileIdFor(model.fileName) === id) ?? null;
      const loaded = await loadProfile(profilesDir, id, await profileFingerprint(entry));
      if (!loaded) {
        throw new AppError("This model has not been tuned", {
          code: "profile_missing",
          status: 404,
          why: `There is no saved profile for ${id}.`,
          fix: "Start a tune for it from the Bench panel, or run npm run tune -- --model <id>.",
        });
      }
      res.setHeader("content-disposition", `attachment; filename="${id}.modelduck-profile.json"`);
      sendJson(res, 200, profileRecipe(loaded.profile));
      return;
    }

    if (pathname === "/api/profiles/import" && method === "POST") {
      if (!profilesDir) throw new AppError("Profiles are unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Profiles import only on this computer", {
          code: "profile_local_only",
          status: 403,
          why: "Importing a profile changes this computer's settings.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      const imported = importRecipe(await readJsonBody(req, { limitBytes: 512 * 1024 }));
      const entry = registry.listPublic().find((model) => profileIdFor(model.fileName) === imported.catalogId) ?? null;
      if (!entry) {
        throw new AppError("That model is not installed", {
          code: "profile_model_missing",
          status: 422,
          why: `The profile is for ${imported.catalogId}, which is not in the model folder.`,
          fix: "Install that model first, or import a profile for a model you have.",
        });
      }
      await saveProfile(profilesDir, imported);
      const loaded = await loadProfile(profilesDir, imported.catalogId, await profileFingerprint(entry));
      sendJson(res, 201, { catalogId: imported.catalogId, imported: true, stale: loaded?.stale ?? [], warnings: loaded?.warnings ?? [] });
      return;
    }

    // IDEA-1071: what a tuned profile would change, shown before it is applied.
    const profileDiffMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/diff$/);
    if (profileDiffMatch && method === "GET") {
      const id = decodeRouteId(profileDiffMatch[1]);
      const modelId = registry.listPublic().find((model) => profileIdFor(model.fileName) === id)?.id ?? null;
      const applied = modelId ? await tuned.resolve(modelId) : null;
      if (!applied) {
        throw new AppError("This model has not been tuned", {
          code: "profile_missing",
          status: 404,
          why: `There is no saved profile for ${id}.`,
          fix: "Start a tune for it from the Bench panel, or run npm run tune -- --model <id>.",
        });
      }
      sendJson(res, 200, { catalogId: applied.catalogId, task: applied.task, stale: applied.stale, warnings: applied.warnings, diff: diffSettings(settings.value, applied.settings) });
      return;
    }

    // IDEA-1078/1193: a model-bound launch recipe with its capability preset.
    const profileLaunchMatch = pathname.match(/^\/api\/profiles\/([^/]+)\/launch$/);
    if (profileLaunchMatch && method === "GET") {
      const id = decodeRouteId(profileLaunchMatch[1]);
      const entry = registry.listPublic().find((model) => profileIdFor(model.fileName) === id) ?? null;
      const loaded = profilesDir ? await loadProfile(profilesDir, id, await profileFingerprint(entry)) : null;
      if (!entry || !loaded) {
        throw new AppError("This model has not been tuned", {
          code: "profile_missing",
          status: 404,
          why: `There is no saved profile for ${id}.`,
          fix: "Start a tune for it from the Bench panel, or run npm run tune -- --model <id>.",
        });
      }
      const digest = profilesDir ? (await downloads?.receiptFor?.(entry.fileName))?.digest ?? null : null;
      sendJson(res, 200, { recipe: launchRecipe(entry, loaded.profile, digest) });
      return;
    }

    const profileMatch = pathname.match(/^\/api\/profiles\/([^/]+)$/);
    if (profileMatch && method === "GET") {
      const id = decodeRouteId(profileMatch[1]);
      const entry = registry.listPublic().find((model) => profileIdFor(model.fileName) === id) ?? null;
      const loaded = profilesDir ? await loadProfile(profilesDir, id, await profileFingerprint(entry)) : null;
      if (!loaded) {
        throw new AppError("This model has not been tuned", {
          code: "profile_missing",
          status: 404,
          why: `There is no saved profile for ${id}.`,
          fix: "Start a tune for it from the Bench panel, or run npm run tune -- --model <id>.",
        });
      }
      sendJson(res, 200, { ...loaded, typeWarnings: typeWarnings(loaded.profile) });
      return;
    }

    if (pathname === "/api/benchmarks/cancel" && method === "POST") {
      if (!benchmarks) throw new AppError("Benchmark runner unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Benchmarks run only on this computer", {
          code: "benchmark_local_only",
          status: 403,
          why: "Only the computer running the benchmark can stop it.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      sendJson(res, 200, { job: benchmarks.cancel() });
      return;
    }

    // IDEA-1198: host-side health receipt. No event-loop monitor, no priority
    // games: one round-trip lag, memory, and what is loaded.
    if (pathname === "/api/health" && method === "GET") {
      const { measureLoopLag } = await import("./system.js");
      const info = systemInfo();
      sendJson(res, 200, {
        app: info.app,
        version: info.version,
        node: info.node,
        platform: info.platform,
        uptime: info.uptime,
        memory: process.memoryUsage(),
        loopLagMs: await measureLoopLag(),
        loadedId: engine?.loadedId ?? null,
      });
      return;
    }

    if (pathname === "/api/settings" && method === "GET") {
      sendJson(res, 200, { settings: settings.value });
      return;
    }

    // IDEA-1077: which server this is, written to server.json at startup.
    if (pathname === "/api/instance" && method === "GET") {
      sendJson(res, 200, { instance: instance ?? { port: null, host: null, startedAt: null } });
      return;
    }

    if (pathname === "/api/settings" && method === "PUT") {
      requireLocalAction(req, {
        code: "settings_local_only",
        message: "Settings are local only",
        why: "Inference settings decide what this computer's model does; a remote client may read them but not change them.",
        fix: "Open the ModelDuck settings on the computer running the server.",
      });
      const body = await readJsonBody(req);
      const next = await settings.update(body.settings ?? body);
      sendJson(res, 200, { settings: next });
      return;
    }

    if (pathname === "/api/server-settings" && method === "GET") {
      if (!serverSettings) throw new AppError("Server settings unavailable", { status: 503 });
      sendJson(res, 200, {
        settings: serverSettings.value,
        apiKeys: serverSettings.listKeys(),
        activeKeys: serverSettings.activeKeys,
      });
      return;
    }

    if (pathname === "/api/server-settings" && method === "PUT") {
      if (!serverSettings) throw new AppError("Server settings unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) throw new AppError("Server settings are local only", { code: "server_settings_local_only", status: 403, why: "Remote clients cannot change the listener, CORS or API keys.", fix: "Open Server settings on the computer running ModelDuck." });
      const body = await readJsonBody(req);
      const next = await serverSettings.update(body.settings ?? body);
      sendJson(res, 200, {
        settings: next,
        apiKeys: serverSettings.listKeys(),
        activeKeys: serverSettings.activeKeys,
        restartRequired: true,
      });
      return;
    }

    if (pathname === "/api/server-settings/api-keys" && method === "POST") {
      if (!serverSettings) throw new AppError("Server settings unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) throw new AppError("Server settings are local only", { code: "server_settings_local_only", status: 403, why: "Remote clients cannot mint API keys.", fix: "Open Server settings on the computer running ModelDuck." });
      const body = await readJsonBody(req);
      const created = await serverSettings.createKey(body.label);
      sendJson(res, 201, {
        key: created.key,
        record: created.record,
        activeKeys: serverSettings.activeKeys,
      });
      return;
    }

    const routeMatch = pathname.match(/^\/api\/server-settings\/api-keys\/([^/]+)$/);
    if (routeMatch && method === "DELETE") {
      if (!serverSettings) throw new AppError("Server settings unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) throw new AppError("Server settings are local only", { code: "server_settings_local_only", status: 403, why: "Remote clients cannot revoke API keys.", fix: "Open Server settings on the computer running ModelDuck." });
      const deleted = await serverSettings.revokeKey(decodeRouteId(routeMatch[1]));
      if (!deleted) {
        throw new AppError("API key not found", {
          code: "api_key_not_found",
          status: 404,
          why: "That API key does not exist.",
          fix: "Refresh Server settings.",
        });
      }
      sendJson(res, 200, { deleted: true, activeKeys: serverSettings.activeKeys });
      return;
    }

    if (pathname === "/api/models" && method === "GET") {
      sendJson(res, 200, {
        models: registry ? await registry.scan() : [],
        modelsDir: registry?.modelsDir ?? null,
      });
      return;
    }
    if (pathname === "/api/models/import" && method === "POST") {
      requireLocalAction(req, {
        code: "model_library_local_only",
        message: "The model library is local only",
        why: "Importing reads a path on this computer and copies a model file into its library.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!registry) throw new AppError("Model library unavailable", { status: 503 });
      const body = await readJsonBody(req);
      const model = await registry.importFromPath(body.path);
      sendJson(res, 201, { model, models: await registry.scan() });
      return;
    }

    if (pathname === "/api/models/open-folder" && method === "POST") {
      requireLocalAction(req, {
        code: "model_library_local_only",
        message: "The model library is local only",
        why: "Opening the folder opens a window on this computer.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!registry) throw new AppError("Model library unavailable", { status: 503 });
      openFolder(registry.modelsDir, logger);
      sendJson(res, 200, { ok: true, path: registry.modelsDir });
      return;
    }

    if (pathname === "/api/models/unload" && method === "POST") {
      requireLocalAction(req, {
        code: "model_library_local_only",
        message: "The model library is local only",
        why: "Unloading frees memory on this computer and ends a model another client may be using.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (engine) {
        // Unloading under a load or a reply would abort a half-built context and
        // report "ready" with a disposed model; refuse instead of racing it.
        const status = await engine.status();
        if (status.status === "loading" || engine.busy) {
          throw new AppError("The model is busy", {
            code: "model_busy",
            status: 409,
            why: "A model is loading or answering; unloading now would abort it.",
            fix: "Wait for the load or the reply to finish, then unload.",
          });
        }
        await engine.unload();
      }
      jit?.clear();
      sendJson(res, 200, { loaded: engine ? await engine.status() : { status: "idle" } });
      return;
    }

    const loadMatch = pathname.match(/^\/api\/models\/([^/]+)\/load$/);
    if (loadMatch && method === "POST") {
      requireLocalAction(req, {
        code: "model_library_local_only",
        message: "The model library is local only",
        why: "Loading a model spends this computer's memory and starts its inference context.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!engine) throw new AppError("Inference engine unavailable", { status: 503 });
      const body = await readJsonBody(req);
      const modelId = decodeRouteId(loadMatch[1]);
      const applied = await tuned.resolve(modelId);
      const loaded = await engine.load({
        modelId,
        contextSize: body.contextSize ?? settings.value.contextSize,
        threads: body.threads ?? settings.value.threads,
        maxThreads: body.maxThreads ?? settings.value.maxThreads,
        batchSize: body.batchSize ?? settings.value.batchSize,
        sequences: body.sequences ?? settings.value.sequences,
        flashAttention: body.flashAttention ?? settings.value.flashAttention,
        useMmap: body.useMmap ?? settings.value.useMmap,
        gpuLayers: body.gpuLayers ?? settings.value.gpuLayers,
        gpuBackend: body.gpuBackend ?? settings.value.gpuBackend,
        checkpoints: body.checkpoints ?? settings.value.checkpoints,
        checkpointInterval: body.checkpointInterval ?? settings.value.checkpointInterval,
        checkpointMax: body.checkpointMax ?? settings.value.checkpointMax,
        kvCache: body.kvCache ?? settings.value.kvCache,
        ...(applied?.settings ?? {}),
        force: body.force === true,
      });
      jit?.clear();
      sendJson(res, 200, { loaded, tuned: tunedInfo(applied) });
      return;
    }

    const modelMatch = pathname.match(/^\/api\/models\/([^/]+)$/);
    if (modelMatch && method === "DELETE") {
      requireLocalAction(req, {
        code: "model_library_local_only",
        message: "The model library is local only",
        why: "Deleting removes a model file from this computer.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!registry) throw new AppError("Model library unavailable", { status: 503 });
      const deleted = await registry.deleteById(decodeRouteId(modelMatch[1]), {
        loadedId: engine?.loadedId ?? null,
      });
      sendJson(res, 200, { deleted, models: await registry.scan() });
      return;
    }

    if (pathname === "/api/catalog" && method === "GET") {
      sendJson(res, 200, {
        catalog: publicCatalog(),
        models: registry ? await registry.scan() : [],
        modelsDir: registry?.modelsDir ?? null,
        downloads: downloads ? downloads.list() : [],
      });
      return;
    }

    if (pathname === "/api/downloads" && method === "GET") {
      sendJson(res, 200, { downloads: downloads ? downloads.list() : [] });
      return;
    }

    if (pathname === "/api/downloads" && method === "POST") {
      requireLocalAction(req, {
        code: "downloads_local_only",
        message: "Downloads are local only",
        why: "A download writes a model file into this computer's library.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!downloads) throw new AppError("Downloads unavailable", { status: 503 });
      const body = await readJsonBody(req);
      const job = await downloads.start(String(body.catalogId ?? body.modelId ?? ""));
      sendJson(res, 202, { download: job });
      return;
    }

    const downloadMatch = pathname.match(/^\/api\/downloads\/([^/]+)$/);
    if (downloadMatch && method === "DELETE") {
      requireLocalAction(req, {
        code: "downloads_local_only",
        message: "Downloads are local only",
        why: "Cancelling a download leaves or removes a partial file on this computer.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!downloads) throw new AppError("Downloads unavailable", { status: 503 });
      const job = await downloads.cancel(decodeRouteId(downloadMatch[1]));
      sendJson(res, 200, { download: job });
      return;
    }

    if (
      pathname === "/v1/models" ||
      pathname.startsWith("/v1/models/") ||
      pathname === "/v1/chat/completions" ||
      pathname === "/v1/completions"
    ) {
      await handleOpenAI(req, res, {
        tuned,
        engine,
        registry,
        settings,
        serverSettings,
        jit,
        logger,
      });
      return;
    }

    if (method === "GET" || method === "HEAD") {
      if (await servePublicFile(req, res, publicDir, pathname)) return;
      sendJson(res, 404, {
        error: {
          code: "not_found",
          message: "Not found",
          why: "ModelDuck has no page at this address.",
          fix: "Open http://127.0.0.1:4141.",
        },
      });
      return;
    }

    throw new AppError("Method not allowed", {
      code: "method_not_allowed",
      status: 405,
      why: `${method} is not supported at ${pathname}.`,
      fix: "Use the ModelDuck web interface or the documented API routes.",
    });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      if (res.headersSent) {
        if (!res.destroyed) res.end();
        return;
      }
      if (error?.status === 500 || !error?.status) {
        logger.error?.(`[modelduck] ${error?.stack || error}`);
      }
      sendError(res, error);
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return server;
}
