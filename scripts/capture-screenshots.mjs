import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets", "screenshots");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeout = 20_000, interval = 100) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await check()) return true;
    } catch {
      // The server or browser may still be starting.
    }
    await delay(interval);
  }
  return false;
}

function browserCandidates() {
  if (process.platform === "win32") {
    return [
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

const QWEN = "qwen2.5-coder-1.5b-instruct-q4-k-m";
const PHI = "phi-3.5-mini-instruct-q4-k-m";
const QWEN_FILE = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
const PHI_FILE = "phi-3.5-mini-instruct-q4_k_m.gguf";

const models = [
  { id: "qwen-coder", name: "Qwen2.5 Coder 1.5B Instruct", fileName: QWEN_FILE, size: 1_116_669_952, sizeLabel: "1.04 GB", params: "1.5B", quant: "Q4_K_M", contextLength: 32768, blocked: false, unreadable: false },
  { id: "phi-mini", name: "Phi-3.5 mini 3.8B Instruct", fileName: PHI_FILE, size: 2_393_000_000, sizeLabel: "2.23 GB", params: "3.8B", quant: "Q4_K_M", contextLength: 131072, blocked: false, unreadable: false },
];

const qwenTasks = {
  code: { settings: { temperature: 0.2, maxTokens: 512, repeatPenalty: 1.05, systemPrompt: "You are a precise coding assistant." }, stats: { rate: 83.6, ci95: { low: 80.1, high: 86.7 }, outputTokens: 318, vsDefault: { rateDelta: 6.1, pValue: 0.004 } } },
  comprehension: { settings: { temperature: 0.2, maxTokens: 256, systemPrompt: "Read the code carefully before answering." }, stats: { rate: 79.4, ci95: { low: 74.8, high: 83.4 }, outputTokens: 142, vsDefault: { rateDelta: 3.7, pValue: 0.018 } } },
  recall: { settings: { temperature: 0, maxTokens: 256, systemPrompt: "Find the exact passage in the document." }, stats: { rate: 71.8, ci95: { low: 66.2, high: 76.8 }, outputTokens: 168, vsDefault: { rateDelta: 2.2, pValue: 0.061 } } },
};

const qwenProfile = {
  schema: 1,
  catalogId: QWEN,
  createdAt: "2026-11-01T12:40:00.000Z",
  fingerprint: { suiteVersion: 14, cpu: "Intel Core i5-14400F", nodeLlamaCpp: "3.22.2" },
  device: { settings: { gpuBackend: "vulkan", gpuLayers: 99 }, reason: "Vulkan was 31% faster with the same answers." },
  load: { settings: { contextSize: 8192, kvCache: "q8_0", flashAttention: "on", useMmap: true, batchSize: 512, threads: 8, gpuBackend: "vulkan", gpuLayers: 99 } },
  speed: { fastest: { batchSize: 512, threads: 8 }, light: { batchSize: 256, threads: 4 }, quiet: { batchSize: 128, threads: 2 } },
  stages: { device: "done", quality: "done", speed: "done", sampling: { code: "done", comprehension: "done", recall: "done" }, prompt: { code: "done", comprehension: "done", recall: "done" } },
  tasks: qwenTasks,
  warnings: [],
};

const phiProfile = {
  ...qwenProfile,
  catalogId: PHI,
  createdAt: "2026-10-30T18:20:00.000Z",
  device: { settings: { gpuBackend: "vulkan", gpuLayers: 99 }, reason: "Vulkan was 24% faster with the same answers." },
  stages: { device: "done", quality: "done", speed: "done", sampling: { code: "done", comprehension: "done", recall: "done" }, prompt: { code: "done", comprehension: "done", recall: "done" } },
  tasks: {
    code: { ...qwenTasks.code, stats: { ...qwenTasks.code.stats, rate: 81.9, ci95: { low: 78.2, high: 85.1 } } },
    comprehension: { ...qwenTasks.comprehension, stats: { ...qwenTasks.comprehension.stats, rate: 76.8, ci95: { low: 71.9, high: 81.0 } } },
    recall: { ...qwenTasks.recall, stats: { ...qwenTasks.recall.stats, rate: 69.3, ci95: { low: 63.5, high: 74.5 } } },
  },
};

const overview = {
  models: models.map((model, index) => ({
    id: model.id,
    name: model.name,
    fileName: model.fileName,
    profileId: index === 0 ? QWEN : PHI,
    profile: index === 0 ? qwenProfile : phiProfile,
    stale: [],
    staleParts: [],
    deviceParts: [],
    warnings: [],
    typeWarnings: {},
  })),
};

const job = {
  id: "demo-tune-20261101",
  status: "running",
  paused: false,
  startedAt: "2026-11-01T15:00:00.000Z",
  finishedAt: null,
  stages: ["device", "quality", "speed", "sampling", "prompt"],
  tasks: ["code", "comprehension", "recall"],
  settings: null,
  force: false,
  continueRun: false,
  quick: true,
  guard: true,
  guardQueue: false,
  order: [PHI, QWEN],
  items: [
    {
      id: "phi-mini", profileId: PHI, name: "Phi-3.5 mini 3.8B", fileName: PHI_FILE,
      lane: "gpu", phase: "tune", status: "running", guard: null, provisional: true, exitCode: null, error: null, log: [],
      progress: { type: "tune-candidate", stage: "sampling", task: "code", axis: "temperature", rung: 12, eta: "about 1 h 08 min left" },
      live: {
        expectedAnswers: 5838, answers: 1512, eta: "about 1 h 08 min left",
        axis: { key: "temperature", stage: "sampling", task: "code", axis: "temperature", candidates: [
          { patch: { temperature: 0 }, rung: 12, rate: 74.2, latencyMs: 420, outputTokens: 312 },
          { patch: { temperature: 0.2 }, rung: 12, rate: 76.1, latencyMs: 410, outputTokens: 308 },
          { patch: { temperature: 0.4 }, rung: 24, rate: 72.8, latencyMs: 430, outputTokens: 322 },
        ] },
        decisions: [
          { stage: "prompt", task: "code", axis: "systemPrompt", winner: { systemPrompt: "You are a precise coding assistant." }, changed: true, kept: "clear gain on 12 items" },
          { stage: "sampling", task: "comprehension", axis: "temperature", winner: { temperature: 0.2 }, changed: true, kept: "kept on the second rung" },
        ],
      },
    },
    {
      id: "qwen-coder", profileId: QWEN, name: "Qwen2.5 Coder 1.5B", fileName: QWEN_FILE,
      lane: "cpu", phase: null, status: "queued", guard: null, provisional: false, exitCode: null, error: null, log: [],
      progress: null,
      live: { expectedAnswers: 5838, answers: 0, eta: null, axis: null, decisions: [] },
    },
  ],
};

const runs = [
  {
    schema: 1, id: "2026-11-01T12-40-00-000Z-4242", pid: 4242, profileId: QWEN, model: QWEN_FILE,
    request: { stages: ["device", "quality", "speed", "sampling", "prompt"], tasks: ["code", "comprehension", "recall"], only: null, force: false, continueRun: false },
    fingerprint: { suiteVersion: 14, cpu: "Intel Core i5-14400F", nodeLlamaCpp: "3.22.2" },
    expectedAnswers: 17532, startedAt: "2026-11-01T12:40:00.000Z", updatedAt: "2026-11-01T12:56:24.000Z", finishedAt: "2026-11-01T12:56:24.000Z",
    durationMs: 984000, outcome: "done", error: null, answers: 5838,
    result: { load: { settings: { gpuBackend: "vulkan" } }, tasks: qwenTasks },
  },
  {
    schema: 1, id: "2026-11-01T10-12-00-000Z-3121", pid: 3121, profileId: PHI, model: PHI_FILE,
    request: { stages: ["device", "quality", "speed", "sampling", "prompt"], tasks: ["code"], only: null, force: false, continueRun: false },
    fingerprint: { suiteVersion: 14, cpu: "Intel Core i5-14400F", nodeLlamaCpp: "3.22.2" },
    expectedAnswers: 5838, startedAt: "2026-11-01T10:12:00.000Z", updatedAt: "2026-11-01T10:31:20.000Z", finishedAt: "2026-11-01T10:31:20.000Z",
    durationMs: 1160000, outcome: "stopped", error: "Run budget reached; resume to continue", answers: 3901,
    result: { load: { settings: { gpuBackend: "vulkan" } }, tasks: { code: phiProfile.tasks.code } },
  },
  {
    schema: 1, id: "2026-10-31T18-20-00-000Z-2201", pid: 2201, profileId: PHI, model: PHI_FILE,
    request: { stages: ["device", "quality", "speed"], tasks: ["code", "comprehension", "recall"], only: null, force: true, continueRun: false },
    fingerprint: { suiteVersion: 13, cpu: "Intel Core i5-14400F", nodeLlamaCpp: "3.22.2" },
    expectedAnswers: 1100, startedAt: "2026-10-31T18:20:00.000Z", updatedAt: "2026-10-31T18:29:00.000Z", finishedAt: "2026-10-31T18:29:00.000Z",
    durationMs: 540000, outcome: "done", error: null, answers: 1042,
    result: { load: { settings: { gpuBackend: "cpu" } }, tasks: {} },
  },
  {
    schema: 1, id: "2026-10-30T16-03-00-000Z-1102", pid: 1102, profileId: QWEN, model: QWEN_FILE,
    request: { stages: ["quality", "sampling"], tasks: ["code"], only: null, force: false, continueRun: false },
    fingerprint: { suiteVersion: 13, cpu: "Intel Core i5-14400F", nodeLlamaCpp: "3.22.2" },
    expectedAnswers: 2400, startedAt: "2026-10-30T16:03:00.000Z", updatedAt: "2026-10-30T16:05:30.000Z", finishedAt: null,
    durationMs: 150000, outcome: "interrupted", error: "The app closed while the tune was running", answers: 314,
    result: { load: { settings: { gpuBackend: "vulkan" } }, tasks: {} },
  },
];

const runDetail = {
  run: runs[0],
  answers: {
    answers: 5838, right: 82.8, errors: 3, wrong: 981, unreadable: 12,
    ms: { median: 412, p90: 1080 }, outputTokens: { mean: 247.4 },
    unreadableExamples: [
      { item: "comprehension-fn-07", text: "The function returns twice, but the reply did not name a value." },
      { item: "code-bug-03", text: "" },
    ],
  },
};

const estimate = {
  tasks: ["code", "comprehension", "recall"],
  stages: ["device", "quality", "speed", "sampling", "prompt"],
  settings: null,
  logicalCores: 16,
  models: 2,
  perModel: [
    { id: "qwen-coder", name: "Qwen2.5 Coder 1.5B", profileId: QWEN, pace: { secondsPerAnswer: 1.8, low: 1.4, high: 2.6, samples: 3 }, quick: { answersPerModel: 5838, estimate: { onePassSeconds: 17639 }, lowSeconds: 11200, highSeconds: 20300 }, full: { answersPerModel: 17532, estimate: { onePassSeconds: 51515 }, lowSeconds: 36000, highSeconds: 63500 } },
    { id: "phi-mini", name: "Phi-3.5 mini 3.8B", profileId: PHI, pace: { secondsPerAnswer: 2.1, low: 1.6, high: 3.0, samples: 2 }, quick: { answersPerModel: 5838, estimate: { onePassSeconds: 19500 }, lowSeconds: 13100, highSeconds: 23800 }, full: { answersPerModel: 17532, estimate: { onePassSeconds: 56800 }, lowSeconds: 41000, highSeconds: 72100 } },
  ],
  answersPerModel: 17532,
  estimate: { onePassSeconds: 51515 },
  quick: { answersPerModel: 5838, estimate: { onePassSeconds: 17639 } },
};

const recommendations = {
  task: "code",
  memory: { free: 12.4 * 1024 ** 3, total: 32 * 1024 ** 3 },
  installed: [
    { name: "Qwen2.5 Coder 1.5B", fileName: QWEN_FILE, rate: 83.6, tokensPerSecond: 42.8, memoryBytes: 1_116_669_952, contextSize: 8192, fit: "comfortable", why: "Fits with 8 GiB to spare." },
    { name: "Phi-3.5 mini 3.8B", fileName: PHI_FILE, rate: 81.9, tokensPerSecond: 31.2, memoryBytes: 2_393_000_000, contextSize: 8192, fit: "tight", why: "Fits with 3.2 GiB to spare." },
  ],
  catalog: [],
};

const phaseItems = {
  rate: 88.1, ci95: { low: 84.6, high: 91.0 },
  byOrigin: { own: { passed: 201, total: 226, rate: 88.9 }, public: { passed: 40, total: 48, rate: 83.3 } },
  byCategory: {
    code: { passed: 112, total: 136, rate: 82.4, ci95: { low: 75.1, high: 88.0 } },
    "code-comprehension": { passed: 49, total: 54, rate: 90.7, ci95: { low: 79.7, high: 96.2 } },
    "long-context": { passed: 40, total: 42, rate: 95.2, ci95: { low: 84.2, high: 99.2 } },
  },
  byDataset: {
    ModelDuck: { passed: 201, total: 226, rate: 88.9 },
    "GSM8K / MMLU / TruthfulQA": { passed: 40, total: 48, rate: 83.3 },
  },
};

const report = {
  available: true,
  currentSuiteVersion: 14,
  phases: [{
    phase: "model", suiteVersion: 14, testHash: "8f3c2a1d",
    checksPassed: 241, checksTotal: 262, quality: 92.9, tokensPerSecond: 41.8, runtimeMs: 184000, firstTokenMs: 210,
    items: phaseItems,
    tests: [
      { label: "code", dataset: "ModelDuck", origin: "own", passed: 112, total: 136, percent: 82.4 },
      { label: "code comprehension", dataset: "ModelDuck", origin: "own", passed: 49, total: 54, percent: 90.7 },
      { label: "long context", dataset: "ModelDuck", origin: "own", passed: 40, total: 42, percent: 95.2 },
      { label: "public coding", dataset: "GSM8K / MMLU / TruthfulQA", origin: "public", passed: 40, total: 48, percent: 83.3 },
    ],
    commit: { hash: "6efaa99", subject: "feat(tune): add measured preflight, durable queue and baseline guard" },
  }],
  history: [
    { recordedAt: "2026-11-01T12:59:00.000Z", phase: "model", quality: 92.9, tokensPerSecond: 41.8, runtimeMs: 184000, commit: { hash: "6efaa99" } },
    { recordedAt: "2026-10-31T18:31:00.000Z", phase: "model", quality: 89.2, tokensPerSecond: 39.4, runtimeMs: 201000, commit: { hash: "df317b8" } },
  ],
  recommendations: { available: false },
  recommendationsTitle: "Recommended configurations",
  chatBase: null,
};

const fixture = { models, overview, job, runs, runDetail, estimate, report, recommendations, qwenProfile };

function fixtureScript(fixtureValue, state) {
  return `(() => {
    const fixture = ${JSON.stringify({ ...fixtureValue, state })};
    const realFetch = window.fetch.bind(window);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    const shotJob = new URLSearchParams(location.search).get("shot") === "running" ? fixture.job : null;
    window.EventSource = class { close() {} addEventListener() {} };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin);
      const method = String(init.method ?? (typeof input === "string" ? "GET" : input.method) ?? "GET").toUpperCase();
      if (url.pathname === "/api/state") return json(fixture.state);
      if (url.pathname === "/api/models") return json({ models: fixture.models, modelsDir: fixture.state.modelsDir });
      if (url.pathname === "/api/catalog") return json({ catalog: fixture.state.catalog ?? [], models: fixture.models, modelsDir: fixture.state.modelsDir, downloads: [] });
      if (url.pathname === "/api/tune/overview") return json(fixture.overview);
      if (url.pathname === "/api/tune/status") return json({ job: shotJob });
      if (url.pathname === "/api/tune/estimate") return json(fixture.estimate);
      if (url.pathname === "/api/tune/runs") return json({ runs: fixture.runs });
      if (url.pathname.startsWith("/api/tune/runs/") && !url.pathname.endsWith("/answers")) return json(fixture.runDetail);
      if (url.pathname === "/api/benchmarks") return json(fixture.report);
      if (url.pathname === "/api/benchmarks/status") return json({ job: null });
      if (url.pathname === "/api/recommendations") return json(fixture.recommendations);
      if (url.pathname === "/api/profiles/qwen2.5-coder-1.5b-instruct-q4-k-m") return json({ profile: fixture.qwenProfile });
      if (url.pathname === "/api/tune/priority" && method === "POST") return json({ job: fixture.job });
      return realFetch(input, init);
    };
  })();`;
}

async function main() {
  if (typeof WebSocket !== "function") throw new Error("Node 22+ is needed for the built-in WebSocket");
  const browserPath = browserCandidates().find((candidate) => existsSync(candidate));
  if (!browserPath) throw new Error("No Edge or Chrome found");
  await mkdir(OUT, { recursive: true });

  const home = await mkdtemp(path.join(os.tmpdir(), "modelduck-shots-"));
  const port = await freePort();
  const cdpPort = await freePort();
  const profile = path.join(home, "browser-profile");
  await mkdir(profile, { recursive: true });
  let server = null;
  let browser = null;
  let ws = null;
  try {
    server = spawn(process.execPath, ["src/main.js", "--port", String(port), "--home", home, "--no-open"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const healthy = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);
    if (!healthy) throw new Error("ModelDuck did not start");
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    state.models = models;
    state.modelsDir = "C:\\ModelDuck\\Demo\\models";
    state.loaded = { status: "idle", model: null };
    const script = fixtureScript(fixture, state);

    browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
    const pages = await (async () => {
      let found = null;
      await waitFor(async () => {
        found = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        return Boolean(found?.length);
      });
      return found;
    })();
    if (!pages?.length) throw new Error("No browser page");
    ws = new WebSocket(pages.find((item) => item.type === "page")?.webSocketDebuggerUrl ?? pages[0].webSocketDebuggerUrl);
    const pending = new Map();
    let id = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = ++id;
      const timer = setTimeout(() => {
        pending.delete(messageId);
        reject(new Error(`CDP ${method} timed out`));
      }, 30_000);
      pending.set(messageId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    });
    ws.onclose = () => {
      for (const { reject } of pending.values()) reject(new Error("The browser closed the capture connection"));
      pending.clear();
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: script });

    const shots = [];
    const capture = async (name, title, caption) => {
      await delay(280);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(path.join(OUT, name), Buffer.from(shot.data, "base64"));
      const viewport = await evaluate("({ width: innerWidth, height: innerHeight })");
      shots.push({ file: name, title, caption, viewport: `${viewport.width}x${viewport.height}` });
    };
    const scrollToQueue = async () => {
      const state = await evaluate(`(() => {
        const body = document.querySelector(".bench-shell .benchmark-body");
        const targets = [...document.querySelectorAll("[data-tune-move]")];
        const target = targets.find((item) => item.getClientRects().length) ?? targets[0];
        if (!body || !target) return { found: false, scrollTop: body?.scrollTop ?? 0 };
        const top = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 120;
        body.scrollTop = Math.max(0, top);
        return { found: true, scrollTop: body.scrollTop };
      })()`);
      await delay(300);
      return state;
    };
    const viewport = async (width, height, mobile = false) => {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
      await delay(180);
    };
    const navigate = async (query = "") => {
      await send("Page.navigate", { url: `http://127.0.0.1:${port}/${query}` });
      await waitFor(() => evaluate('Boolean(document.querySelector(".dashboard"))'));
      await delay(500);
    };
    const openBench = async () => {
      await evaluate('document.getElementById("open-benchmarks").click(), true');
      await waitFor(() => evaluate('document.getElementById("benchmark-dialog").open'));
      await delay(350);
    };
    const openTab = async (tab) => {
      await evaluate(`document.querySelector('[data-bench-tab="${tab}"]').click(), true`);
      await evaluate('document.querySelector(".bench-shell .benchmark-body").scrollTop = 0, true');
      await delay(350);
    };
    const benchScroll = async (share) => {
      await evaluate(`(() => { const body = document.querySelector(".bench-shell .benchmark-body"); body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) * ${share}); return body.scrollTop; })()`);
      await delay(280);
    };
    const close = async () => {
      await evaluate('document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()), true');
      await delay(200);
    };

    await viewport(1440, 900);
    await navigate();
    await capture("01-overview.png", "Overview", "The workbench at a glance: runtime, installed models, tuned profiles and the local API.");
    await evaluate('document.getElementById("open-models").click(), true');
    await waitFor(() => evaluate('document.getElementById("models-dialog").open'));
    await evaluate('document.querySelector(\'[data-tab="installed"]\').click(), true');
    await delay(350);
    await capture("02-models-installed.png", "Installed models", "Two local GGUF models, ready to load or tune.");
    await evaluate('document.querySelector(\'[data-tab="discover"]\').click(), true');
    await delay(350);
    await capture("03-models-discover.png", "Discover models", "Catalog models sized for this machine.");
    await close();

    await openBench();
    await openTab("tune");
    await capture("04-bench-tune-idle.png", "Tune workspace", "Task scope, quick/full estimates from measured pace, Quick pass and guard controls.");
    await benchScroll(0.55);
    await capture("04b-bench-tune-controls.png", "Tune controls", "Quick pass, pause, cancel, guard and background controls.");
    await benchScroll(0);
    await evaluate('document.querySelector("#tune-help summary").click(), true');
    await delay(300);
    await capture("05-bench-tune-help.png", "Tuning help", "The five stages, increasing rungs, clear-gain rule and held-back check.");
    await evaluate('document.querySelector("#tune-help summary").click(), true');
    await openTab("models");
    await capture("06-bench-models.png", "Tuned profiles", "Per-model device, stage progress and right answers for every task.");
    await evaluate('document.querySelector("[data-tune-details]")?.click(), true');
    await delay(400);
    await capture("07-bench-model-details.png", "Profile details", "The measured load shape, speed presets and task settings behind a profile.");
    await openTab("runs");
    await capture("08-bench-runs.png", "Run history", "Every tune run, its request, outcome, duration, answers and measured pace.");
    await evaluate('document.querySelector("[data-tune-run]")?.click(), true');
    await delay(500);
    await capture("09-bench-run-detail.png", "Run detail", "One run in full: outcome, answer statistics, task results and decisions.");
    await openTab("settings");
    await capture("10-bench-tune-settings.png", "Tune settings", "The values each setting is tried at and the CPU/GPU lanes for this PC.");
    await openTab("suite");
    await waitFor(() => evaluate('document.querySelectorAll(".suite-task").length === 3'), 8_000);
    await capture("11-bench-suite.png", "Benchmark suite", "Questions, sources, checks and tuning rounds for all three coding tasks.");
    await benchScroll(0.6);
    await capture("11b-bench-suite-long-context.png", "Suite details", "Comprehension and long-context tasks, their rungs and held-back quarter.");
    await benchScroll(0);
    await openTab("gate");
    await capture("12-bench-gate.png", "Benchmark gate", "The coding suite's quality gate with item rates, categories and history.");
    await close();

    await evaluate('document.getElementById("open-settings").click(), true');
    await waitFor(() => evaluate('document.getElementById("settings-dialog").open'));
    await capture("13-settings.png", "Settings", "Runtime, sampling, prompt and tuning switches in one panel.");
    await close();
    await evaluate('document.getElementById("theme-toggle").click(), true');
    await delay(320);
    await capture("14-light-overview.png", "Light theme", "The same workbench in the light theme.");
    await evaluate('document.getElementById("theme-toggle").click(), true');
    await delay(220);
    await evaluate('document.getElementById("open-server").click(), true');
    await waitFor(() => evaluate('document.getElementById("server-dialog").open'));
    await capture("15-server.png", "Server", "Port, LAN, authentication, CORS and the OpenAI-compatible endpoint.");
    await close();

    await viewport(1440, 900);
    await navigate("?shot=running");
    await openBench();
    await openTab("tune");
    await capture("16-bench-tune-running.png", "Live tune and queue", "A guarded quick pass, live candidates, a provisional preset and a reorderable queue.");
    await openTab("models");
    await scrollToQueue();
    await capture("17-bench-tune-queue.png", "Queue controls", "Move a waiting model earlier or later; pause between models; stop the whole queue on a regression.");
    await evaluate('document.getElementById("tune-guard").checked = true; true');
    await openTab("tune");
    await benchScroll(1);
    await capture("17b-bench-live.png", "Live candidates and decisions", "The setting being tried now, its candidate table and the decisions this run.");
    await close();

    await viewport(390, 844, true);
    await navigate();
    await capture("18-mobile-overview.png", "Overview on mobile", "The same workbench at 390 px: one column, no horizontal overflow.");
    await openBench();
    await openTab("tune");
    await capture("19-mobile-tune.png", "Tune on mobile", "The Tune workspace becomes a full-screen sheet with a horizontal section rail.");
    await benchScroll(0.55);
    await capture("19b-mobile-tune-controls.png", "Tune controls on mobile", "Preflight, task scope and the Quick pass controls remain reachable at 390 px.");
    await close();
    await evaluate('document.getElementById("open-models").click(), true');
    await waitFor(() => evaluate('document.getElementById("models-dialog").open'));
    await capture("20-mobile-models.png", "Models on mobile", "Installed models and actions remain reachable at 390 px.");
    await close();
    await viewport(390, 844, true);
    await evaluate('document.getElementById("open-settings").click(), true');
    await waitFor(() => evaluate('document.getElementById("settings-dialog").open'));
    await capture("21-mobile-settings.png", "Settings on mobile", "Settings scroll cleanly inside the phone-sized sheet.");
    await close();
    await viewport(390, 844, true);
    await openBench();
    await openTab("suite");
    await waitFor(() => evaluate('document.querySelectorAll(".suite-task").length === 3'), 8_000);
    await capture("22-mobile-suite.png", "Suite on mobile", "The benchmark suite remains readable with a horizontal section rail.");
    await close();

    await viewport(1280, 640);
    await send("Page.navigate", { url: `file:///${path.join(ROOT, "assets", "social-preview.svg").replaceAll("\\", "/")}` });
    await delay(700);
    await capture("23-social-preview.png", "Social preview", "The 1280x640 social preview artwork.");

    await writeFile(path.join(OUT, "manifest.json"), `${JSON.stringify({ title: "ModelDuck screenshot gallery", generatedAt: new Date().toISOString(), shots }, null, 2)}\n`);
    await copyFile(path.join(OUT, "23-social-preview.png"), path.join(ROOT, "assets", "social-preview.png"));
    await copyFile(path.join(OUT, "01-overview.png"), path.join(ROOT, "assets", "screenshot-control.png"));
    await copyFile(path.join(OUT, "02-models-installed.png"), path.join(ROOT, "assets", "screenshot-models.png"));
    console.log(`Wrote ${shots.length} screenshots to ${OUT}`);
  } finally {
    ws?.close();
    browser?.kill();
    server?.kill();
    await delay(400);
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
