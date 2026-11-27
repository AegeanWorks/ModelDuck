import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { AppError } from "./errors.js";
import { detectGpuBackends } from "./gpu-info.js";
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
import { listPublicRebuilds } from "./model-registry.js";
import { currentFingerprint, importRecipe, isPartRun, launchRecipe, listProfiles, loadProfile, loadProfileSlim, profileIdFor, profileRecipe, profileStampFor, saveProfile, typeWarnings } from "./model-profiles.js";
import { SHIPPED_PRESETS_DIR, matchPreset, presetProfile, readShippedPresets } from "./preset-match.js";
import { parseVerifyRequest, runVerified } from "./verified-code.js";
import { networkDenied } from "../benchmarks/sandbox.mjs";
import { answersFile, answerPaceByProfile, listRuns, loadRun, summarizeAnswers } from "./tune-runs.js";

// Test seam: how many profile files the recommendations route actually opened.
let recommendationProfileReads = 0;
export function recommendationProfileReadsCount() {
  return recommendationProfileReads;
}
export function resetRecommendationProfileReads() {
  recommendationProfileReads = 0;
}

// Test seam: how many profile files the tune-overview route actually opened.
let overviewProfileReads = 0;
export function overviewProfileReadCount() {
  return overviewProfileReads;
}
export function resetOverviewProfileReads() {
  overviewProfileReads = 0;
}

// The shipped-preset routes ask for the same model many times. Keep one
// profile-ID map per registry/public-list version, with first-list-order wins
// for duplicate ids just like the old linear find.
let presetModelIndex = new WeakMap();
let presetModelIndexBuildCount = 0;
export function presetModelIndexBuilds() {
  return presetModelIndexBuildCount;
}
export function resetPresetModelIndex() {
  presetModelIndex = new WeakMap();
  presetModelIndexBuildCount = 0;
}
function presetModelIndexFor(registry) {
  if (!registry || typeof registry.listPublic !== "function") return new Map();
  const version = listPublicRebuilds();
  const cached = presetModelIndex.get(registry);
  if (cached?.version === version) return cached.byId;
  const byId = new Map();
  for (const model of registry.listPublic()) {
    const id = profileIdFor(model.fileName);
    if (!byId.has(id)) byId.set(id, model);
  }
  presetModelIndex.set(registry, { version, byId });
  presetModelIndexBuildCount += 1;
  return byId;
}
export function findPresetModel(registry, catalogId) {
  return presetModelIndexFor(registry).get(catalogId) ?? null;
}
import { TunedSettings, diffSettings } from "./tuned-settings.js";
import { EngineRebuildLease, reloadFingerprint } from "./settings-reload.js";
import { readSteps, writeSteps } from "./tune-steps.js";
import { createTuneEstimator, DEFAULT_STEPS, estimateTune, settingNames } from "../benchmarks/tune-grid.mjs";
import { STAGES } from "../benchmarks/tune.mjs";
import { handleOpenAI } from "./openai.js";
import { resolveHuggingFaceReference } from "./hf-reference.js";
import { settingPresets } from "./config.js";
import { recommendCatalog, recommendModels } from "./recommend.js";
import { restartRequiredFor } from "./server-settings.js";
import { machineCatalog } from "./state-machine.js";
import { measureLoopLag, systemInfo } from "./system.js";
import { TASKS } from "../benchmarks/task-ids.mjs";

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
  presetsDir = SHIPPED_PRESETS_DIR,
  // The Node the test sandbox runs on; tests pass another to check version policy.
  nodeVersion = process.versions.node,
  // The machine's memory and CPU; tests pass a fixed one so a recommendation
  // test does not depend on live os.freemem() under load (ADR-134).
  system = systemInfo,
  tuneRunsDir = null,
  profileFingerprint = currentFingerprint,
  tuneStepsFile = null,
  instance = null,
  reloadLease = null,
  // The engines the app can serve with and the check a load makes on a named one (ADR-170).
  engines = null,
}) {
  const tuned = new TunedSettings({ profilesDir, registry, settings, fingerprint: profileFingerprint });
  // IDEA-1098: the release-barriered rebuild lease; off unless the user turns
  // autoReloadOnSettingsChange on, and it always defers to a busy engine.
  // Tests may inject a lease with fast timers; production keeps the defaults.
  const lease = reloadLease ?? (engine ? new EngineRebuildLease({ engine, logger }) : null);
  const tunedInfo = (applied) => applied && { catalogId: applied.catalogId, task: applied.task, speedPreset: applied.speedPreset, stages: applied.stages, systemPrompt: applied.settings.systemPrompt ?? null, rate: applied.rate ?? null, typeWarnings: applied.typeWarnings ?? [], stale: applied.stale, warnings: applied.warnings };

  // Each shipped preset's measured rate for one task, by catalog id (ADR-129). A
  // missing or unreadable presets folder means no evidence, never an error.
  async function shippedRates(task) {
    const recipes = await readShippedPresets(presetsDir).catch(() => []);
    return Object.fromEntries(recipes
      .filter((recipe) => recipe?.catalogId && Number.isFinite(recipe.tasks?.[task]?.stats?.rate))
      .map((recipe) => [recipe.catalogId, { rate: recipe.tasks[task].stats.rate, items: recipe.tasks[task].stats.items ?? null, measuredOn: recipe.fingerprint?.cpu ?? null }]));
  }
  // IDEA-1194/0855: the install receipt as read-only evidence on each model row.
  // A model without a receipt keeps its old shape, so hand-imported files are
  // not labelled as verified downloads.
  async function withArtifacts(models) {
    if (!downloads?.receiptFor || models.length === 0) return models;
    return Promise.all(models.map(async (model) => {
      const receipt = await downloads.receiptFor(model.fileName).catch(() => null);
      if (!receipt || (!receipt.digest && !receipt.sha256)) return model;
      return {
        ...model,
        artifact: {
          digest: typeof receipt.digest === "string" ? receipt.digest : null,
          expectedSha256: typeof receipt.sha256 === "string" ? receipt.sha256 : null,
          sourceUrl: typeof receipt.url === "string" ? receipt.url : null,
          quant: typeof receipt.quant === "string" ? receipt.quant : null,
          downloadedAt: typeof receipt.downloadedAt === "string" ? receipt.downloadedAt : null,
        },
      };
    }));
  }
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
        registry ? withArtifacts(await registry.scan()) : [],
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
        restartRequired: serverSettings ? restartRequiredFor(instance, serverSettings.value) : null,
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
      const backends = await detectGpuBackends();
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
      // Only this route needs the full prompt suite; loading it here keeps the
      // server's startup import graph free of every benchmark item module.
      const [{ suiteSummary }, { multistepSummary }] = await Promise.all([
        import("../benchmarks/tasks.mjs"),
        import("../benchmarks/multistep-items.mjs"),
      ]);
      // The opt-in multistep chains sit beside the tuned tasks; they are not one of them.
      sendJson(res, 200, { ...suiteSummary(), multistep: multistepSummary() });
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
      // listProfiles is directory-stamp cached; probe it once so an unprofiled
      // library does not pay a failing loadProfile per model.
      const savedOverviewIds = profilesDir
        ? new Set((await listProfiles(profilesDir)).map((profile) => profile.catalogId))
        : new Set();
      const listed = registry.listPublic().map((model) => ({ model, profileId: profileIdFor(model.fileName) }));
      // Saved profiles are independent files; gather them concurrently, then
      // build the response in the original model order.
      const loaded = await Promise.all(listed.map(async ({ model, profileId }) => {
        if (!profilesDir || !savedOverviewIds.has(profileId)) return null;
        overviewProfileReads += 1;
        return loadProfileSlim(profilesDir, profileId, await profileFingerprint(model), profileStampFor(profilesDir, profileId)).catch(() => null);
      }));
      const models = listed.map(({ model, profileId }, index) => {
        const entry = loaded[index];
        const { sweeps: _sweeps, progress: _progress, ...profile } = entry?.profile ?? {};
        return {
          id: model.id,
          name: model.name,
          fileName: model.fileName,
          profileId,
          profile: entry ? profile : null,
          stale: entry?.stale ?? [],
          staleParts: entry?.staleParts ?? [],
          deviceParts: entry?.deviceParts ?? [],
          warnings: entry?.warnings ?? [],
          typeWarnings: entry?.typeWarnings ?? {},
        };
      });
      sendJson(res, 200, { models });
      return;
    }

    // What to run on this machine: measured models first, then catalog estimates (ADR-069).
    if (pathname === "/api/recommendations" && method === "GET") {
      const wanted = new URL(req.url, "http://localhost").searchParams.get("task") ?? "code";
      const task = TASKS.some((item) => item.id === wanted) ? wanted : "code";
      const machine = system();
      const memory = { free: machine.freeMemory, total: machine.totalMemory };
      const models = registry.listPublic().map((model) => ({ ...model, profileId: profileIdFor(model.fileName) }));
      // listProfiles is already directory-stamp cached; use it to skip a
      // per-model failing read for libraries with few or no saved profiles.
      const savedIds = profilesDir
        ? new Set((await listProfiles(profilesDir)).map((profile) => profile.catalogId))
        : new Set();
      // Independent profile reads; Promise.all keeps the same insertion order
      // of `profiles` as the original sequential loop.
      const loaded = await Promise.all(models.map(async (model) => {
        if (!profilesDir || !savedIds.has(model.profileId)) return null;
        recommendationProfileReads += 1;
        return loadProfileSlim(profilesDir, model.profileId, await profileFingerprint(model), profileStampFor(profilesDir, model.profileId)).catch(() => null);
      }));
      const profiles = {};
      models.forEach((model, index) => {
        profiles[model.profileId] = loaded[index]?.profile ?? null;
      });
      sendJson(res, 200, {
        task,
        memory,
        installed: recommendModels({ models, profiles, memory, task }),
        catalog: recommendCatalog({ catalog: publicCatalog(), installed: models.map((model) => model.id), memory, measured: await shippedRates(task) }),
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
      // The tune loads its own copy in child processes. A model already resident in the app
      // competes for memory and cores, so say so; unloading it is the person's choice.
      const warnings = engine?.loadedId
        ? [{
            code: "resident_model",
            why: "A model is already loaded in the app; the tune loads its own copy, so both compete for memory and cores and the measurements can be slower or the load refused.",
            fix: "Unload the model in Models before tuning for the cleanest results.",
          }]
        : [];
      sendJson(res, 202, {
        warnings,
        job: tunes.start({
          models,
          tasks,
          stages,
          settings: only,
          force: body.force === true,
          continueRun: body.continue === true,
          quick: body.quick === true,
          quickOnly: body.quickOnly === true,
          guard: body.guard === true,
          guardQueue: body.guardQueue === true,
          // Minutes per model; the scheduler refuses anything but a sensible number.
          budgetMinutes: body.budgetMinutes ?? null,
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
      const estimator = createTuneEstimator(result.steps, { logicalCores, tasks, stages, only });
      const perModel = installed.map((model) => {
        const profileId = profileIdFor(model.fileName);
        const pace = paces.get(profileId) ?? null;
        // Without history, keep the conservative fixed pace.
        const seconds = pace?.secondsPerAnswer ?? 3;
        const low = pace?.low ?? seconds;
        const high = pace?.high ?? seconds;
        const quickMid = estimator.estimate(true, seconds);
        const fullMid = estimator.estimate(false, seconds);
        const quickLow = estimator.estimate(true, low);
        const quickHigh = estimator.estimate(true, high);
        const fullLow = estimator.estimate(false, low);
        const fullHigh = estimator.estimate(false, high);
        return {
          id: model.id,
          name: model.name,
          profileId,
          pace,
          quick: { ...quickMid, lowSeconds: Math.min(quickLow.estimate.onePassSeconds, quickHigh.estimate.onePassSeconds), highSeconds: Math.max(quickLow.estimate.onePassSeconds, quickHigh.estimate.onePassSeconds) },
          full: { ...fullMid, lowSeconds: Math.min(fullLow.estimate.onePassSeconds, fullHigh.estimate.onePassSeconds), highSeconds: Math.max(fullLow.estimate.onePassSeconds, fullHigh.estimate.onePassSeconds) },
        };
      });
      const quick = perModel[0]?.quick ?? estimator.estimate(true, 3);
      sendJson(res, 200, {
        tasks,
        stages,
        settings: only,
        logicalCores,
        models: perModel.length,
        perModel,
        answersPerModel: perModel[0]?.full.answersPerModel ?? estimator.estimate(false, 3).answersPerModel,
        estimate: perModel[0]?.full.estimate ?? estimator.estimate(false, 3).estimate,
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

    // Verified code (src/verified-code.js): answers are checked against the caller's
    // tests in the node --permission sandbox. It runs caller-supplied code, so it is
    // this computer only, whatever the LAN setting, and every input is capped.
    if (pathname === "/api/code/verify" && method === "POST") {
      requireLocalAction(req, {
        code: "verify_local_only",
        message: "Verified code runs only on this computer",
        why: "It runs the tests you send as code on this computer.",
        fix: "Call it from the computer running ModelDuck (127.0.0.1).",
      });
      if (!engine) throw new AppError("Inference engine unavailable", { status: 503 });
      // The code it runs comes from a caller and a model; before Node 25 the sandbox cannot deny the network.
      if (!networkDenied(nodeVersion)) {
        throw new AppError("Verified code needs a newer Node", {
          code: "verify_sandbox_weak",
          status: 503,
          why: `On Node ${nodeVersion} the permission model blocks files, processes and workers but not the network, and this route runs code it is sent.`,
          fix: "Run ModelDuck on Node 25 or newer to use /api/code/verify. Tuning and benchmarks still work on this Node.",
        });
      }
      const request = parseVerifyRequest(await readJsonBody(req, { limitBytes: 256 * 1024 }));
      const modelId = engine.loadedId;
      if (!modelId) {
        throw new AppError("No model is loaded", {
          code: "model_not_loaded",
          status: 409,
          why: "Verified code needs a loaded model to answer.",
          fix: "Open Models, load an installed model, then send the request again.",
        });
      }
      // The tuned code preset decides how the model answers; the request still decides the budget.
      const applied = await tuned.resolve(modelId, "code").catch(() => null);
      // A client that disconnects stops the loop and the answer being written.
      const clientGone = new AbortController();
      let finished = false;
      res.on("close", () => { if (!finished) clientGone.abort(); });
      let result;
      try {
        result = await runVerified({ engine, request, settings: { ...settings.value, ...(applied?.settings ?? {}) }, signal: clientGone.signal });
      } finally {
        finished = true;
      }
      if (result.stopped === "client_closed") return;
      sendJson(res, 200, { model: modelId, ...result });
      return;
    }

    // Shipped presets (benchmarks/presets): how each fits this computer, before anything is applied.
    if (pathname === "/api/presets" && method === "GET") {
      const byProfileId = presetModelIndexFor(registry);
      const presets = [];
      for (const recipe of await readShippedPresets(presetsDir)) {
        const entry = byProfileId.get(recipe.catalogId) ?? null;
        const match = entry ? matchPreset(recipe, await profileFingerprint(entry)) : { status: "not_installed", keeps: [], reasons: [], next: null };
        const rates = Object.fromEntries(Object.entries(recipe.tasks ?? {}).map(([task, preset]) => [task, { rate: preset?.stats?.rate ?? null, items: preset?.stats?.items ?? null }]));
        presets.push({ catalogId: recipe.catalogId, modelId: entry?.id ?? null, measuredAt: recipe.createdAt ?? null, measuredOn: recipe.fingerprint?.cpu ?? null, rates, ...match });
      }
      sendJson(res, 200, { presets });
      return;
    }

    // Apply a shipped preset on request (G-004: never automatically). It is an
    // imported profile (ADR-067) and never replaces one tuned here unless asked.
    if (pathname === "/api/presets/apply" && method === "POST") {
      if (!profilesDir) throw new AppError("Profiles are unavailable", { status: 503 });
      if (!isLoopbackRequest(req)) {
        throw new AppError("Presets apply only on this computer", {
          code: "profile_local_only",
          status: 403,
          why: "Applying a preset changes this computer's settings.",
          fix: "Open the ModelDuck UI on the computer running the server.",
        });
      }
      const body = await readJsonBody(req);
      const catalogId = String(body.catalogId ?? "");
      const recipe = (await readShippedPresets(presetsDir)).find((item) => item.catalogId === catalogId);
      if (!recipe) {
        throw new AppError("There is no shipped preset for that model", {
          code: "preset_missing",
          status: 404,
          why: `No preset in benchmarks/presets is for "${catalogId}".`,
          fix: "Tune this model instead: Bench & Tune → Quick pass.",
        });
      }
      const entry = findPresetModel(registry, catalogId);
      if (!entry) {
        throw new AppError("That model is not installed", {
          code: "profile_model_missing",
          status: 422,
          why: `The preset is for ${catalogId}, which is not in the model folder.`,
          fix: "Download that model from Models → Discover, then apply the preset.",
        });
      }
      const fingerprint = await profileFingerprint(entry);
      const existing = await loadProfile(profilesDir, catalogId, fingerprint).catch(() => null);
      if (existing && !existing.profile.search?.imported && body.force !== true) {
        throw new AppError("This model already has a profile tuned on this computer", {
          code: "preset_would_replace_tune",
          status: 409,
          why: "A preset measured elsewhere would replace settings measured here.",
          fix: "Keep the tuned profile, or apply the preset again with force to replace it.",
        });
      }
      const match = matchPreset(recipe, fingerprint);
      await saveProfile(profilesDir, presetProfile(recipe, match));
      const loaded = await loadProfile(profilesDir, catalogId, fingerprint);
      sendJson(res, 201, { catalogId, status: match.status, keeps: match.keeps, reasons: match.reasons, next: match.next, warnings: loaded?.warnings ?? [] });
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
      const info = systemInfo();
      const engineState = engine ? await engine.status() : null;
      sendJson(res, 200, {
        app: info.app,
        version: info.version,
        node: info.node,
        platform: info.platform,
        uptime: info.uptime,
        memory: process.memoryUsage(),
        loopLagMs: await measureLoopLag(),
        loadedId: engine?.loadedId ?? engineState?.model?.id ?? null,
        // AX: subsystems and their state vocabulary, readable without the source.
        phase: engine?.phase ?? engineState?.status ?? "idle",
        jit: jit ? { trackedId: jit.trackedId ?? null, armed: Boolean(jit.armed) } : null,
        registry: registry ? { size: registry.size, ...(typeof registry.scanStats === "function" ? registry.scanStats() : {}) } : null,
        machines: machineCatalog(),
      });
      return;
    }

    if (pathname === "/api/settings" && method === "GET") {
      // IDEA-1098: the fingerprint of the reload-affecting settings, so the
      // caller can compare against the live engine's exposed fingerprint,
      // plus a read-only lease snapshot so a deferred rebuild and its last
      // failure (e.g. MODEL_DISPOSE_FAILED) are observable after the PUT.
      sendJson(res, 200, {
        settings: settings.value,
        settingsFingerprint: reloadFingerprint(settings.value),
        reload: lease ? lease.status() : null,
      });
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
      // IDEA-1098: whether the live engine differs from the new ask, and (with
      // autoReloadOnSettingsChange) whether the lease scheduled the rebuild.
      const reload = lease
        ? lease.update(next)
        : { required: false, fingerprint: reloadFingerprint(next), scheduled: false };
      sendJson(res, 200, { settings: next, reload });
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
        // Only a listener change needs a restart; auth/CORS/JIT apply now.
        restartRequired: restartRequiredFor(instance, next),
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
        models: registry ? await withArtifacts(await registry.scan()) : [],
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

    // IDEA-0995: one validated Hugging Face file, downloaded like a catalog
    // entry but with its own source URL and no curated hash unless the user
    // pins one. The reference is resolved before any network request.
    if (pathname === "/api/models/add-hf" && method === "POST") {
      requireLocalAction(req, {
        code: "model_library_local_only",
        message: "The model library is local only",
        why: "Adding a download changes files on this computer.",
        fix: "Open the ModelDuck UI on the computer running the server.",
      });
      if (!downloads) throw new AppError("Downloads unavailable", { code: "downloads_unavailable", status: 503 });
      const body = await readJsonBody(req);
      const reference = resolveHuggingFaceReference(body.reference);
      const inspected = await downloads.inspectSource({ url: reference.url, sha256: body.sha256 });
      const job = await downloads.startSource({
        url: reference.url,
        file: reference.fileName,
        name: reference.name,
        size: inspected.size,
        sha256: inspected.sha256,
      });
      sendJson(res, 202, {
        job,
        reference: {
          repo: reference.repo,
          revision: reference.revision,
          fileName: reference.fileName,
          url: reference.url,
        },
      });
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

    if (pathname === "/api/engines" && method === "GET") {
      const model = url.searchParams.get("model");
      sendJson(res, 200, engines ? await engines.list(model) : { engines: [], fastest: null });
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
      const chosen = typeof body.engine === "string" && body.engine !== "" ? body.engine : null;
      if (chosen) {
        if (!engines) throw new AppError("Engine choice unavailable", { status: 503, code: "engine_unknown", why: "This server was started without an engine catalog.", fix: "Leave engine out to use the default engine." });
        engines.assertServable(chosen);
      }
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
        ...(chosen ? { engine: chosen } : {}),
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
        models: registry ? await withArtifacts(await registry.scan()) : [],
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

  server.on("close", () => {
    lease?.dispose();
  });

  return server;
}
