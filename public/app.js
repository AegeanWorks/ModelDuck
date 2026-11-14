
const $ = (id) => document.getElementById(id);

const els = {
  contextNote: $("context-note"),
  dashboard: document.querySelector(".dashboard"),
  dashboardModels: $("dashboard-models"),
  dashboardTuning: $("dashboard-tuning"),
  dashboardSystem: $("dashboard-system"),
  dashboardConnectFacts: $("dashboard-connect-facts"),
  dashboardApiUrl: $("dash-api-url"),
  dashboardCopyApi: $("dashboard-copy-api"),
  dashRuntime: $("dash-runtime"),
  dashRuntimeDetail: $("dash-runtime-detail"),
  dashModelCount: $("dash-model-count"),
  dashTunedCount: $("dash-tuned-count"),
  dashApiState: $("dash-api-state"),
  dashApiDetail: $("dash-api-detail"),
  dashTuneState: $("dash-tune-state"),
  dashFooterVersion: $("dash-footer-version"),
  statusAnnouncer: $("status-announcer"),
  navOverview: $("nav-overview"),
  railModelCount: $("rail-model-count"),
  topServerState: $("top-server-state"),
  heroModels: $("hero-models"),
  heroBench: $("hero-bench"),
  mastheadServer: $("masthead-server"),
  statusCard: $("status-card"),
  statusDot: $("status-dot"),
  statusModel: $("status-model"),
  statusDetail: $("status-detail"),
  themeIcon: $("theme-icon"),
  modelsDialog: $("models-dialog"),
  catalogGrid: $("catalog-grid"),
  installedList: $("installed-list"),
  installedCount: $("installed-count"),
  modelsTotal: $("models-total"),
  modelsDir: $("models-dir"),
  importPath: $("import-path"),
  importBtn: $("import-btn"),
  settingsDialog: $("settings-dialog"),
  settingsForm: $("settings-form"),
  settingTuned: $("setting-tuned"),
  settingSpeedPreset: $("setting-speed-preset"),
  settingSystem: $("setting-system"),
  settingTemp: $("setting-temp"),
  settingTopp: $("setting-topp"),
  settingTopk: $("setting-topk"),
  settingMinp: $("setting-minp"),
  settingRepeat: $("setting-repeat"),
  settingReasoning: $("setting-reasoning"),
  settingOverflow: $("setting-overflow"),
  settingStructured: $("setting-structured"),
  settingSchema: $("setting-schema"),
  settingMax: $("setting-max"),
  settingRepeatPrompt: $("setting-repeat-prompt"),
  settingContext: $("setting-context"),
  settingThreads: $("setting-threads"),
  settingMaxThreads: $("setting-max-threads"),
  settingBatch: $("setting-batch"),
  settingSequences: $("setting-sequences"),
  settingGpuLayers: $("setting-gpu-layers"),
  settingGpuBackend: $("setting-gpu-backend"),
  gpuStatus: $("gpu-status"),
  settingFlash: $("setting-flash"),
  settingMmap: $("setting-mmap"),
  settingCheckpoints: $("setting-checkpoints"),
  settingCheckpointInterval: $("setting-checkpoint-interval"),
  settingCheckpointMax: $("setting-checkpoint-max"),
  settingKv: $("setting-kv"),
  presetBar: $("preset-bar"),
  serverDialog: $("server-dialog"),
  serverForm: $("server-form"),
  serverPort: $("server-port"),
  serverTtl: $("server-ttl"),
  serverAuth: $("server-auth"),
  serverLan: $("server-lan"),
  serverCors: $("server-cors"),
  serverJit: $("server-jit"),
  serverJitAuto: $("server-jit-auto"),
  serverJitLast: $("server-jit-last"),
  serverMcpRequest: $("server-mcp-request"),
  serverMcpJson: $("server-mcp-json"),
  serverKeyCount: $("server-key-count"),
  serverKeyList: $("server-key-list"),
  serverKeyLabel: $("server-key-label"),
  serverKeyCreate: $("server-key-create"),
  serverKeyOutput: $("server-key-output"),
  serverKeyValue: $("server-key-value"),
  serverRestart: $("server-restart-note"),
  settingsDirty: $("settings-dirty"),
  serverSave: $("server-save"),
  serverSettingsError: $("server-settings-error"),
  serverSettingsErrorText: $("server-settings-error-text"),
  benchmarkDialog: $("benchmark-dialog"),
  benchmarkPhases: $("benchmark-phases"),
  benchmarkShowOld: $("benchmark-show-old"),
  benchmarkRecommendations: $("benchmark-recommendations"),
  benchmarkRunState: $("benchmark-run-state"),
  benchmarkPhase: $("benchmark-phase"),
  benchmarkBaseline: $("benchmark-baseline"),
  benchmarkDownload: $("benchmark-download"),
  benchmarkFull: $("benchmark-full"),
  benchmarkStart: $("benchmark-start"),
  benchmarkCancel: $("benchmark-cancel"),
  benchmarkProgress: $("benchmark-progress"),
  benchmarkChatBase: $("benchmark-chat-base"),
  tuneRunState: $("tune-run-state"),
  tuneStages: $("tune-stages"),
  tuneTasks: $("tune-tasks"),
  tuneForce: $("tune-force"),
  tuneAll: $("tune-all"),
  tuneQuick: $("tune-quick"),
  tunePause: $("tune-pause"),
  tuneCancel: $("tune-cancel"),
  tuneGuard: $("tune-guard"),
  tuneGuardQueue: $("tune-guard-queue"),
  tuneBudget: $("tune-budget"),
  tuneBackground: $("tune-background"),
  tunePreflight: $("tune-preflight"),
  tuneProgress: $("tune-progress"),
  tuneModels: $("tune-models"),
  tuneRecommend: $("tune-recommend"),
  tuneBest: $("tune-best"),
  tuneRuns: $("tune-runs"),
  benchTabs: document.querySelector(".bench-tabs"),
  benchTabDot: $("bench-tab-dot"),
  benchSuite: $("bench-suite"),
  benchSuiteVersion: $("bench-suite-version"),
  tuneContinue: $("tune-continue"),
  tuneLive: $("tune-live"),
  tuneRunsList: $("tune-runs-list"),
  tuneRunDetail: $("tune-run-detail"),
  tuneOnly: $("tune-only"),
  tuneSettings: $("tune-settings"),
  tuneSettingsForm: $("tune-settings-form"),
  tuneSettingsSave: $("tune-settings-save"),
  tuneSettingsReset: $("tune-settings-reset"),
  tuneSettingsNote: $("tune-settings-note"),
  tempOut: $("temp-out"),
  toppOut: $("topp-out"),
  settingsNote: $("settings-note"),
  confirmDialog: $("confirm-dialog"),
  confirmTitle: $("confirm-title"),
  confirmMessage: $("confirm-message"),
  confirmOk: $("confirm-ok"),
  confirmCancel: $("confirm-cancel"),
  toastRoot: $("toast-root"),
};

const SETTING_HELP = {
  "setting-tuned": "Apply the saved preset for each tuned model. Turn this off to use only the values on this form.",
  "setting-speed-preset": "Which measured speed preset to apply: Fastest uses the most threads, Light leaves half idle, Quiet uses at most a quarter.",
  "setting-system": "The base instruction sent before every request. A task preset or a per-request system message can override it.",
  "setting-temp": "Sampling randomness: 0 is deterministic; higher values produce more varied answers.",
  "setting-topp": "Keep the most likely tokens until this share of probability is covered. Lower values trim more.",
  "setting-topk": "Sample only from the K most likely tokens; 0 disables this filter.",
  "setting-minp": "Drop tokens below this fraction of the best token's probability; 0 disables it.",
  "setting-repeat": "Penalty for repeating tokens; 1 disables it.",
  "setting-reasoning": "Adds a reasoning instruction. Auto is a short nudge; Deep asks the model to work through the problem first.",
  "setting-overflow": "What to do when the prompt exceeds the context: Shift drops the oldest tokens; Truncate drops the oldest turns first; Strict refuses instead.",
  "setting-structured": "Constrain the reply to a JSON object or the JSON schema below.",
  "setting-schema": "The JSON Schema used when structured output is JSON schema. Invalid schemas are refused before generation.",
  "setting-max": "Maximum number of tokens generated for one answer.",
  "setting-repeat-prompt": "Send the user's text two or three times in the model prompt only; the transcript stays unchanged.",
  "setting-context": "Maximum context tokens the model can see. Reload the model to apply.",
  "setting-threads": "CPU threads used for inference. More is not always faster; reload to apply.",
  "setting-max-threads": "Upper bound for the llama.cpp worker pool. Reload to apply.",
  "setting-batch": "Tokens evaluated per batch. Larger batches use more memory; reload to apply.",
  "setting-sequences": "Parallel context slots. More slots use more RAM; reload to apply.",
  "setting-gpu-backend": "Backend used for offload. Auto chooses a compatible CUDA, Vulkan or Metal backend; reload to apply.",
  "setting-gpu-layers": "Layers offloaded to the GPU. 0 keeps inference on the CPU; reload to apply.",
  "setting-flash": "Use flash attention where the backend supports it; reload to apply.",
  "setting-mmap": "Map weights through the OS page cache instead of copying them into RAM; reload to apply.",
  "setting-checkpoints": "Keep prefix states so long contexts can be reused faster; reload to apply.",
  "setting-checkpoint-interval": "Fallback checkpoint interval before the context size is known; with a model loaded the interval scales to cover the context; reload to apply.",
  "setting-checkpoint-max": "How many checkpoints one sequence may keep. More costs memory; reload to apply.",
  "setting-kv": "Precision of the KV cache. Lower precision saves memory and may lose a little quality; reload to apply.",
  "server-port": "Port the local server listens on after the next restart.",
  "server-ttl": "Minutes an unused just-in-time model stays loaded before it is unloaded.",
  "server-auth": "Require an API key for /v1 and for /api requests from other machines.",
  "server-lan": "Listen on all network interfaces. Requires authentication.",
  "server-cors": "Allow browser API clients from other origins on /v1 only. Requires authentication.",
  "server-jit": "Load a named installed model automatically on the first API request.",
  "server-jit-auto": "Unload a just-in-time model after the idle TTL.",
  "server-jit-last": "Keep only the most recently used JIT model loaded; a second JIT request is refused while one is loaded.",
  "server-mcp-request": "Allow a request to choose per-request MCP servers. No tools are exposed yet.",
  "server-mcp-json": "Allow MCP servers from mcp.json. No tools are exposed yet.",
  "benchmark-phase": "Model reloading is the required gate; Model usage rechecks sampling and prompting after the model phase.",
  "benchmark-baseline": "Replace the saved comparison baseline with this run. Use only for a deliberate baseline change.",
  "benchmark-download": "Download any missing benchmark models before starting.",
  "benchmark-full": "Add Llama 3B and Phi 3.8B plus their KV variants; this is much slower.",
  "benchmark-show-old": "Show reports measured on older benchmark suites. They are hidden by default.",
  "tune-force": "Discard the selected models' saved profile results and measure every chosen stage again.",
  "tune-task-code": "Tune the code task's sampling and prompt settings. Shared device, quality and speed stages still run once.",
  "tune-task-comprehension": "Tune code-comprehension sampling and prompt settings. Shared device, quality and speed stages still run once.",
  "tune-task-recall": "Tune long-context sampling and prompt settings. Shared device, quality and speed stages still run once.",
  "tune-guard": "Stop the remaining tasks when the first held-back check falls back to the defaults or a task falls below its saved profile.",
  "tune-guard-queue": "Stop the whole queue, including other running models, when the guardrail fires.",
  "tune-background": "Close the Bench dialog after starting; the tune keeps running in ModelDuck.",
};

const STAGE_HELP = {
  device: "Measures CPU and GPU; the fastest placement that keeps the same answers wins.",
  quality: "Chooses the KV cache; context is fixed at the 16K floor before speed is measured on that load shape.",
  speed: "Tunes threads, batch, attention, memory mapping and checkpoints for identical answers.",
  sampling: "Tunes sampling separately for each task after the load settings are fixed.",
  prompt: "Tunes the system prompt, reasoning mode and prompt repetition per task.",
};

const TUNE_STEP_HELP = {
  "device.backends": "Backends to probe. CPU is always kept as the reference, so a GPU wins only when it is faster without losing answers.",
  "lanes.cpu": "How many tunes may use the CPU lane at the same time.",
  "lanes.gpu": "How many tunes may use the GPU lanes; 0 makes GPU models wait for the CPU lane.",
  "load.kvCache": "KV cache types to try. Lower precision saves memory; types that lose answers are rejected.",
  "load.flashAttention": "Flash attention values to try where the backend supports them.",
  "load.useMmap": "Try mapping weights from disk or copying them into RAM.",
  "load.batchSize": "Evaluation batch sizes to try. Larger batches can be faster but use more memory.",
  "load.threads": "CPU thread counts to try, capped at three quarters of the logical cores.",
  "load.checkpointing.enabled": "Try context checkpointing for hybrid or sliding-window models.",
  "load.checkpointing.interval": "Checkpoint intervals to try, in tokens.",
  "load.checkpointing.max": "Maximum checkpoint counts to try.",
  "sampling.temperature": "Temperature values to try for every task; 0 is deterministic.",
  "sampling.maxTokens.code": "Answer-length candidates for the code task.",
  "sampling.maxTokens.comprehension": "Answer-length candidates for code comprehension.",
  "sampling.maxTokens.recall": "Answer-length candidates for long context.",
  "sampling.repeatPenalty": "Repeat-penalty values to try.",
  "sampling.minP": "Min-p values to try.",
  "sampling.topP": "Top-p values to try.",
  "sampling.topK": "Top-k values to try; 0 disables top-k.",
  "prompt.systemPrompt": "System prompts to try, one per line. The first is the reference.",
  "prompt.reasoning": "Reasoning modes to try: off, auto or deep.",
  "prompt.promptRepeat": "Prompt-repeat counts to try: 1, 2 or 3.",
};

const helpPopover = $("field-help-popover");
let helpAnchor = null;

function helpButton(label, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "field-help";
  button.textContent = "?";
  button.title = text;
  button.setAttribute("aria-label", `About ${label}`);
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "field-help-popover");
  button.setAttribute("aria-describedby", "field-help-popover");
  button.dataset.help = text;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleHelp(button);
  });
  return button;
}

function positionHelp(button) {
  const rect = button.getBoundingClientRect();
  const box = helpPopover.getBoundingClientRect();
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - box.width / 2), innerWidth - box.width - 12);
  let top = rect.bottom + 8;
  if (top + box.height > innerHeight - 12) top = Math.max(12, rect.top - box.height - 8);
  helpPopover.style.left = `${left}px`;
  helpPopover.style.top = `${top}px`;
}

function showHelp(button) {
  hideHelp();
  const host = button.closest("dialog[open]") ?? document.body;
  if (helpPopover.parentElement !== host) host.appendChild(helpPopover);
  helpPopover.textContent = button.dataset.help;
  if (typeof helpPopover.showPopover === "function") {
    if (!helpPopover.matches(":popover-open")) helpPopover.showPopover();
  } else {
    helpPopover.hidden = false;
    helpPopover.style.display = "block";
  }
  helpAnchor = button;
  button.setAttribute("aria-expanded", "true");
  positionHelp(button);
}

function hideHelp() {
  if (!helpAnchor) return;
  const nativePopover = typeof helpPopover.hidePopover === "function";
  if (nativePopover && helpPopover.matches(":popover-open")) {
    helpPopover.hidePopover();
  }
  if (nativePopover) {
    helpPopover.style.display = "";
  } else {
    helpPopover.hidden = true;
    helpPopover.style.display = "none";
  }
  helpAnchor.setAttribute("aria-expanded", "false");
  helpAnchor = null;
}

function toggleHelp(button) {
  if (helpAnchor === button) hideHelp();
  else showHelp(button);
}

function markSettingHelp() {
  for (const [id, text] of Object.entries(SETTING_HELP)) {
    const input = document.getElementById(id);
    const label = input?.closest("label");
    if (!label || label.querySelector(".field-help")) continue;
    const caption = label.querySelector(":scope > span") ?? label;
    const name = (caption.textContent || id).trim().replace(/\s+/g, " ").split(" ").slice(0, 5).join(" ");
    caption.appendChild(helpButton(name, text));
  }
  for (const label of document.querySelectorAll("#tune-stages .tune-stage")) {
    const input = label.querySelector("input[value]");
    const span = label.querySelector("span");
    const text = input && STAGE_HELP[input.value];
    if (!span || !text || span.querySelector(".field-help")) continue;
    span.appendChild(helpButton(label.querySelector("strong")?.textContent ?? "stage", text));
  }
}

const state = {
  // Models whose tune details are expanded in the Bench dialog, and their sweep logs once loaded.
  tuneOpen: new Set(),
  tuneSweeps: new Map(),
  app: null,
  settings: null,
  modelsDir: null,
  models: [],
  catalog: [],
  downloads: [],
  presets: [],
  serverSettings: null,
  loaded: { status: "idle", model: null },
  theme: localStorage.getItem("modelduck.theme") || "dark",
  pollTimer: null,
  polling: false,
  pollFailures: 0,
  benchmarkJob: null,
  benchmarkTimer: null,
  benchmarkPolling: false,
  tuneOverview: null,
  tuneJob: null,
  benchSuite: null,
  tuneTimer: null,
  tunePolling: false,
  tuneDefaults: null,
  chatBase: null,
  settingsDirty: false,
  restartRequired: null,
  completedDownloads: new Set(),
};

/* API ---------------------------------------------------------------------- */

const API_KEY_STORAGE = "modelduck-api-key";

function savedApiKey() {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

async function apiFetch(path, options = {}, retried = false) {
  const headers = new Headers(options.headers || {});
  const key = savedApiKey();
  if (key) headers.set("x-api-key", key);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && !retried && path.startsWith("/api/")) {
    const entered = window.prompt(
      "This ModelDuck server requires an API key. Paste the key created in Server settings.",
    );
    if (entered && entered.trim()) {
      try {
        sessionStorage.setItem(API_KEY_STORAGE, entered.trim());
      } catch {}
      return apiFetch(path, options, true);
    }
  }
  return response;
}

async function request(path, { method = "GET", body, signal } = {}) {
  const response = await apiFetch(path, {
    method,
    ...(signal ? { signal } : {}),
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const info = data?.error ?? {};
    const error = new Error(info.message || `Request failed (${response.status})`);
    error.info = info;
    error.status = response.status;
    throw error;
  }
  return data ?? {};
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = "B";
  for (const next of units) {
    if (size < 1024) break;
    size /= 1024;
    unit = next;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${unit}`;
}

function formatRelative(iso) {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 50) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

/* Toasts ------------------------------------------------------------------- */

function showToast(title, { message = "", fix = "", kind = "info", timeout = 5200 } = {}) {
  const toast = document.createElement("div");
  toast.className = `toast ${kind === "error" ? "error" : ""}`;
  const copy = document.createElement("div");
  copy.className = "toast-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  copy.appendChild(strong);
  if (message) {
    const body = document.createElement("p");
    body.textContent = message;
    copy.appendChild(body);
  }
  if (fix) {
    const hint = document.createElement("p");
    hint.className = "toast-fix";
    hint.textContent = `Fix: ${fix}`;
    copy.appendChild(hint);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => toast.remove());
  toast.append(copy, close);
  els.toastRoot.prepend(toast);
  while (els.toastRoot.children.length > 4) els.toastRoot.lastElementChild.remove();
  setTimeout(() => toast.remove(), timeout);
}

function showError(error) {
  const info = error?.info ?? {};
  showToast(info.message || error?.message || "Something went wrong", {
    message: info.why || "",
    fix: info.fix || "",
    kind: "error",
    timeout: 9000,
  });
}

/* Theme -------------------------------------------------------------------- */

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  els.themeIcon.textContent = state.theme === "dark" ? "☾" : "☀";
  localStorage.setItem("modelduck.theme", state.theme);
}

/* Header and status -------------------------------------------------------- */

function renderHeader() {
  document.title = "ModelDuck Code — server and tuner";
}

function renderStatus() {
  const loaded = state.loaded;
  els.statusDot.className = `status-dot ${loaded.status === "ready" ? "ready" : loaded.status === "loading" ? "loading" : loaded.status === "error" ? "error" : ""}`;

  if (loaded.status === "ready" && loaded.model) {
    els.statusModel.textContent = loaded.model.name;
    const details = [];
    if (loaded.model.params) details.push(loaded.model.params);
    if (loaded.contextSize) details.push(`${loaded.contextSize} ctx`);
    if (loaded.threads) details.push(`${loaded.threads} threads`);
    if (loaded.kvCache && loaded.kvCache !== "f16") details.push(`KV ${loaded.kvCache}`);
    if (loaded.gpuBackend && loaded.gpuBackend !== "cpu") details.push(`GPU ${loaded.gpuBackend}`);
    els.statusDetail.textContent = details.join(" · ") || "Ready";
    els.contextNote.textContent = `${loaded.model.name} · ${loaded.contextSize || "?"} context`;
  } else if (loaded.status === "loading") {
    els.statusModel.textContent = loaded.model?.name || "Loading model…";
    els.statusDetail.textContent = "Warming up the duck…";
    els.contextNote.textContent = "Loading a model…";
  } else if (loaded.status === "error") {
    els.statusModel.textContent = "Model failed";
    els.statusDetail.textContent = "Open Models to try again";
    els.contextNote.textContent = "No model loaded.";
  } else {
    els.statusModel.textContent = "No model loaded";
    els.statusDetail.textContent = "Open Models to begin";
    els.contextNote.textContent = "No model loaded.";
  }
  renderDashboard();
}

function renderDashboard() {
  if (!els.dashboard) return;
  const loaded = state.loaded ?? { status: "idle", model: null };
  const status = loaded.status === "ready" ? "Ready" : loaded.status === "loading" ? "Loading" : loaded.status === "error" ? "Error" : "Idle";
  els.dashRuntime.textContent = status;
  els.dashRuntimeDetail.textContent = loaded.model?.name ?? "No model loaded";
  els.dashModelCount.textContent = String(state.models.length);
  els.railModelCount.textContent = String(state.models.length);

  const server = state.serverSettings ?? {};
  const auth = Boolean(server.requireAuth);
  const cors = Boolean(server.enableCors);
  els.dashApiState.textContent = auth ? "Keyed" : "Open";
  els.dashApiDetail.textContent = `${server.serveOnLocalNetwork ? "LAN" : "loopback"} · CORS ${cors ? "on" : "off"}`;
  els.topServerState.textContent = auth ? "API · keyed" : "API · open";
  els.dashboardApiUrl.textContent = `${location.origin}/v1`;

  renderDashboardModels();
  renderDashboardTuning();
  renderDashboardFacts();
  renderDashboardSystem();

  if (els.statusAnnouncer) {
    const announcement =
      loaded.status === "ready" && loaded.model
        ? `${loaded.model.name} is ready.`
        : loaded.status === "loading"
          ? "A model is loading."
          : loaded.status === "error"
            ? "The model could not be loaded."
            : "No model is loaded.";
    if (els.statusAnnouncer.textContent !== announcement) els.statusAnnouncer.textContent = announcement;
  }
}

function renderDashboardModels() {
  if (!els.dashboardModels) return;
  els.dashboardModels.replaceChildren();
  if (!state.models.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    const title = document.createElement("strong");
    title.textContent = "No models installed";
    const note = document.createElement("p");
    note.textContent = "Add a GGUF model to start serving and tuning.";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "primary-btn";
    action.dataset.dashboardOpenModels = "true";
    action.textContent = "Open Models";
    empty.append(title, note, action);
    els.dashboardModels.appendChild(empty);
    return;
  }

  for (const model of state.models.slice(0, 4)) {
    const loaded = state.loaded.model?.id === model.id;
    const loading = loaded && state.loaded.status === "loading";
    const row = document.createElement("div");
    row.className = "dash-model";
    const main = document.createElement("div");
    main.className = "dash-model-main";
    const name = document.createElement("strong");
    name.textContent = model.name;
    const meta = document.createElement("span");
    meta.textContent = [model.params, model.quant, model.contextLength ? `${Number(model.contextLength).toLocaleString()} ctx` : "", model.sizeLabel].filter(Boolean).join(" · ");
    main.append(name, meta);

    const badge = document.createElement("span");
    badge.className = `badge ${loaded ? "accent" : ""}`;
    badge.textContent = loaded
      ? loading
        ? "Loading"
        : "Loaded"
      : model.blocked
        ? "Blocked"
        : model.unreadable
          ? "Unreadable"
          : "Installed";

    const actions = document.createElement("div");
    actions.className = "dash-model-actions";
    if (!model.blocked && !model.unreadable) {
      const load = document.createElement("button");
      load.type = "button";
      load.className = "small-btn";
      if (loaded) {
        load.textContent = "Unload";
        load.dataset.dashboardUnload = "true";
      } else {
        load.textContent = loading ? "Loading…" : "Load";
        load.dataset.dashboardLoad = model.id;
        load.disabled = loading;
      }
      actions.appendChild(load);
      if (!loaded) {
        const tune = document.createElement("button");
        tune.type = "button";
        tune.className = "ghost-btn";
        tune.textContent = "Tune";
        tune.dataset.dashboardTune = model.id;
        actions.appendChild(tune);
      }
    }
    row.append(main, badge, actions);
    els.dashboardModels.appendChild(row);
  }

  if (state.models.length > 4) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ghost-btn dash-more";
    more.dataset.dashboardOpenModels = "true";
    more.textContent = `View all ${state.models.length} models`;
    els.dashboardModels.appendChild(more);
  }
}

function renderDashboardTuning() {
  if (!els.dashboardTuning) return;
  els.dashboardTuning.replaceChildren();
  const total = state.models.length;
  const overview = Array.isArray(state.tuneOverview) ? state.tuneOverview : null;
  const profiles = overview ? overview.filter((item) => item.profile) : [];
  const job = state.tuneJob;
  els.dashTunedCount.textContent = overview ? String(profiles.length) : "—";
  els.dashTuneState.textContent = job?.status ?? (profiles.length ? "measured" : "idle");

  const summary = document.createElement("p");
  summary.className = "tune-summary";
  if (state.tuneProfilesError) {
    summary.textContent = "Saved profiles could not be read. Open Bench & Tune to retry.";
  } else if (!total) {
    summary.textContent = "Install a model before measuring settings.";
  } else if (!overview) {
    summary.textContent = "Reading saved profiles…";
  } else if (!profiles.length) {
    summary.textContent = `No measured profiles yet. ${total} model${total === 1 ? "" : "s"} ready to tune.`;
  } else {
    summary.textContent = `${profiles.length} of ${total} models have a measured profile. The tuner searches device, quality, speed, sampling and prompts.`;
  }
  els.dashboardTuning.appendChild(summary);

  const stages = document.createElement("div");
  stages.className = "tune-task-row";
  for (const label of ["Device", "Quality", "Speed", "Sampling", "Prompt"]) {
    const chip = document.createElement("span");
    chip.className = "tune-chip";
    chip.textContent = label;
    stages.appendChild(chip);
  }
  els.dashboardTuning.appendChild(stages);

  if (profiles.length) {
    const latest = profiles
      .slice()
      .sort((a, b) => String(b.profile?.createdAt ?? "").localeCompare(String(a.profile?.createdAt ?? "")))[0];
    const line = document.createElement("p");
    line.className = "tune-latest";
    const rate = latest.profile?.tasks?.code?.stats?.rate;
    const when = formatRelative(latest.profile?.createdAt);
    line.textContent = `Latest: ${latest.name}${Number.isFinite(rate) ? ` · code ${rate}%` : ""}${when ? ` · ${when}` : ""}`;
    els.dashboardTuning.appendChild(line);
  }
  if (job?.status === "running") {
    const running = document.createElement("p");
    running.className = "tune-running";
    running.textContent = "A tune is running. Open Bench & Tune to follow it.";
    els.dashboardTuning.appendChild(running);
  }
}

function renderDashboardFacts() {
  if (!els.dashboardConnectFacts) return;
  els.dashboardConnectFacts.replaceChildren();
  const server = state.serverSettings ?? {};
  const facts = [
    ["Authentication", server.requireAuth ? "Required" : "Off"],
    ["CORS", server.enableCors ? "On" : "Off"],
    ["Binding", server.serveOnLocalNetwork ? "LAN" : "Loopback"],
    ["Models", `${state.models.length} installed`],
  ];
  for (const [label, value] of facts) {
    const row = document.createElement("div");
    row.className = "fact";
    const key = document.createElement("span");
    key.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = value;
    row.append(key, detail);
    els.dashboardConnectFacts.appendChild(row);
  }
}

function compactPath(value) {
  if (!value) return "—";
  const separator = value.includes("\\") ? "\\" : "/";
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length > 3 ? `…${separator}${parts.slice(-2).join(separator)}` : value;
}

function renderDashboardSystem() {
  if (!els.dashboardSystem) return;
  els.dashboardSystem.replaceChildren();
  const app = state.app ?? {};
  const fullFolder = state.modelsDir || "";
  const facts = [
    ["Models folder", compactPath(fullFolder)],
    ["CPU", app.cpu ? `${app.cpu} · ${app.parallelism ?? "?"} threads` : "—"],
    ["Runtime", app.node ? `Node ${app.node}` : "—"],
    ["Version", app.version ? `v${app.version}` : "—"],
  ];
  for (const [label, value] of facts) {
    const row = document.createElement("div");
    row.className = "fact";
    const key = document.createElement("span");
    key.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = value;
    if (label === "Models folder" && fullFolder) detail.title = fullFolder;
    row.append(key, detail);
    els.dashboardSystem.appendChild(row);
  }
  if (els.dashFooterVersion) els.dashFooterVersion.textContent = app.version ? `ModelDuck ${app.version}` : "ModelDuck";
}

async function refreshDashboardTuning() {
  try {
    const [overview, status] = await Promise.all([
      request("/api/tune/overview"),
      request("/api/tune/status").catch(() => ({ job: null })),
    ]);
    state.tuneOverview = overview.models ?? [];
    state.tuneJob = status.job ?? null;
    state.tuneProfilesError = false;
    renderDashboardTuning();
  } catch {
    state.tuneOverview = [];
    state.tuneProfilesError = true;
    renderDashboardTuning();
  }
}

function hasActiveDownloads() {
  return state.downloads.some((job) => job.status === "queued" || job.status === "downloading");
}

function stopDownloadPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startDownloadPolling() {
  if (state.pollTimer) return;
  state.pollFailures = 0;
  state.pollTimer = setInterval(pollDownloads, 1000);
}

async function pollDownloads() {
  if (state.polling) return;
  state.polling = true;
  try {
    const data = await request("/api/downloads", { signal: AbortSignal.timeout(10_000) });
    state.pollFailures = 0;
    const wasActive = hasActiveDownloads();
    state.downloads = data.downloads;
    if (els.modelsDialog.open) renderCatalog();
    const active = hasActiveDownloads();
    for (const job of state.downloads) {
      if (job.status === "complete" && !state.completedDownloads.has(job.id)) {
        state.completedDownloads.add(job.id);
        showToast("Download complete", { message: `${job.name} is ready to load.` });
        await refreshModels();
      }
      if (job.status === "error" && !state.completedDownloads.has(job.id)) {
        state.completedDownloads.add(job.id);
        showToast("Download failed", {
          message: job.error?.why || "The model could not be downloaded.",
          fix: job.error?.fix || "Try again.",
          kind: "error",
        });
      }
    }
    if (wasActive && !active) await refreshModels();
    if (!active) stopDownloadPolling();
  } catch {
    // Keep the last progress view for a transient blip, but do not poll a dead
    // server forever with no message.
    state.pollFailures += 1;
    if (state.pollFailures >= 3) {
      stopDownloadPolling();
      showToast("Lost contact with ModelDuck", {
        message: "Download progress stopped updating.",
        fix: "Reopen Models to reconnect; downloads continue on the server.",
        kind: "error",
      });
    }
  } finally {
    state.polling = false;
  }
}

async function refreshModels() {
  try {
    const data = await request("/api/models");
    state.models = data.models;
    state.modelsDir = data.modelsDir ?? state.modelsDir;
    if (els.modelsDialog.open) {
      renderInstalled();
      renderCatalog();
    }
    renderStatus();
  } catch (error) {
    showError(error);
  }
}

function latestDownload(catalogId) {
  return state.downloads
    .filter((job) => job.catalogId === catalogId)
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))[0];
}

function renderCatalog() {
  if (!els.catalogGrid) return;
  els.catalogGrid.replaceChildren();
  for (const model of state.catalog) {
    const installed = state.models.find((item) => item.fileName === model.file);
    const job = latestDownload(model.id);
    const downloading = job && (job.status === "queued" || job.status === "downloading");
    const card = document.createElement("article");
    card.className = `model-card ${model.recommended ? "recommended" : ""}`;
    card.dataset.catalogId = model.id;

    const badges = [];
    if (model.recommended) badges.push('<span class="badge accent">Recommended</span>');
    if (model.tags?.includes("heavy")) badges.push('<span class="badge">Heavy</span>');
    if (model.tags?.includes("test")) badges.push('<span class="badge">Tiny</span>');
    if (installed) badges.push('<span class="badge green">Installed</span>');

    let foot = "";
    if (installed) {
      foot = `<button class="small-btn" type="button" data-load="${escapeAttribute(installed.id)}">Load</button>`;
    } else if (downloading) {
      foot = `
        <div class="download-state">
          <div class="download-row"><span>${job.percent}% · ${formatBytes(job.received)} / ${formatBytes(job.size)}</span><button class="msg-action" type="button" data-cancel-download="${escapeAttribute(job.id)}">Cancel</button></div>
          <div class="progress"><span style="width:${job.percent}%"></span></div>
        </div>`;
    } else if (job?.status === "error") {
      foot = `<button class="small-btn" type="button" data-download="${escapeAttribute(model.id)}">Retry download</button>`;
    } else if (job?.status === "complete") {
      foot = `<button class="small-btn" type="button" data-refresh-models="true">Refresh library</button>`;
    } else {
      foot = `<button class="primary-btn" type="button" data-download="${escapeAttribute(model.id)}">Download</button>`;
    }

    card.innerHTML = `
      <div class="model-card-head">
        <h4>${escapeHtml(model.name)}</h4>
        <div class="model-badges">${badges.join("")}</div>
      </div>
      <p class="model-tagline">${escapeHtml(model.tagline)}</p>
      <div class="model-specs">
        <span><strong>${escapeHtml(model.params)}</strong> params</span>
        <span><strong>${escapeHtml(model.quant)}</strong></span>
        <span><strong>${Number(model.context).toLocaleString()}</strong> ctx</span>
        <span>${escapeHtml(model.license)}</span>
      </div>
      <div class="model-card-foot">
        ${foot}
        <span class="model-size">${formatBytes(model.size)}</span>
      </div>`;
    els.catalogGrid.appendChild(card);
  }
}

function renderInstalled() {
  els.installedCount.textContent = String(state.models.length);
  els.modelsTotal.textContent = String(state.models.length);
  if (state.modelsDir) els.modelsDir.textContent = state.modelsDir;
  els.installedList.replaceChildren();

  if (!state.models.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <strong>No models in the library yet</strong>
      <p>Download a starter model from Discover, or import a GGUF file you already have.</p>
      <div class="welcome-actions"><button class="primary-btn" type="button" data-open-discover="true">Browse models</button></div>`;
    els.installedList.appendChild(empty);
    return;
  }

  for (const model of state.models) {
    const row = document.createElement("div");
    row.className = "installed-card";
    const loaded = state.loaded.model?.id === model.id;
    const loading = loaded && state.loaded.status === "loading";
    const canLoad = !model.blocked && !model.unreadable;
    const actions = loaded
      ? `<button class="small-btn" type="button" data-unload="true">Unload</button>`
      : canLoad
        ? `<button class="small-btn" type="button" data-load="${escapeAttribute(model.id)}" ${loading ? "disabled" : ""}>${loading ? "Loading…" : "Load"}</button>`
        : "";
    row.innerHTML = `
      <div class="installed-icon"><img src="/brand/duck.svg" alt="" /></div>
      <div class="installed-main">
        <strong>${escapeHtml(model.name)}</strong>
        <span>${escapeHtml(model.fileName)} · ${escapeHtml(model.params)} · ${escapeHtml(model.quant)}${model.contextLength ? ` · ${Number(model.contextLength).toLocaleString()} ctx` : ""} · ${escapeHtml(model.sizeLabel)}</span>
        ${model.unreadable ? `<span class="installed-note">${escapeHtml(model.unreadableReason || "The GGUF header could not be read.")}</span>` : ""}
      </div>
      <div class="installed-actions">
        ${model.blocked
          ? `<span class="badge" title="${escapeAttribute(model.blockedReason || "")}">Blocked</span>`
          : model.unreadable ? `<span class="badge" title="${escapeAttribute(model.unreadableReason || "")}">Unreadable</span>` : ""}
        ${actions}
        <button class="small-btn" type="button" data-delete-model="${escapeAttribute(model.id)}" ${loaded ? "disabled" : ""}>Delete</button>
      </div>`;
    els.installedList.appendChild(row);
  }
}

function openModels(tab = "discover") {
  switchTab(tab);
  if (!els.modelsDialog.open) els.modelsDialog.showModal();
  refreshCatalog();
  if (hasActiveDownloads()) startDownloadPolling();
}

function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $("tab-discover").hidden = tab !== "discover";
  $("tab-installed").hidden = tab !== "installed";
  if (tab === "installed") renderInstalled();
}

async function refreshCatalog() {
  try {
    const data = await request("/api/catalog");
    state.catalog = data.catalog;
    state.models = data.models;
    state.modelsDir = data.modelsDir ?? state.modelsDir;
    state.downloads = data.downloads;
    renderCatalog();
    renderInstalled();
    renderDashboard();
    if (hasActiveDownloads()) startDownloadPolling();
  } catch (error) {
    showError(error);
  }
}

async function loadModel(id, { force = false } = {}) {
  const model = state.models.find((item) => item.id === id);
  if (!model) return;
  state.loaded = { status: "loading", model };
  renderStatus();
  renderHeader();
  if (els.modelsDialog.open) renderInstalled();
  try {
    const data = await request(`/api/models/${encodeURIComponent(id)}/load`, {
      method: "POST",
      body: {
        contextSize: state.settings?.contextSize,
        threads: state.settings?.threads,
        maxThreads: state.settings?.maxThreads,
        batchSize: state.settings?.batchSize,
        sequences: state.settings?.sequences,
        flashAttention: state.settings?.flashAttention,
        useMmap: state.settings?.useMmap,
        gpuLayers: state.settings?.gpuLayers,
        gpuBackend: state.settings?.gpuBackend,
        checkpoints: state.settings?.checkpoints,
        checkpointInterval: state.settings?.checkpointInterval,
        checkpointMax: state.settings?.checkpointMax,
        kvCache: state.settings?.kvCache,
        force,
      },
    });
    state.loaded = data.loaded;
    renderHeader();
    renderStatus();
    if (els.modelsDialog.open) els.modelsDialog.close();
    showToast("Model loaded", {
      message: `${model.name} is ready on ${data.loaded.threads} CPU thread${data.loaded.threads === 1 ? "" : "s"}.`,
    });
    const fallback = data.loaded.contextFallback;
    if (fallback) {
      showToast("Context was reduced", {
        message: `You asked for ${fallback.requested} tokens; only ${fallback.actual} could be allocated.`,
        fix: "Lower Context size, use the q8_0 KV cache, or close other programs, then reload.",
      });
    } else if (data.loaded.fit?.verdict === "tight") {
      showToast("Memory is tight", {
        message: "This model and context use most of the free memory; other programs may slow it down.",
      });
    }
  } catch (error) {
    state.loaded = { status: "error", model, error: error.message };
    renderStatus();
    renderHeader();
    if (els.modelsDialog.open) renderInstalled();
    if (error.info?.code === "model_will_not_fit" && !force) {
      const confirmed = await askConfirm(
        "This model may not fit in memory",
        `${error.info.why || error.message} ${error.info.fix || ""}`.trim(),
        "Load anyway",
      );
      if (confirmed) await loadModel(id, { force: true });
      return;
    }
    showError(error);
  }
}

async function unloadModel() {
  try {
    const data = await request("/api/models/unload", { method: "POST" });
    state.loaded = data.loaded;
    renderHeader();
    renderStatus();
    if (els.modelsDialog.open) renderInstalled();
    showToast("Model unloaded", { message: "Memory is free again." });
  } catch (error) {
    showError(error);
  }
}

async function deleteModel(id) {
  const model = state.models.find((item) => item.id === id);
  if (!model) return;
  const confirmed = await askConfirm(
    "Delete this model file?",
    `${model.name}\n\n${model.fileName} will be removed from your model folder. You can download it again later.`,
    "Delete model",
  );
  if (!confirmed) return;
  try {
    const data = await request(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.models = data.models;
    renderInstalled();
    renderCatalog();
    renderStatus();
    showToast("Model deleted");
  } catch (error) {
    showError(error);
  }
}

async function startDownload(catalogId, button) {
  if (button) button.disabled = true;
  try {
    const data = await request("/api/downloads", {
      method: "POST",
      body: { catalogId },
    });
    state.downloads = [data.download, ...state.downloads.filter((item) => item.id !== data.download.id)];
    renderCatalog();
    startDownloadPolling();
    showToast("Download started", { message: `${data.download.name} will appear in Installed when it finishes.` });
  } catch (error) {
    if (button) button.disabled = false;
    showError(error);
  }
}

async function cancelDownload(id) {
  try {
    const data = await request(`/api/downloads/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.downloads = state.downloads.map((job) => (job.id === data.download.id ? data.download : job));
    renderCatalog();
  } catch (error) {
    showError(error);
  }
}

async function importModel() {
  const path = els.importPath.value.trim();
  if (!path) {
    showToast("Paste a file path first", {
      message: "Use the full path to a .gguf file on this computer.",
    });
    return;
  }
  els.importBtn.disabled = true;
  els.importBtn.textContent = "Importing…";
  try {
    const data = await request("/api/models/import", { method: "POST", body: { path } });
    state.models = data.models;
    els.importPath.value = "";
    renderInstalled();
    renderCatalog();
    renderStatus();
    showToast("Model imported", { message: `${data.model.name} is ready to load.` });
  } catch (error) {
    showError(error);
  } finally {
    els.importBtn.disabled = false;
    els.importBtn.textContent = "Import";
  }
}

async function openModelsFolder() {
  try {
    await request("/api/models/open-folder", { method: "POST" });
  } catch (error) {
    showError(error);
  }
}

/* Settings ----------------------------------------------------------------- */

const GPU_LABELS = {
  cuda: "CUDA",
  vulkan: "Vulkan",
  metal: "Metal",
  cpu: "CPU",
};

async function loadGpuStatus() {
  if (!els.gpuStatus) return;
  els.gpuStatus.textContent = "Checking the installed runtime…";
  try {
    const data = await request("/api/gpu");
    const names = (data.backends ?? [])
      .map((backend) => (backend === false ? "cpu" : String(backend)))
      .map((backend) => GPU_LABELS[backend] ?? backend);
    const detected = [...new Set(names)];
    els.gpuStatus.textContent = detected.length
      ? `Detected: ${detected.join(", ")}. ${data.note ?? ""}`.trim()
      : "No GPU backend detected; CPU inference remains available.";
  } catch {
    els.gpuStatus.textContent = "Could not detect GPU backends; CPU inference remains available.";
  }
}

function setSettingsDirty(dirty) {
  state.settingsDirty = Boolean(dirty);
  els.settingsDirty.hidden = !state.settingsDirty;
}

async function closeSettings() {
  if (state.settingsDirty) {
    const discard = await askConfirm(
      "Discard unsaved changes?",
      "The settings form has edits that were not saved. Closing now loses them.",
      "Discard changes",
    );
    if (!discard) return false;
  }
  setSettingsDirty(false);
  els.settingsDialog.close();
  return true;
}

function openSettings() {
  if (els.settingsDialog.open) {
    // Never re-seed the form under an open edit (Ctrl+, used to wipe it).
    els.settingsDialog.focus?.();
    return true;
  }
  const settings = state.settings;
  if (!settings) {
    showToast("Settings are not loaded", { message: "The server did not return settings. Reload the page and try again.", kind: "error" });
    return false;
  }
  els.settingSystem.value = settings.systemPrompt;
  els.settingTuned.checked = settings.useTunedProfile !== false;
  els.settingSpeedPreset.value = ["fastest", "light", "quiet"].includes(settings.speedPreset) ? settings.speedPreset : "fastest";
  els.settingTemp.value = settings.temperature;
  els.settingTopp.value = settings.topP;
  els.settingTopk.value = settings.topK;
  els.settingMinp.value = settings.minP;
  els.settingRepeat.value = settings.repeatPenalty;
  els.settingReasoning.value = settings.reasoning;
  els.settingOverflow.value = settings.contextOverflow;
  els.settingStructured.value = settings.structuredOutput;
  els.settingSchema.value = settings.jsonSchema || "";
  els.settingMax.value = settings.maxTokens;
  els.settingRepeatPrompt.value = String(settings.promptRepeat ?? 1);
  els.settingContext.value = settings.contextSize;
  els.settingThreads.value = settings.threads;
  els.settingMaxThreads.value = settings.maxThreads;
  els.settingBatch.value = settings.batchSize;
  els.settingSequences.value = settings.sequences;
  els.settingGpuLayers.value = settings.gpuLayers;
  els.settingGpuBackend.value = settings.gpuBackend || "cpu";
  els.settingFlash.value = settings.flashAttention;
  els.settingMmap.value = settings.useMmap;
  els.settingCheckpoints.value = String(settings.checkpoints);
  els.settingCheckpointInterval.value = settings.checkpointInterval ?? 8192;
  els.settingCheckpointMax.value = settings.checkpointMax ?? 32;
  els.settingKv.value = settings.kvCache || "f16";
  updateSettingsOutputs();
  renderPresets();
  loadGpuStatus();
  els.settingsNote.textContent = state.loaded.status === "ready"
    ? "Temperature, top P and max tokens apply to the next message. Context, threads, batching, attention, mmap, checkpoints and KV cache apply after reloading the model."
    : "Changes are saved on this computer. Nothing is sent anywhere.";
  setSettingsDirty(false);
  if (!els.settingsDialog.open) els.settingsDialog.showModal();
  return true;
}

function renderPresets() {
  if (!els.presetBar || els.presetBar.children.length) return;
  for (const preset of state.presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset-btn";
    button.dataset.preset = preset.id;
    const title = document.createElement("strong");
    title.textContent = preset.label;
    const description = document.createElement("span");
    description.textContent = preset.description;
    button.append(title, description);
    button.addEventListener("click", () => applyPresetToForm(preset));
    els.presetBar.appendChild(button);
  }
}

function applySettingsToForm(values) {
  if (values.contextSize !== undefined) els.settingContext.value = values.contextSize;
  if (values.batchSize !== undefined) els.settingBatch.value = values.batchSize;
  if (values.maxTokens !== undefined) els.settingMax.value = values.maxTokens;
  if (values.topK !== undefined) els.settingTopk.value = values.topK;
  if (values.minP !== undefined) els.settingMinp.value = values.minP;
  if (values.repeatPenalty !== undefined) els.settingRepeat.value = values.repeatPenalty;
  if (values.reasoning !== undefined) els.settingReasoning.value = values.reasoning;
  if (values.promptRepeat !== undefined) els.settingRepeatPrompt.value = String(values.promptRepeat);
  if (values.kvCache !== undefined) els.settingKv.value = values.kvCache;
  if (values.flashAttention !== undefined) els.settingFlash.value = values.flashAttention;
  if (values.useMmap !== undefined) els.settingMmap.value = values.useMmap;
  if (values.checkpoints !== undefined) els.settingCheckpoints.value = String(values.checkpoints);
  if (values.checkpointInterval !== undefined) els.settingCheckpointInterval.value = values.checkpointInterval;
  if (values.checkpointMax !== undefined) els.settingCheckpointMax.value = values.checkpointMax;
  if (values.sequences !== undefined) els.settingSequences.value = values.sequences;
  if (values.threads !== undefined) els.settingThreads.value = values.threads;
  if (values.maxThreads !== undefined) els.settingMaxThreads.value = values.maxThreads;
  if (values.gpuLayers !== undefined) els.settingGpuLayers.value = values.gpuLayers;
  if (values.gpuBackend !== undefined) els.settingGpuBackend.value = values.gpuBackend;
  updateSettingsOutputs();
}

function applyPresetToForm(preset) {
  applySettingsToForm(preset.settings);
  els.settingsNote.textContent = `${preset.label} preset loaded into the form. Save settings, then reload the model if it is already loaded.`;
  els.presetBar.querySelectorAll(".preset-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === preset.id);
  });
}

/* Server settings ---------------------------------------------------------- */

let serverSettingsLoading = false;

/** LAN and CORS are only meaningful with authentication on. */
function syncServerExposure() {
  const auth = els.serverAuth.checked;
  for (const input of [els.serverLan, els.serverCors]) {
    input.disabled = !auth;
    if (!auth) input.checked = false;
  }
}

/** The listener change is a real state, not a one-off toast. */
function renderServerRestart() {
  if (!els.serverRestart) return;
  const needed = state.restartRequired === true;
  els.serverRestart.hidden = !needed;
  els.serverRestart.textContent = needed
    ? "Restart required: the saved port or LAN binding differs from the running listener. Stop the terminal with Ctrl+C, then start ModelDuck again."
    : "";
}

/** While the values are in flight the form is read-only and Save is off. */
function setServerSettingsBusy(busy) {
  for (const input of els.serverForm.querySelectorAll("input")) input.disabled = busy;
  els.serverSave.disabled = busy || !els.serverSettingsError.hidden;
  if (!busy) syncServerExposure();
}

function showServerSettingsError(message) {
  els.serverSettingsError.hidden = !message;
  els.serverSettingsErrorText.textContent = message;
  els.serverSave.disabled = Boolean(message);
}

async function openServerSettings({ keepKey = false } = {}) {
  // Open at once so the button always responds, then keep the blank form
  // read-only: Save must never send Number("") or stale fields over real ones.
  if (!els.serverDialog.open) els.serverDialog.showModal();
  showServerSettingsError("");
  if (serverSettingsLoading) return;
  serverSettingsLoading = true;
  setServerSettingsBusy(true);
  try {
    const data = await request("/api/server-settings");
    state.serverSettings = { ...data.settings, apiKeys: data.apiKeys, activeKeys: data.activeKeys };
    state.restartRequired = data.restartRequired ?? state.restartRequired;
    // A freshly created key is shown once; do not erase it while refreshing the list.
    if (!keepKey) clearServerKeyReveal();
    renderServerSettings();
  } catch (error) {
    showServerSettingsError("Server settings could not be loaded. Retry, or check the terminal window.");
    showError(error);
  } finally {
    serverSettingsLoading = false;
    setServerSettingsBusy(false);
  }
}

// The full key is shown once, on creation; it must not stay in the DOM (or on
// screen) when the dialog is reopened.
function clearServerKeyReveal() {
  els.serverKeyOutput.hidden = true;
  els.serverKeyValue.textContent = "";
}

function renderServerSettings() {
  const config = state.serverSettings;
  if (!config) return;
  els.serverPort.value = config.port;
  els.serverTtl.value = config.maxIdleTtlMinutes;
  els.serverAuth.checked = Boolean(config.requireAuth);
  els.serverLan.checked = Boolean(config.serveOnLocalNetwork);
  els.serverCors.checked = Boolean(config.enableCors);
  els.serverJit.checked = Boolean(config.justInTimeModelLoading);
  els.serverJitAuto.checked = Boolean(config.autoUnloadUnusedJit);
  els.serverJitLast.checked = Boolean(config.onlyKeepLastJitLoadedModel);
  els.serverMcpRequest.checked = Boolean(config.allowPerRequestMcps);
  els.serverMcpJson.checked = Boolean(config.allowCallingServersFromMcpJson);
  els.serverKeyCount.textContent = `${config.activeKeys ?? 0} active`;
  renderServerKeys(config.apiKeys ?? []);
  if (config.requireAuth && (config.activeKeys ?? 0) === 0) {
    els.serverKeyCount.textContent = "0 active — add one before enabling auth";
  }
  syncServerExposure();
  renderServerRestart();
  renderDashboard();
}

function renderServerKeys(keys) {
  els.serverKeyList.replaceChildren();
  if (!keys.length) {
    const empty = document.createElement("p");
    empty.className = "key-empty";
    empty.textContent = "No API keys yet.";
    els.serverKeyList.appendChild(empty);
    return;
  }
  for (const key of keys) {
    const row = document.createElement("div");
    row.className = "key-row";
    const label = document.createElement("strong");
    label.textContent = key.label;
    const prefix = document.createElement("span");
    prefix.textContent = `${key.prefix}…`;
    const used = document.createElement("span");
    used.textContent = key.lastUsedAt ? `last used ${formatRelative(key.lastUsedAt)}` : "never used";
    const actions = document.createElement("div");
    actions.className = "key-actions";
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "small-btn";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => revokeServerKey(key));
    actions.appendChild(revoke);
    row.append(label, prefix, used, actions);
    els.serverKeyList.appendChild(row);
  }
}

function benchmarkMetric(label, value) {
  const box = document.createElement("div");
  box.className = "benchmark-metric";
  const strong = document.createElement("strong");
  strong.textContent = value;
  const small = document.createElement("small");
  small.textContent = label;
  box.append(strong, small);
  return box;
}

function phaseTitle(phase) {
  if (phase === "model") return "Model reloading";
  if (phase === "chat") return "Model usage";
  if (phase === "single") return "Single-model settings";
  return phase;
}

function renderDatasetTable(items) {
  if (!items?.byDataset) return null;
  const section = document.createElement("div");
  section.className = "benchmark-types";
  const heading = document.createElement("h4");
  heading.textContent = "Public datasets";
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const headRow = document.createElement("tr");
  for (const label of ["Dataset", "Pass", "Rate", "95% CI"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  for (const [dataset, value] of Object.entries(items.byDataset)) {
    if (dataset === "own") continue;
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = dataset;
    const pass = document.createElement("td");
    pass.textContent = `${value.passed}/${value.total}`;
    const rate = document.createElement("td");
    rate.textContent = `${value.rate}%`;
    const ci = document.createElement("td");
    ci.textContent = value.ci95 ? `${value.ci95.low}-${value.ci95.high}%` : "—";
    row.append(name, pass, rate, ci);
    tbody.appendChild(row);
  }
  if (!tbody.children.length) return null;
  table.append(thead, tbody);
  section.append(heading, table);
  return section;
}

function renderCategoryTable(items) {
  if (!items?.byCategory) return null;
  const section = document.createElement("div");
  section.className = "benchmark-types";
  const heading = document.createElement("h4");
  heading.textContent = "By item type";
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const headRow = document.createElement("tr");
  for (const label of ["Type", "Pass", "Rate", "95% CI"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  const thead = document.createElement("thead");
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");
  for (const [category, value] of Object.entries(items.byCategory)) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = category.startsWith("public-") ? `public · ${category.slice(7)}` : category;
    const pass = document.createElement("td");
    pass.textContent = `${value.passed}/${value.total}`;
    const rate = document.createElement("td");
    rate.textContent = `${value.rate}%`;
    const ci = document.createElement("td");
    ci.textContent = value.ci95 ? `${value.ci95.low}-${value.ci95.high}%` : "—";
    row.append(name, pass, rate, ci);
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  section.append(heading, table);
  return section;
}

/** True when a report was measured on an older test suite than this app's and older ones are hidden. */
function hiddenAsOlder(suiteVersion) {
  const current = state.benchmarkReport?.currentSuiteVersion;
  return Boolean(current && Number(suiteVersion) < current && !els.benchmarkShowOld.checked);
}

function renderBenchmarkReport(data) {
  state.benchmarkReport = data;
  els.benchmarkPhases.replaceChildren();
  if (!data.available) {
    const empty = document.createElement("p");
    empty.className = "benchmark-empty";
    empty.textContent =
      "No benchmark results yet. Use Start above (model phase first), or run npm run bench:model and npm run bench:chat in a terminal.";
    els.benchmarkPhases.appendChild(empty);
    return;
  }
  const hidden = data.phases.filter((phase) => hiddenAsOlder(phase.suiteVersion));
  if (hidden.length) {
    const note = document.createElement("p");
    note.className = "benchmark-empty";
    note.textContent = `${hidden.length} report${hidden.length === 1 ? " was" : "s were"} measured on an older test suite (v${hidden.map((phase) => phase.suiteVersion).join(", v")}; now v${data.currentSuiteVersion}) and ${hidden.length === 1 ? "is" : "are"} hidden. Tick "Show reports measured on older test suites" to see them.`;
    els.benchmarkPhases.appendChild(note);
  }
  for (const phase of data.phases.filter((item) => !hidden.includes(item))) {
    const card = document.createElement("section");
    card.className = "benchmark-card";
    const head = document.createElement("div");
    head.className = "benchmark-head";
    const title = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    const measured = formatRelative(phase.createdAt);
    eyebrow.textContent = `Suite v${phase.suiteVersion} · ${phase.testHash}${measured ? ` · measured ${measured}` : ""}`;
    const heading = document.createElement("h3");
    heading.textContent = phase.phase === "single"
      ? `${phaseTitle(phase.phase)}${phase.label ? ` · ${phase.label}` : ""}`
      : phaseTitle(phase.phase);
    title.append(eyebrow, heading);
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `${phase.checksPassed}/${phase.checksTotal}`;
    head.append(title, badge);

    const metrics = document.createElement("div");
    metrics.className = "benchmark-metrics";
    metrics.append(
      benchmarkMetric("quality", `${Number(phase.quality).toFixed(1)}%`),
      ...(phase.items
        ? [benchmarkMetric(`items passed${phase.items.ci95 ? ` · 95% CI ${phase.items.ci95.low}-${phase.items.ci95.high}` : ""}`, `${phase.items.rate}%`)]
        : []),
      benchmarkMetric("speed", `${Number(phase.tokensPerSecond).toFixed(1)} tok/s`),
      benchmarkMetric("runtime", `${(Number(phase.runtimeMs) / 1000).toFixed(1)}s`),
      benchmarkMetric("first token", `${Number(phase.firstTokenMs)} ms`),
      ...(phase.totalMemoryBytes
        ? [benchmarkMetric("memory", [phase.memoryBytes ? `${formatBytes(phase.memoryBytes)} host` : "", phase.gpuVram ? `${formatBytes(phase.gpuVram)} VRAM` : ""].filter(Boolean).join(" + "))]
        : []),
      ...(Number.isFinite(phase.qualityPerSecond)
        ? [benchmarkMetric("quality/s", `${Number(phase.qualityPerSecond).toFixed(1)} %/s`)]
        : []),
      ...(Number.isFinite(phase.qualityPerSecondPerGb)
        ? [benchmarkMetric("quality/s per GB", `${Number(phase.qualityPerSecondPerGb).toFixed(1)}`)]
        : []),
      ...(phase.items?.byOrigin?.own
        ? [benchmarkMetric(`own questions · ${phase.items.byOrigin.own.passed}/${phase.items.byOrigin.own.total}`, `${phase.items.byOrigin.own.rate}%`)]
        : []),
      ...(phase.items?.byOrigin?.public
        ? [benchmarkMetric(`public benchmarks · ${phase.items.byOrigin.public.passed}/${phase.items.byOrigin.public.total}`, `${phase.items.byOrigin.public.rate}%`)]
        : []),
    );

    const table = document.createElement("table");
    table.className = "benchmark-table";
    const headRow = document.createElement("tr");
    for (const label of ["Test", "Dataset", "Group", "Pass", "%"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    const thead = document.createElement("thead");
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    if (!phase.tests.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.textContent = "No per-test data";
      row.appendChild(cell);
      tbody.appendChild(row);
    }
    for (const test of phase.tests) {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = test.label;
      const dataset = document.createElement("td");
      dataset.textContent = test.dataset ?? "own";
      const group = document.createElement("td");
      group.textContent = test.origin === "public" ? "public" : "own";
      const pass = document.createElement("td");
      pass.textContent = `${test.passed}/${test.total}`;
      const percent = document.createElement("td");
      percent.textContent = `${Number(test.percent).toFixed(1)}%`;
      row.append(name, dataset, group, pass, percent);
      tbody.appendChild(row);
    }
    table.append(thead, tbody);

    const commit = document.createElement("p");
    commit.className = "benchmark-commit";
    commit.textContent = phase.commit?.hash
      ? `Commit ${phase.commit.hash}${phase.commit.subject ? ` · ${phase.commit.subject}` : ""}`
      : "Not linked to a commit yet";
    const types = renderCategoryTable(phase.items);
    const datasets = renderDatasetTable(phase.items);
    const items = document.createElement("details");
    items.className = "benchmark-items";
    items.append(Object.assign(document.createElement("summary"), { textContent: `Every item (${phase.tests.length})` }), table);
    card.append(head, metrics, ...(types ? [types] : []), ...(datasets ? [datasets] : []), items, commit);
    els.benchmarkPhases.appendChild(card);
  }

  if (data.history?.length) {
    const section = document.createElement("section");
    section.className = "benchmark-history";
    const heading = document.createElement("h3");
    heading.textContent = "Recent runs";
    const table = document.createElement("table");
    table.className = "benchmark-table";
    const headRow = document.createElement("tr");
    for (const label of ["When", "Phase", "Quality", "Speed", "Runtime", "Commit"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    const thead = document.createElement("thead");
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const run of data.history) {
      const row = document.createElement("tr");
      const when = document.createElement("td");
      when.textContent = run.recordedAt ? new Date(run.recordedAt).toLocaleString() : "—";
      const phase = document.createElement("td");
      phase.textContent = phaseTitle(run.phase);
      const quality = document.createElement("td");
      quality.textContent = `${Number(run.quality).toFixed(1)}%`;
      const speed = document.createElement("td");
      speed.textContent = `${Number(run.tokensPerSecond).toFixed(1)} tok/s`;
      const runtime = document.createElement("td");
      runtime.textContent = `${(Number(run.runtimeMs) / 1000).toFixed(1)}s`;
      const commit = document.createElement("td");
      commit.textContent = run.commit?.hash ?? "—";
      row.append(when, phase, quality, speed, runtime, commit);
      tbody.appendChild(row);
    }
    table.append(thead, tbody);
    section.append(heading, table);
    els.benchmarkPhases.appendChild(section);
  }
}

const RECOMMENDATION_TITLES = {
  quality: "Best quality",
  overall: "Best overall",
  coding: "Best coding",
  speed: "Fastest within budget",
  "speed-tuning": "Speed tuning",
};
const SETTING_LABELS = {
  kvCache: "KV cache",
  contextSize: "Context",
  batchSize: "Batch",
  threads: "Threads",
  maxThreads: "Thread pool",
  sequences: "Sequences",
  flashAttention: "Flash attention",
  useMmap: "Memory map",
  gpuLayers: "GPU layers",
  gpuBackend: "GPU backend",
  checkpoints: "Checkpoints",
  checkpointInterval: "Checkpoint interval",
  checkpointMax: "Max checkpoints",
};

function settingChips(settings) {
  const chips = document.createElement("div");
  chips.className = "benchmark-chips";
  const entries = Object.entries(settings ?? {});
  if (!entries.length) {
    const chip = document.createElement("span");
    chip.className = "benchmark-chip";
    chip.textContent = "already optimal";
    chips.appendChild(chip);
    return chips;
  }
  for (const [key, value] of entries) {
    const chip = document.createElement("span");
    chip.className = "benchmark-chip";
    chip.textContent = `${SETTING_LABELS[key] ?? key} ${typeof value === "boolean" ? (value ? "on" : "off") : value}`;
    chips.appendChild(chip);
  }
  return chips;
}

function fillSettingsFromAdvice(item) {
  if (!openSettings()) return;
  applySettingsToForm(item.settings);
  const title = RECOMMENDATION_TITLES[item.kind] ?? item.kind;
  els.settingsNote.textContent =
    `${title} settings from the benchmark were loaded into the form. ` +
    "Review them, save, then reload the model to apply the reload-time values.";
}

function recommendationCard(item) {
  const card = document.createElement("article");
  card.className = "benchmark-advice-card";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = RECOMMENDATION_TITLES[item.kind] ?? item.kind;
  const title = document.createElement("h4");
  title.textContent = item.label ?? item.fileName ?? item.variantId;
  const stats = document.createElement("p");
  stats.className = "benchmark-advice-stats";
  const parts = [];
  if (Number.isFinite(Number(item.rate))) parts.push(`${Number(item.rate).toFixed(1)}% items`);
  if (Number.isFinite(Number(item.tokensPerSecond))) parts.push(`${Number(item.tokensPerSecond).toFixed(1)} tok/s`);
  if (Number.isFinite(Number(item.baseTokensPerSecond))) parts.push(`base ${Number(item.baseTokensPerSecond).toFixed(1)} tok/s`);
  if (item.codingRate !== null && item.codingRate !== undefined) parts.push(`${item.codingRate}% coding`);
  stats.textContent = parts.join(" · ");
  const why = document.createElement("p");
  why.className = "benchmark-advice-why";
  why.textContent = item.why;
  const measured = document.createElement("p");
  measured.className = "benchmark-commit";
  measured.textContent = item.fileName ? `Measured on ${item.fileName}` : "";
  const actions = document.createElement("div");
  actions.className = "benchmark-advice-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-btn";
  button.textContent = "Fill settings";
  button.addEventListener("click", () => fillSettingsFromAdvice(item));
  actions.appendChild(button);
  if (item.kind !== "speed-tuning") {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "small-btn";
    use.dataset.chatBase = item.variantId;
    use.textContent = "Use for chat";
    use.addEventListener("click", () => selectChatBaseForChat(item));
    actions.appendChild(use);
  }
  card.append(eyebrow, title, stats, settingChips(item.settings), why, measured, actions);
  return card;
}

function markChatBaseButtons() {
  document.querySelectorAll("[data-chat-base]").forEach((button) => {
    const selected = state.chatBase?.variantId === button.dataset.chatBase;
    button.textContent = selected ? "Selected for chat" : "Use for chat";
    button.disabled = selected;
  });
}

function renderChatBase(chatBase) {
  if (!els.benchmarkChatBase) return;
  els.benchmarkChatBase.textContent = chatBase
    ? `Chat phase base: ${chatBase.label} · ${chatBase.fileName ?? chatBase.catalogId}` +
      `${chatBase.selectedAt ? ` · selected ${new Date(chatBase.selectedAt).toLocaleString()}` : ""}`
    : "Chat phase base: default Qwen2.5 0.5B Q4. Choose a recommendation card to run the chat phase on a measured configuration.";
}

async function selectChatBaseForChat(item) {
  try {
    const { chatBase } = await request("/api/benchmarks/base", {
      method: "POST",
      body: { variantId: item.variantId },
    });
    state.chatBase = chatBase;
    renderChatBase(chatBase);
    markChatBaseButtons();
    els.benchmarkPhase.value = "chat";
    syncBenchmarkPhase();
    showToast("Chat phase base selected", {
      message: `${chatBase.label}. Start the chat phase whenever you are ready.`,
      kind: "success",
      timeout: 7000,
    });
  } catch (error) {
    showError(error);
  }
}

function renderRecommendations(advice, headerTitle = "Recommended configurations") {
  if (!els.benchmarkRecommendations) return;
  els.benchmarkRecommendations.replaceChildren();
  state.benchmarkAdvice = { advice, headerTitle };
  if (!advice?.available || hiddenAsOlder(advice.suiteVersion)) {
    const empty = document.createElement("p");
    empty.className = "benchmark-empty";
    empty.textContent = advice?.available
      ? `Recommendations from the suite v${advice.suiteVersion} run are hidden with the other older reports.`
      : "No configuration advice yet. Run the model phase.";
    els.benchmarkRecommendations.appendChild(empty);
    return;
  }
  const section = document.createElement("section");
  section.className = "benchmark-advice";
  const heading = document.createElement("div");
  heading.className = "benchmark-head";
  const title = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `Suite v${advice.suiteVersion ?? "?"}${advice.createdAt ? ` · ${new Date(advice.createdAt).toLocaleString()}` : ""}`;
  const name = document.createElement("h3");
  name.textContent = headerTitle;
  title.append(eyebrow, name);
  heading.appendChild(title);
  const grid = document.createElement("div");
  grid.className = "benchmark-advice-grid";
  for (const item of advice.items) grid.appendChild(recommendationCard(item));
  if (advice.speedTuning) {
    grid.appendChild(recommendationCard({ ...advice.speedTuning, kind: "speed-tuning", why: advice.speedTuning.why }));
  }
  section.append(heading, grid);
  els.benchmarkRecommendations.appendChild(section);
  markChatBaseButtons();
}

function stopBenchmarkPolling() {
  if (state.benchmarkTimer) clearInterval(state.benchmarkTimer);
  state.benchmarkTimer = null;
}

function startBenchmarkPolling() {
  if (state.benchmarkTimer) return;
  state.benchmarkTimer = setInterval(() => void pollBenchmark(), 1500);
}

async function pollBenchmark() {
  if (!els.benchmarkDialog.open) {
    stopBenchmarkPolling();
    return;
  }
  // A slow status call must not stack a second request behind it.
  if (state.benchmarkPolling) return;
  state.benchmarkPolling = true;
  try {
    const { job } = await request("/api/benchmarks/status", { signal: AbortSignal.timeout(10_000) });
    const previous = state.benchmarkJob;
    state.benchmarkJob = job ?? null;
    renderBenchmarkJob(job ?? null);
    if (previous?.status === "running" && job && job.status !== "running") {
      stopBenchmarkPolling();
      if (job.status === "complete") {
        const quality = Number(job.progress?.quality);
        const gateFailed = job.progress?.gate === "fail";
        showToast(`Benchmark finished${Number.isFinite(quality) ? `: ${quality.toFixed(1)}%` : ""}`, {
          message: gateFailed
            ? "The paired item gate failed; do not accept this change without an ADR."
            : job.progress?.baselineUpdated
              ? "The baseline was replaced."
              : "Results are in the report below.",
          kind: gateFailed ? "error" : "success",
          timeout: 7000,
        });
      } else if (job.status === "failed") {
        showError(Object.assign(new Error(job.error?.message ?? "The benchmark failed"), { info: job.error }));
      }
      const report = await request("/api/benchmarks").catch(() => null);
      if (report) {
        renderBenchmarkReport(report);
        state.chatBase = report.chatBase ?? state.chatBase;
        renderChatBase(state.chatBase);
        renderRecommendations(report.recommendations, report.recommendationsTitle);
      }
    }
  } catch {
    stopBenchmarkPolling();
    showToast("Benchmark status unavailable", {
      message: "The live view stopped updating.",
      fix: "Reopen Bench & Tune to reconnect.",
      kind: "error",
    });
  } finally {
    state.benchmarkPolling = false;
  }
}

function renderBenchmarkJob(job) {
  const running = job?.status === "running";
  els.benchmarkStart.disabled = running;
  els.benchmarkCancel.disabled = !running;
  els.benchmarkRunState.textContent = job ? job.status : "idle";
  els.benchmarkRunState.className = "badge";
  if (!job) {
    els.benchmarkProgress.textContent = "No benchmark is running.";
    stopBenchmarkPolling();
    return;
  }
  const progress = job.progress ?? {};
  if (running) {
    let line = "Starting…";
    if (progress.type === "prompt") {
      line = `${phaseTitle(job.phase)} · variant ${progress.variantIndex}/${progress.variantsTotal} · item ${progress.index}/${progress.total}: ${progress.label}`;
    } else if (progress.type === "variant") {
      line = `${phaseTitle(job.phase)} · variant ${progress.index}/${progress.total}: ${progress.label}`;
    } else if (progress.type === "benchmark") {
      line = `${phaseTitle(job.phase)} · suite v${progress.suiteVersion} · ${progress.variants} variants`;
    }
    const started = job.startedAt ? Math.max(0, Date.now() - new Date(job.startedAt).getTime()) : 0;
    els.benchmarkProgress.textContent = `${line} · ${Math.floor(started / 60000)}m ${Math.floor((started % 60000) / 1000)}s`;
    startBenchmarkPolling();
  } else if (job.status === "complete") {
    const quality = Number(progress.quality);
    els.benchmarkProgress.textContent =
      `Finished: ${Number.isFinite(quality) ? `${quality.toFixed(1)}% quality` : "complete"}` +
      `${progress.itemsRate !== undefined ? ` · ${progress.itemsRate}% items` : ""}` +
      `${progress.tokensPerSecond !== undefined ? ` · ${Number(progress.tokensPerSecond).toFixed(1)} tok/s` : ""}` +
      `${progress.baselineUpdated ? " · baseline replaced" : ""}` +
      `${progress.gate === "fail" ? " · quality gate failed" : ""}`;
    stopBenchmarkPolling();
  } else if (job.status === "cancelled") {
    els.benchmarkProgress.textContent = "Cancelled. No baseline was changed.";
    stopBenchmarkPolling();
  } else {
    els.benchmarkProgress.textContent = job.error?.message ?? "The benchmark failed.";
    stopBenchmarkPolling();
  }
}

// The full matrix and stages/tasks exist only in the model phase; leaving the
// chat phase checked makes a control that silently does nothing.
function syncBenchmarkPhase() {
  const modelPhase = els.benchmarkPhase.value === "model";
  els.benchmarkFull.disabled = !modelPhase;
  els.benchmarkFull.closest("label")?.classList.toggle("is-disabled", !modelPhase);
}

async function startBenchmark() {
  if (els.benchmarkBaseline.checked) {
    const confirmed = await askConfirm(
      "Replace the baseline?",
      "This run's measurements overwrite the stored baseline. Cancel keeps the current baseline; replace it only for a deliberate test-suite or settings change.",
      "Replace baseline",
    );
    if (!confirmed) return;
  }
  els.benchmarkStart.disabled = true;
  try {
    const { job } = await request("/api/benchmarks/run", {
      method: "POST",
      body: {
        phase: els.benchmarkPhase.value,
        updateBaseline: els.benchmarkBaseline.checked,
        download: els.benchmarkDownload.checked,
        fullMatrix: els.benchmarkPhase.value === "model" && els.benchmarkFull.checked,
      },
    });
    state.benchmarkJob = job;
    renderBenchmarkJob(job);
    startBenchmarkPolling();
  } catch (error) {
    els.benchmarkStart.disabled = false;
    showError(error);
    const status = await request("/api/benchmarks/status").catch(() => null);
    if (status) {
      state.benchmarkJob = status.job ?? null;
      renderBenchmarkJob(status.job ?? null);
    }
  }
}

async function cancelBenchmark() {
  els.benchmarkCancel.disabled = true;
  try {
    const { job } = await request("/api/benchmarks/cancel", { method: "POST" });
    state.benchmarkJob = job;
    renderBenchmarkJob(job);
  } catch (error) {
    els.benchmarkCancel.disabled = false;
    showError(error);
  }
}

const TUNE_TASKS = ["code", "comprehension", "recall"];
const TASK_NAMES = { code: "Code", comprehension: "Comprehension", recall: "Long context" };

/** Every tunable setting: its stage, a readable name and what it changes. */
const SETTING_GUIDE = {
  device: ["device", "CPU or GPU", "Which backend answers fastest with as many right answers"],
  contextSize: ["quality", "Context size", "How much text the model can see at once"],
  kvCache: ["quality", "KV cache type", "Precision of the attention cache; lower saves memory"],
  flashAttention: ["speed", "Flash attention", "A faster attention kernel"],
  useMmap: ["speed", "Memory map", "Read the model file in place instead of copying it"],
  batchSize: ["speed", "Batch size", "Tokens processed per step while reading the prompt"],
  threads: ["speed", "Threads", "CPU threads used for answering"],
  checkpointing: ["speed", "Checkpointing", "Saved states for recurrent and sliding-window models"],
  temperature: ["sampling", "Temperature", "Randomness of the answer; 0 always picks the likeliest word"],
  maxTokens: ["sampling", "Answer length", "Most tokens an answer may use"],
  repeatPenalty: ["sampling", "Repeat penalty", "Discourages repeating the same words"],
  minP: ["sampling", "Min-p", "Drops words much less likely than the best one"],
  topP: ["sampling", "Top-p", "Keeps the likeliest words up to this share of probability"],
  topK: ["sampling", "Top-k", "Keeps only this many likeliest words (0 = off)"],
  systemPrompt: ["prompt", "System prompt", "The one-sentence instruction given before every question"],
  reasoning: ["prompt", "Reasoning", "Off, or asking the model to think before answering"],
  promptRepeat: ["prompt", "Prompt repeat", "Asking the question once, twice or three times"],
};
const STAGE_NAMES = { device: "Device", quality: "Quality", speed: "Speed", sampling: "Sampling", prompt: "Prompt" };

/** One chip per stage: done, partly done or not yet, flagged when measured on an older test suite. */
/**
 * One button per stage: done, partly done or not yet, flagged when measured on an older
 * test suite. Clicking one runs just that stage for the model, on top of its saved results.
 */
function tuneStageChips(stages, staleParts = [], { modelId = null, running = false, current = null, deviceParts = [] } = {}) {
  const chips = document.createElement("div");
  chips.className = "tune-chips";
  const add = (stage, text, status, stale, title) => {
    const other = deviceParts.some((part) => part === stage || part.startsWith(`${stage}:`));
    const chip = Object.assign(document.createElement("button"), {
      type: "button",
      className: `tune-chip ${status}${stale ? " stale" : ""}${other ? " other-device" : ""}${current === stage ? " running" : ""}`,
      textContent: text,
      disabled: running || !modelId,
      title: `${title}${other ? ", measured on another device" : ""}\n${status === "done" ? "Click to run it again" : "Click to run it"}; the other stages keep their saved results and later stages build on this one.`,
    });
    chip.dataset.tuneStage = stage;
    chip.dataset.tuneStageModel = modelId ?? "";
    chips.appendChild(chip);
  };
  for (const stage of ["device", "quality", "speed"]) {
    const status = stages?.[stage] ?? "pending";
    const stale = staleParts.includes(stage);
    add(stage, `${STAGE_NAMES[stage]} ${status === "done" ? "✓" : status === "partial" ? "…" : "–"}`, status, stale, `${STAGE_NAMES[stage]}: ${status}${stale ? ", measured on an older test suite" : ""}`);
  }
  for (const stage of ["sampling", "prompt"]) {
    const done = TUNE_TASKS.filter((task) => stages?.[stage]?.[task] === "done");
    const status = done.length === TUNE_TASKS.length ? "done" : done.length ? "partial" : "pending";
    const stale = staleParts.some((part) => part.startsWith(`${stage}:`));
    add(stage, `${STAGE_NAMES[stage]} ${done.length}/${TUNE_TASKS.length}`, status, stale, `${STAGE_NAMES[stage]} done for: ${done.map((task) => TASK_NAMES[task]).join(", ") || "no task yet"} (runs every task)`);
  }
  return chips;
}

/** The suite's question types in plain words. */
const TYPE_NAMES = {
  "code-comprehension": "Read code",
  code: "Write a function", "code-long": "Write a long function", "code-repo": "Work in a codebase",
  bugfix: "Fix a bug", "bugfix-long": "Fix several bugs", "bugfix-repo": "Fix a bug in a codebase", "public-code": "HumanEval and MBPP (public)",
  context: "Reason over a long document", recall: "Look up in a long document",
};

/** How the suite checks an answer, in plain words. */
const CHECK_NAMES = {
  exact: "exact answer", choice: "chosen letter", number: "final number", oneOf: "one of the accepted answers",
  contains: "contains a phrase", containsAny: "contains one of several phrases", containsAll: "contains every required phrase",
  notContains: "leaves out a phrase", regex: "matches a pattern", json: "valid JSON", jsonValue: "JSON with the right values",
  jsSyntax: "code that parses", jsTests: "code that passes its tests", commaCount: "number of commas", bulletCount: "number of bullets",
  maxWords: "word limit", noUppercase: "no capital letters",
};

const SOURCE_NAMES = { own: "ModelDuck's own" };

/** The suite's tasks and question types, fetched once (ADR-058). */
async function loadBenchSuite() {
  if (state.benchSuite) return;
  try {
    state.benchSuite = await request("/api/benchmarks/suite");
    renderBenchSuite(state.benchSuite);
  } catch (error) {
    showError(error);
  }
}

function renderBenchSuite(suite) {
  const tasks = Array.isArray(suite.tasks) ? suite.tasks : [];
  const heldShare = Number.isFinite(suite.holdoutShare) ? `${Math.round(suite.holdoutShare * 100)}%` : "–";
  if (els.benchSuiteVersion) els.benchSuiteVersion.textContent = `v${suite.suiteVersion}`;
  const rounds = tasks.flatMap((task) => task.rungs);
  const summary = document.createElement("div");
  summary.className = "suite-summary";
  for (const [value, label] of [
    [suite.items ?? "–", "questions"],
    [tasks.length || "–", "tasks"],
    [heldShare, "held back"],
    [rounds.length ? `${Math.min(...rounds)}–${Math.max(...rounds)}` : "–", "rounds"],
  ]) {
    const stat = document.createElement("div");
    stat.className = "suite-stat";
    stat.append(Object.assign(document.createElement("strong"), { textContent: String(value) }), Object.assign(document.createElement("small"), { textContent: label }));
    summary.appendChild(stat);
  }
  els.benchSuite.replaceChildren(summary);

  for (const task of tasks) {
    const section = document.createElement("section");
    section.className = "suite-task";
    const head = document.createElement("div");
    head.className = "suite-task-head";
    const title = document.createElement("div");
    title.append(
      Object.assign(document.createElement("p"), { className: "eyebrow", textContent: "Task" }),
      Object.assign(document.createElement("h4"), { textContent: TASK_NAMES[task.id] ?? task.label }),
    );
    const count = document.createElement("div");
    count.className = "suite-task-count";
    count.append(
      Object.assign(document.createElement("strong"), { textContent: String(task.items) }),
      Object.assign(document.createElement("small"), { textContent: "questions" }),
    );
    head.append(title, count);

    const meta = Object.assign(document.createElement("p"), {
      className: "suite-task-meta",
      textContent: `Tuned on ${task.tunedOn} · rounds ${task.rungs.join(" / ")} · ${task.held} held back`,
    });
    const types = document.createElement("div");
    types.className = "suite-types";
    for (const type of task.types) {
      const row = document.createElement("div");
      row.className = "suite-type";
      row.append(
        Object.assign(document.createElement("span"), { className: "suite-type-name", textContent: TYPE_NAMES[type.category] ?? type.category }),
        Object.assign(document.createElement("span"), { className: "suite-type-count", textContent: `${type.items} · ${type.held} held` }),
      );
      types.appendChild(row);
    }

    const details = document.createElement("details");
    details.className = "suite-details";
    details.appendChild(Object.assign(document.createElement("summary"), { textContent: "Sources and checks" }));
    const table = document.createElement("table");
    table.className = "benchmark-table";
    const headRow = table.createTHead().insertRow();
    for (const text of ["Question type", "Questions", "Held back", "From", "Checked by"]) {
      headRow.appendChild(Object.assign(document.createElement("th"), { textContent: text }));
    }
    const body = table.createTBody();
    for (const type of task.types) {
      body.insertRow().append(
        tuneCell(TYPE_NAMES[type.category] ?? type.category),
        tuneCell(String(type.items)),
        tuneCell(String(type.held)),
        tuneCell(type.sources.map((source) => SOURCE_NAMES[source] ?? source).join(", ")),
        tuneCell(type.checks.map((check) => CHECK_NAMES[check] ?? check).join(", ")),
      );
    }
    details.appendChild(table);
    section.append(head, meta, types, details);
    els.benchSuite.appendChild(section);
  }
  if (suite.multistep) els.benchSuite.appendChild(renderMultistepSuite(suite.multistep));
}

/** The opt-in multistep chains, shown after the tuned tasks and marked as not tuned or gated. */
function renderMultistepSuite(multistep) {
  const section = document.createElement("section");
  // Its own class: it sits with the tuned tasks but is not one of them.
  section.className = "suite-optin";
  const head = document.createElement("div");
  head.className = "suite-task-head";
  const title = document.createElement("div");
  title.append(
    Object.assign(document.createElement("p"), { className: "eyebrow", textContent: "Opt-in evaluation" }),
    Object.assign(document.createElement("h4"), { textContent: multistep.label }),
  );
  const count = document.createElement("div");
  count.className = "suite-task-count";
  count.append(
    Object.assign(document.createElement("strong"), { textContent: String(multistep.checks) }),
    Object.assign(document.createElement("small"), { textContent: "checks" }),
  );
  head.append(title, count);
  // The meta line is short like the tasks'; the description and the case-sensitive command stay in plain case.
  const meta = Object.assign(document.createElement("p"), {
    className: "suite-task-meta",
    textContent: `${multistep.chains.length} chains · ${multistep.steps} steps · not tuned or gated`,
  });
  const text = Object.assign(document.createElement("p"), { className: "suite-optin-text", textContent: `${multistep.description} Run: ` });
  text.appendChild(Object.assign(document.createElement("code"), { textContent: multistep.command }));
  const types = document.createElement("div");
  types.className = "suite-types";
  for (const chain of multistep.chains) {
    const row = document.createElement("div");
    row.className = "suite-type";
    row.append(
      Object.assign(document.createElement("span"), { className: "suite-type-name", textContent: chain.label }),
      Object.assign(document.createElement("span"), { className: "suite-type-count", textContent: `${chain.steps} steps · ${chain.kind}` }),
    );
    types.appendChild(row);
  }
  section.append(head, meta, text, types);
  return section;
}

/** Whether a type's difference stands out from noise (ADR-059); older profiles have no p. */
function typeDifference(entry) {
  if (typeof entry?.p !== "number") return "–";
  if (entry.right === entry.defaultRight) return "same";
  if (entry.p >= 0.05) return "too few to tell";
  return entry.right > entry.defaultRight ? "clearly better" : "clearly worse";
}

const rightOf = (entry, key) => (entry ? `${entry[key]} of ${entry.items}` : "–");

/** Right answers per question type for every task: preset against defaults, tuned and unseen (ADR-056). */
function byTypeSection(tasks) {
  const rows = Object.entries(tasks ?? {}).flatMap(([task, preset]) =>
    Object.entries(preset?.stats?.byType ?? {}).map(([type, entry]) => ({ task, type, entry, unseen: preset.holdout?.byType?.[type] })));
  if (!rows.length) return null;
  const section = document.createElement("details");
  section.className = "tune-by-type";
  section.appendChild(Object.assign(document.createElement("summary"), { textContent: "By question type" }));
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const head = table.createTHead().insertRow();
  for (const text of ["Task", "Question type", "Preset", "Defaults", "Difference", "Unseen: preset", "Unseen: defaults"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: text }));
  const body = table.createTBody();
  for (const { task, type, entry, unseen } of rows) {
    const row = body.insertRow();
    const difference = typeDifference(entry);
    // Only a type clearly worse than the defaults stands out; profiles without p keep the old marking.
    if (difference === "clearly worse" || (difference === "–" && entry.right < entry.defaultRight)) row.className = "tune-type-worse";
    row.append(tuneCell(TASK_NAMES[task] ?? task), tuneCell(TYPE_NAMES[type] ?? type), tuneCell(rightOf(entry, "right")), tuneCell(rightOf(entry, "defaultRight")), tuneCell(difference), tuneCell(rightOf(unseen, "right")), tuneCell(rightOf(unseen, "defaultRight")));
  }
  section.appendChild(table);
  return section;
}

/** The shared quality settings checked on each task (ADR-057). */
function perTaskText(load) {
  if (!load?.perTask) return null;
  const parts = Object.entries(load.perTask).map(([task, entry]) => `${TASK_NAMES[task] ?? task} ${entry.rate}% (was ${entry.before}%)`);
  const reverted = load.reverted ? ` Went back to the earlier settings: ${TASK_NAMES[load.reverted] ?? load.reverted} was worse (p=${load.perTask[load.reverted]?.pValue}).` : " No task got worse.";
  return `${parts.join(" · ")}.${reverted}`;
}

/** A preset against the defaults on items it was never tuned on (ADR-054). */
function unseenText(holdout) {
  if (!holdout || !Number.isFinite(holdout.rate) || !Number.isFinite(holdout.defaultRate)) return "–";
  const delta = holdout.vsDefault?.rateDelta ?? holdout.rate - holdout.defaultRate;
  return `${holdout.rate}% vs ${holdout.defaultRate}% default (${delta >= 0 ? "+" : ""}${delta} pts, p=${holdout.vsDefault?.pValue ?? "–"})${holdout.fellBack ? "; worse, so the defaults apply" : ""}`;
}
const UNSEEN_TITLE = "Measured on a quarter of the task's questions that the tune never used, against the defaults";

const shownValue = (value) => (typeof value === "string" && value.length > 60 ? `${value.slice(0, 57)}…` : String(value));

/** The expanded row under a model: why it is out of date, the device verdict, load settings and each task's result. */
function tuneDetails(model) {
  const profile = model.profile;
  const box = document.createElement("div");
  box.className = "tune-details";
  const actions = document.createElement("p");
  actions.className = "tune-profile-actions";
  const exportButton = Object.assign(document.createElement("button"), { type: "button", className: "small-btn", textContent: "Export profile" });
  exportButton.dataset.profileExport = model.profileId;
  const importLabel = Object.assign(document.createElement("label"), { className: "small-btn", textContent: "Import profile" });
  const importInput = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
  importInput.hidden = true;
  importInput.addEventListener("change", () => {
    if (importInput.files?.[0]) void importProfile(importInput.files[0]);
    importInput.value = "";
  });
  importLabel.appendChild(importInput);
  actions.append(exportButton, importLabel);
  box.appendChild(actions);
  const line = (label, text) => {
    const row = document.createElement("p");
    row.append(Object.assign(document.createElement("strong"), { textContent: `${label}: ` }), text);
    box.appendChild(row);
  };
  if (model.warnings.length) line("Out of date", `${model.warnings.map((warning) => warning.split(";")[0]).join("; ")}. Re-tune, or measure only the parts you need again.`);
  if (profile?.device?.reason) line("Device", profile.device.reason);
  const load = Object.entries(profile?.load?.settings ?? {});
  if (load.length) line("Load settings", load.map(([key, value]) => `${SETTING_GUIDE[key]?.[1] ?? SETTING_LABELS[key] ?? key} ${value}`).join(" · "));
  const qualityCheck = perTaskText(profile?.load);
  if (qualityCheck) line("Quality settings checked per task", qualityCheck);
  if (profile?.speed) line("Speed presets", `Fastest uses ${profile.speed.fastest?.threads ?? "–"} threads, Light ${profile.speed.light?.threads ?? "–"}`);
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const head = table.createTHead().insertRow();
  for (const label of ["Task", "Right answers", "95% range", "vs defaults", "On unseen questions", "Chosen settings", "Run for this task"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: label }));
  const body = table.createTBody();
  for (const task of TUNE_TASKS) {
    const preset = profile?.tasks?.[task];
    const stats = preset?.stats;
    const versus = stats?.vsDefault;
    const rate = Number.isFinite(stats?.rate) ? `${stats.rate}%` : stats ? "imported, not measured here" : "not tuned";
    // Run one stage for just this task, on top of the saved results.
    const run = document.createElement("td");
    for (const stage of ["sampling", "prompt"]) {
      const button = Object.assign(document.createElement("button"), { type: "button", className: "small-btn", textContent: STAGE_NAMES[stage], disabled: state.tuneJob?.status === "running" });
      button.title = `Run the ${STAGE_NAMES[stage].toLowerCase()} stage for ${TASK_NAMES[task]} only; the other tasks and stages keep their results.`;
      Object.assign(button.dataset, { tuneTaskStage: stage, tuneTask: task, tuneTaskModel: model.id });
      run.append(button, " ");
    }
    body.insertRow().append(
      tuneCell(TASK_NAMES[task]),
      tuneCell(rate),
      tuneCell(stats?.ci95 ? `${stats.ci95.low}–${stats.ci95.high}%` : "–", "The true rate lies in this range with 95% confidence"),
      tuneCell(versus ? `${versus.rateDelta >= 0 ? "+" : ""}${versus.rateDelta} pts (p=${versus.pValue})` : "–", "Paired against the app defaults; p below 0.05 means the gain is unlikely to be chance"),
      tuneCell(unseenText(preset?.holdout), UNSEEN_TITLE),
      tuneCell(Object.entries(preset?.settings ?? {}).map(([key, value]) => `${SETTING_GUIDE[key]?.[1] ?? key} ${shownValue(value)}`).join(" · ") || "defaults"),
      run,
    );
  }
  box.appendChild(table);
  const types = byTypeSection(profile?.tasks);
  if (types) box.appendChild(types);
  const sweeps = state.tuneSweeps.get(model.profileId);
  box.appendChild(sweeps ? tuneTried(sweeps) : Object.assign(document.createElement("p"), { textContent: "Loading what was tried…" }));
  return box;
}

const patchText = (patch) => {
  const entries = Object.entries(patch ?? {});
  return entries.length === 1 ? shownValue(entries[0][1]) : entries.map(([key, value]) => `${key} ${shownValue(value)}`).join(", ");
};

/** Every setting the tune tried, with each value's result on the final round and why the winner won or the setting was kept. */
function tuneTried(sweeps) {
  const box = document.createElement("details");
  box.className = "tune-tried";
  box.appendChild(Object.assign(document.createElement("summary"), { textContent: "What was tried, and why each setting was chosen" }));
  // The last pass's sweep per setting is the decision that stands.
  const latest = new Map();
  for (const sweep of sweeps) if (sweep.rungs?.length) latest.set(`${sweep.task ?? "load"}|${sweep.stage}|${sweep.axis}`, sweep);
  const groups = [["load", "Load settings (all tasks)"], ...TUNE_TASKS.map((task) => [task, TASK_NAMES[task]])];
  for (const [group, title] of groups) {
    const rows = [...latest.values()].filter((sweep) => (sweep.task ?? "load") === group);
    if (!rows.length) continue;
    box.appendChild(Object.assign(document.createElement("h5"), { textContent: title }));
    const table = document.createElement("table");
    table.className = "benchmark-table";
    const head = table.createTHead().insertRow();
    for (const label of ["Setting", "Values tried (final round)", "Decision"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: label }));
    const body = table.createTBody();
    for (const sweep of rows) {
      const last = sweep.rungs.at(-1);
      const timed = sweep.stage === "speed";
      const tried = document.createElement("td");
      for (const candidate of last.candidates) {
        const won = JSON.stringify(candidate.patch) === JSON.stringify(sweep.winner);
        const result = candidate.failed ? "failed to load" : timed ? `${candidate.latencyMs ?? "–"} ms` : `${candidate.rate}%`;
        const chip = Object.assign(document.createElement("span"), { className: `tune-chip${won ? " done" : ""}`, textContent: `${patchText(candidate.patch)}: ${result}` });
        chip.title = Object.entries(candidate.patch).map(([key, value]) => `${key}: ${value}`).join("\n");
        tried.append(chip, " ");
      }
      // Screened out on the first quarter of the items (ADR-049).
      for (const dropped of sweep.dropped ?? []) {
        const chip = Object.assign(document.createElement("span"), { className: "tune-chip dropped", textContent: `${patchText(dropped.patch)}: dropped after ${dropped.of} (${dropped.solved}/${dropped.of})` });
        chip.title = `${dropped.behind} items behind the leader on the first ${dropped.of}, so it was not measured further.`;
        tried.append(chip, " ");
      }
      const decision = sweep.groupGuard ?? (sweep.kept
        ? sweep.kept
        : sweep.changed
          ? `Changed from ${patchText(sweep.previous)} to ${patchText(sweep.winner)}${Number.isFinite(sweep.pValue) && !timed ? ` (paired p=${sweep.pValue})` : ""}.` +
            // Profiles tuned before ADR-042 could move on noise; say so instead of presenting it as a finding.
            (!timed && !sweep.kept && sweep.pValue > 0.2 && sweep.c > sweep.b ? ` Not significant: today's tuner would have kept ${patchText(sweep.previous)}.` : "")
          : `Kept ${patchText(sweep.winner)}: nothing did better.`);
      const skipped = sweep.skipped?.length ? ` Skipped: ${sweep.skipped.map((entry) => patchText(entry.patch ?? entry)).join(", ")}.` : "";
      body.insertRow().append(tuneCell(SETTING_GUIDE[sweep.axis]?.[1] ?? sweep.axis, SETTING_GUIDE[sweep.axis]?.[2] ?? ""), tried, tuneCell(`${decision}${skipped}`));
    }
    box.appendChild(table);
  }
  return box;
}

const durationText = (ms) => {
  if (!(ms >= 0)) return "–";
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? `${Math.round(ms / 1000)} s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/** What a run was asked to measure, in a few words. */
function runRequestText(request = {}) {
  const parts = [request.only?.length ? `only ${request.only.map((name) => SETTING_GUIDE[name]?.[1] ?? name).join(", ")}` : (request.stages ?? []).map((stage) => STAGE_NAMES[stage] ?? stage).join(", ")];
  if (request.tasks?.length && request.tasks.length < TUNE_TASKS.length) parts.push(`for ${request.tasks.map((task) => TASK_NAMES[task] ?? task).join(", ")}`);
  if (request.force) parts.push("from scratch");
  if (request.continueRun) parts.push("(continued)");
  return parts.filter(Boolean).join(" ");
}

/** Every saved tune run, newest first (ADR-050): feeds the continue section and, when open, the run list. */
async function loadTuneRuns() {
  try {
    const { runs } = await request("/api/tune/runs");
    state.tuneRuns = runs ?? [];
    renderTuneContinue();
    if (benchTab() === "runs") renderTuneRuns(state.tuneRuns);
  } catch (error) {
    showError(error);
  }
}

/** How many parts of a run's request are still not done for its model. */
function partsLeft(model, request = {}) {
  if (request.only?.length) return request.only.length;
  const stages = model.profile?.stages ?? {};
  const tasks = request.tasks?.length ? request.tasks : TUNE_TASKS;
  let left = 0;
  for (const stage of request.stages ?? []) {
    if (stage === "sampling" || stage === "prompt") left += tasks.filter((task) => stages[stage]?.[task] !== "done").length;
    else if (stages[stage] !== "done") left += 1;
  }
  return left;
}

/** The model a run can be continued on: its latest run, unfinished, with work left (ADR-051). */
function continuable(run) {
  if (!["stopped", "failed", "interrupted"].includes(run.outcome)) return null;
  const latest = (state.tuneRuns ?? []).find((entry) => entry.profileId === run.profileId);
  const model = (state.tuneOverview ?? []).find((entry) => entry.profileId === run.profileId);
  return latest?.id === run.id && model && partsLeft(model, run.request) > 0 ? model : null;
}

function continueButton(run) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "small-btn", textContent: "Continue", disabled: state.tuneJob?.status === "running" });
  button.title = "Run the same request again, measuring only what it did not finish; finished parts are kept.";
  button.dataset.tuneContinue = run.id;
  return button;
}

function renderTuneContinue() {
  els.tuneContinue.replaceChildren();
  const unfinished = (state.tuneRuns ?? []).filter((run) => continuable(run));
  if (!unfinished.length) return;
  els.tuneContinue.appendChild(Object.assign(document.createElement("h4"), { textContent: "Continue where you left off" }));
  for (const run of unfinished) {
    const model = continuable(run);
    const left = partsLeft(model, run.request);
    const row = document.createElement("p");
    const what = runRequestText(run.request) || "everything";
    row.append(
      Object.assign(document.createElement("span"), {
        textContent: `${model.name}: ${what}, ${run.outcome} ${new Date(run.updatedAt ?? run.startedAt).toLocaleString()} after ${run.answers ?? 0} answers; ${left} ${run.request?.only?.length ? "setting" : "part"}${left === 1 ? "" : "s"} left. `,
        title: run.error ?? "",
      }),
      continueButton(run),
    );
    els.tuneContinue.appendChild(row);
  }
}

async function continueTuneRun(id) {
  const run = (state.tuneRuns ?? []).find((entry) => entry.id === id);
  const model = run && continuable(run);
  if (!model) return;
  await startTune([model.id], { stage: run.request.stages, tasks: run.request.tasks, only: run.request.only, continueRun: true });
}

function renderTuneRuns(runs) {
  els.tuneRunsList.replaceChildren();
  if (!runs.length) {
    els.tuneRunsList.appendChild(Object.assign(document.createElement("p"), { className: "benchmark-empty", textContent: "No tune runs yet. Each run from now on is kept here." }));
    return;
  }
  const names = new Map((state.tuneOverview ?? []).map((model) => [model.profileId, model.name]));
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const head = table.createTHead().insertRow();
  for (const text of ["When", "Model", "What ran", "Outcome", "Took", "Answers", "Pace", ""]) head.appendChild(Object.assign(document.createElement("th"), { textContent: text }));
  const body = table.createTBody();
  for (const run of runs) {
    const open = Object.assign(document.createElement("button"), { type: "button", className: "small-btn", textContent: "Open" });
    open.dataset.tuneRun = run.id;
    const action = document.createElement("td");
    action.appendChild(open);
    if (continuable(run)) action.append(" ", continueButton(run));
    const pace = run.answers && run.durationMs ? `${(run.durationMs / 1000 / run.answers).toFixed(2)} s/answer` : "–";
    body.insertRow().append(
      tuneCell(new Date(run.startedAt).toLocaleString()),
      tuneCell(names.get(run.profileId) ?? run.profileId, run.model),
      tuneCell(runRequestText(run.request)),
      tuneCell(run.outcome, run.error ?? ""),
      tuneCell(durationText(run.durationMs)),
      tuneCell(`${run.answers ?? 0}${run.expectedAnswers ? ` of up to ${run.expectedAnswers}` : ""}`),
      tuneCell(pace),
      action,
    );
  }
  els.tuneRunsList.appendChild(table);
}

async function openTuneRun(id) {
  try {
    const detail = await request(`/api/tune/runs/${encodeURIComponent(id)}`);
    renderTuneRunDetail(detail);
    els.tuneRunDetail.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    showError(error);
  }
}

/** One run in full: summary, answer statistics, results per task and every decision. */
function renderTuneRunDetail({ run, answers }) {
  const box = document.createElement("div");
  box.className = "tune-details tune-run-detail";
  box.appendChild(Object.assign(document.createElement("h4"), { textContent: `${run.model} · ${new Date(run.startedAt).toLocaleString()}` }));
  const line = (label, text) => {
    const row = document.createElement("p");
    row.append(Object.assign(document.createElement("strong"), { textContent: `${label}: ` }), text);
    box.appendChild(row);
  };
  line("Outcome", `${run.outcome}${run.error ? ` — ${run.error}` : ""}`);
  line("What ran", runRequestText(run.request) || "everything");
  line("Took", `${durationText(run.durationMs)}${run.finishedAt ? "" : " so far"}`);
  if (answers?.answers) {
    const times = answers.ms ? `; answers took ${answers.ms.median} ms typically, ${answers.ms.p90} ms for the slowest tenth` : "";
    const tokens = answers.outputTokens ? `; ${answers.outputTokens.mean} tokens per answer on average` : "";
    // Wrong answers apart from replies nothing could be read from (ADR-052).
    const failures = answers.wrong === undefined ? `${answers.errors} errors` : `${answers.wrong} wrong, ${answers.unreadable} could not be read, ${answers.errors} errors`;
    line("Answers", `${answers.answers}${run.expectedAnswers ? ` of up to ${run.expectedAnswers}` : ""}; ${answers.right}% of checks passed; ${failures}${times}${tokens}`);
    if (answers.unreadableExamples?.length) {
      const examples = document.createElement("details");
      examples.appendChild(Object.assign(document.createElement("summary"), { textContent: `Replies that could not be read (first ${answers.unreadableExamples.length})` }));
      const list = document.createElement("ul");
      for (const example of answers.unreadableExamples) list.appendChild(Object.assign(document.createElement("li"), { textContent: `${example.item}: ${example.text || "(empty reply)"}` }));
      examples.appendChild(list);
      box.appendChild(examples);
    }
  }
  const backend = run.result?.load?.settings?.gpuBackend;
  if (backend) line("Device", backend === "cpu" ? "CPU" : `${backend} GPU`);
  const qualityCheck = perTaskText(run.result?.load);
  if (qualityCheck) line("Quality settings checked per task", qualityCheck);
  if (run.fingerprint) line("Measured on", `test suite v${run.fingerprint.suiteVersion}, ${run.fingerprint.cpu ?? "this CPU"}, node-llama-cpp ${run.fingerprint.nodeLlamaCpp ?? "?"}`);
  const tasks = Object.entries(run.result?.tasks ?? {});
  if (tasks.length) {
    const table = document.createElement("table");
    table.className = "benchmark-table";
    const head = table.createTHead().insertRow();
    for (const text of ["Task", "Right answers", "95% range", "vs defaults", "On unseen questions"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: text }));
    const body = table.createTBody();
    for (const [task, preset] of tasks) {
      const stats = preset.stats;
      const versus = stats?.vsDefault;
      body.insertRow().append(
        tuneCell(TASK_NAMES[task] ?? task),
        tuneCell(stats ? `${stats.rate}%` : "–"),
        tuneCell(stats?.ci95 ? `${stats.ci95.low}–${stats.ci95.high}%` : "–"),
        tuneCell(versus ? `${versus.rateDelta >= 0 ? "+" : ""}${versus.rateDelta} pts (p=${versus.pValue})` : "–"),
        tuneCell(unseenText(preset.holdout), UNSEEN_TITLE),
      );
    }
    box.appendChild(table);
  }
  const types = byTypeSection(run.result?.tasks);
  if (types) box.appendChild(types);
  if (run.sweeps?.length) {
    const tried = tuneTried(run.sweeps);
    tried.open = true;
    box.appendChild(tried);
  }
  const download = Object.assign(document.createElement("a"), { href: `/api/tune/runs/${encodeURIComponent(run.id)}/answers`, textContent: "Download every answer (JSON lines)" });
  download.setAttribute("download", `tune-run-${run.id}.jsonl`);
  box.appendChild(download);
  els.tuneRunDetail.replaceChildren(box);
}

async function loadTuneSweeps(model) {
  try {
    const { profile } = await request(`/api/profiles/${encodeURIComponent(model.profileId)}`);
    state.tuneSweeps.set(model.profileId, profile.sweeps ?? []);
  } catch (error) {
    state.tuneSweeps.set(model.profileId, []);
    showError(error);
  }
  renderTuneModels();
}

async function exportProfile(profileId) {
  try {
    const recipe = await request(`/api/profiles/${encodeURIComponent(profileId)}/export`);
    const blob = new Blob([`${JSON.stringify(recipe, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: `${profileId}.modelduck-profile.json` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    showError(error);
  }
}

async function importProfile(file) {
  try {
    const recipe = JSON.parse(await file.text());
    const result = await request("/api/profiles/import", { method: "POST", body: recipe });
    await loadTuneOverview();
    if (result.warnings?.length) {
      showError({ info: { message: `Imported, with warnings: ${result.warnings.join(" ")}`, why: "The profile was measured on another machine, suite or runtime.", fix: "Re-tune the parts that changed." } });
    }
  } catch (error) {
    showError(error);
  }
}

const PRESET_FIT = Object.freeze({
  exact: "Measured on this computer and this model file: load and sampling settings apply.",
  portable: "Measured on another computer: the sampling and prompt settings apply; the load settings stay at this computer's defaults.",
  none: "Measured on another model file: it does not apply.",
  not_installed: "This model is not installed. Download it from Models → Discover first.",
});

/** Shipped presets with how each fits here; applying one is always the user's click (G-004). */
let shippedPresetsLoad = 0;

/** "measured on test suite v17, this is v18" → "Measured on test suite v17, this is v18." */
const sentence = (text) => {
  const trimmed = String(text ?? "").trim();
  return trimmed ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}` : "";
};

async function loadShippedPresets() {
  const box = $("tune-presets");
  if (!box) return;
  // Opening the section twice quickly must not draw the list twice: only the latest load renders.
  const load = ++shippedPresetsLoad;
  let presets = [];
  try {
    ({ presets } = await request("/api/presets"));
  } catch (error) {
    if (load === shippedPresetsLoad) showError(error);
    return;
  }
  if (load !== shippedPresetsLoad) return;
  box.replaceChildren();
  if (!presets.length) {
    const empty = document.createElement("p");
    empty.textContent = "No shipped presets.";
    box.appendChild(empty);
    return;
  }
  for (const preset of presets) {
    const row = document.createElement("div");
    row.className = "tune-preset";
    const name = document.createElement("strong");
    name.textContent = preset.catalogId;
    const rate = preset.rates?.code?.rate;
    const meta = document.createElement("span");
    meta.textContent = [rate != null ? `code ${rate}% on ${preset.rates.code.items ?? "?"} items` : "", preset.measuredOn ? `measured on ${preset.measuredOn}` : ""].filter(Boolean).join(" · ");
    const fit = document.createElement("p");
    fit.textContent = PRESET_FIT[preset.status] ?? preset.status;
    // What changed since it was measured: one sentence per reason, apart from the fit.
    const note = document.createElement("p");
    note.className = "tune-preset-note";
    note.textContent = (preset.reasons ?? []).map(sentence).join(" ");
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "small-btn";
    apply.textContent = "Apply";
    apply.disabled = preset.status !== "exact" && preset.status !== "portable";
    apply.setAttribute("aria-label", `Apply the shipped preset for ${preset.catalogId}`);
    apply.addEventListener("click", () => void applyShippedPreset(preset.catalogId));
    row.append(name, meta, fit, ...(note.textContent ? [note] : []), apply);
    box.appendChild(row);
  }
}

async function applyShippedPreset(catalogId, { force = false } = {}) {
  try {
    const result = await request("/api/presets/apply", { method: "POST", body: { catalogId, ...(force && { force: true }) } });
    await loadTuneOverview();
    showToast("Preset applied", { message: `${catalogId}: ${PRESET_FIT[result.status] ?? result.status}`, fix: result.next ?? "" });
  } catch (error) {
    if (error?.info?.code === "preset_would_replace_tune" && !force) {
      const confirmed = await askConfirm("Replace the profile tuned here?", `${error.info.why} ${error.info.fix ?? ""}`.trim(), "Replace with preset");
      if (confirmed) await applyShippedPreset(catalogId, { force: true });
      return;
    }
    showError(error);
  }
}

function tuneCell(text, title = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (title) cell.title = title;
  return cell;
}

function renderTuneModels() {
  const models = state.tuneOverview ?? [];
  const order = state.tuneJob?.order;
  const ordered = order?.length
    ? [...models].sort((left, right) => (order.indexOf(left.profileId) + 1 || Infinity) - (order.indexOf(right.profileId) + 1 || Infinity))
    : models;
  const items = new Map((state.tuneJob?.items ?? []).map((item) => [item.profileId, item]));
  els.tuneModels.replaceChildren();
  if (!models.length) {
    const empty = document.createElement("p");
    empty.className = "benchmark-empty";
    empty.textContent = "Install a model to tune it.";
    els.tuneModels.appendChild(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const head = table.createTHead().insertRow();
  for (const label of ["Model", "Device", "Progress", "Right answers per task", ""]) {
    head.appendChild(Object.assign(document.createElement("th"), { textContent: label }));
  }
  const body = table.createTBody();
  const running = state.tuneJob?.status === "running";
  const queueActive = running || state.tuneJob?.status === "paused";
  // Several quantisations of one model share a name; show their file names then.
  const repeated = new Set(models.map((model) => model.name).filter((name, index, names) => names.indexOf(name) !== index));
  for (const [position, model] of ordered.entries()) {
    const profile = model.profile;
    const row = body.insertRow();
    const item = items.get(model.profileId);
    const step = item?.progress?.stage ? ` · ${item.progress.stage}${item.progress.axis ? `: ${item.progress.axis}` : ""}` : "";
    // The tune's own estimate from its measured pace (ADR-045).
    const eta = item?.progress?.eta ? ` · ${item.progress.eta}` : "";
    const live = item && running ? ` — ${item.status}${item.lane ? ` in the ${item.lane.toUpperCase()} lane` : ""}${step}${eta}${item.provisional ? " · quick preset saved" : ""}` : "";
    const label = repeated.has(model.name) ? `${model.name} (${model.fileName})` : model.name;
    const nameCell = tuneCell(`${label}${live}`, model.fileName);
    // Say why a profile is out of date, not only that it is.
    // Every reason, one short line each. "Measured before that" only explains the line above it, and a suite
    // change always changes the test items too, so those stay in Details.
    const suiteChanged = model.warnings.some((text) => text.startsWith("The test suite changed"));
    for (const warning of model.warnings.filter((text) => !text.startsWith("Measured before that") && !(suiteChanged && text.startsWith("The tune's test items changed")))) {
      nameCell.appendChild(Object.assign(document.createElement("small"), { className: "tune-stale", textContent: `⚠ ${warning.split(/[;:]/)[0]}`, title: warning }));
    }
    for (const [task, warnings] of Object.entries(model.typeWarnings ?? {})) {
      const text = warnings.map((entry) => `${TYPE_NAMES[entry.type] ?? entry.type} ${entry.right}/${entry.items} vs ${entry.defaultRight}/${entry.items}`).join(", ");
      nameCell.appendChild(Object.assign(document.createElement("small"), {
        className: "tune-stale",
        textContent: `⚠ ${TASK_NAMES[task] ?? task} preset worse on ${text}`,
        title: "The task preset answers these question types significantly worse than the defaults. Run that task's Sampling or Prompt stage, or use the defaults.",
      }));
    }
    row.appendChild(nameCell);
    const device = profile?.device?.settings;
    row.appendChild(tuneCell(device ? (device.gpuBackend === "cpu" ? "CPU" : `${device.gpuBackend} GPU`) : "–", profile?.device?.reason ?? ""));
    const progress = document.createElement("td");
    progress.appendChild(tuneStageChips(profile?.stages, model.staleParts ?? [], { modelId: model.id, running, current: item && running ? item.progress?.stage : null, deviceParts: model.deviceParts ?? [] }));
    // After the device changed, the later stages were measured on the old one: offer to run them again.
    if (model.deviceParts?.length) {
      const rerun = Object.assign(document.createElement("button"), { type: "button", className: "small-btn tune-rerun", textContent: "Re-run Quality → Prompt", disabled: running });
      rerun.title = "These stages were measured on another device than the one this model now uses. Runs them again on the current device and keeps the device result.";
      rerun.dataset.tuneRerun = model.id;
      progress.appendChild(rerun);
    }
    row.appendChild(progress);
    const rated = TUNE_TASKS.filter((task) => Number.isFinite(profile?.tasks?.[task]?.stats?.rate));
    row.appendChild(tuneCell(rated.map((task) => `${TASK_NAMES[task]} ${Number(profile.tasks[task].stats.rate.toFixed(1))}%`).join(" · ") || "–"));
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-btn";
    button.dataset.tuneModel = model.id;
    // An out-of-date profile can only be re-tuned from scratch.
    if (model.warnings.length) button.dataset.tuneForce = "true";
    button.disabled = running;
    const stages = profile?.stages ?? {};
    const complete = ["device", "quality", "speed"].every((stage) => stages[stage] === "done") &&
      TUNE_TASKS.every((task) => stages.sampling?.[task] === "done" && stages.prompt?.[task] === "done");
    button.textContent = model.warnings.length ? "Re-tune ⚠" : complete ? "Tuned ✓" : profile ? "Continue" : "Tune";
    if (model.warnings.length) button.title = `${model.warnings.join("\n")}\nWith only some stages or settings chosen, just those are measured again and the rest is kept.`;
    // A finished tune is skipped unless asked again, so say how.
    else if (complete) button.title = "Fully tuned. Choose some stages or settings above to measure them again, or tick Re-tune from scratch.";
    action.className = "tune-actions-cell";
    if (queueActive) {
      const up = Object.assign(document.createElement("button"), { type: "button", className: "small-btn tune-move", textContent: "↑", title: "Move earlier in the queue" });
      up.dataset.tuneMove = "up";
      up.dataset.tuneId = model.profileId;
      up.disabled = position === 0 || item?.status !== "queued";
      const down = Object.assign(document.createElement("button"), { type: "button", className: "small-btn tune-move", textContent: "↓", title: "Move later in the queue" });
      down.dataset.tuneMove = "down";
      down.dataset.tuneId = model.profileId;
      down.disabled = position === ordered.length - 1 || item?.status !== "queued";
      action.append(up, down);
    }
    action.appendChild(button);
    if (profile) {
      const more = Object.assign(document.createElement("button"), { type: "button", className: "small-btn", textContent: state.tuneOpen.has(model.id) ? "Hide" : "Details" });
      more.dataset.tuneDetails = model.id;
      action.appendChild(more);
    }
    row.appendChild(action);
    if (profile && state.tuneOpen.has(model.id)) {
      const cell = body.insertRow().insertCell();
      cell.className = "tune-details-cell";
      cell.colSpan = 5;
      cell.appendChild(tuneDetails(model));
    }
  }
  els.tuneModels.appendChild(table);
  renderTuneBest(models, repeated);
}

/**
 * The best tuned model per task on this PC. Models are compared only on the current test
 * suite, since rates on other items are not comparable; without one, the older best is
 * shown and marked (ADR-048).
 */
function renderTuneBest(models, repeated) {
  els.tuneBest.replaceChildren();
  const label = (model) => (repeated.has(model.name) ? `${model.name} (${model.fileName})` : model.name);
  const percent = (rate) => `${Number(Number(rate).toFixed(1))}%`;
  const device = (model) => (model.profile?.load?.settings?.gpuBackend ?? "cpu") === "cpu" ? "CPU" : `${model.profile.load.settings.gpuBackend} GPU`;
  const rated = (task) => models
    .filter((model) => Number.isFinite(model.profile?.tasks?.[task]?.stats?.rate))
    .map((model) => ({ model, stats: model.profile.tasks[task].stats, current: !model.stale?.length }))
    .sort((left, right) => Number(right.current) - Number(left.current) || right.stats.rate - left.stats.rate || (right.stats.ci95?.low ?? 0) - (left.stats.ci95?.low ?? 0));
  const rows = TUNE_TASKS.map((task) => [task, rated(task)]).filter(([, entries]) => entries.length);
  if (!rows.length) return;
  els.tuneBest.appendChild(Object.assign(document.createElement("h4"), { textContent: "Best model per task on this PC" }));
  const table = document.createElement("table");
  table.className = "benchmark-table";
  const head = table.createTHead().insertRow();
  for (const text of ["Task", "Best tuned model", "Right answers", "Device", "Next best"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: text }));
  const body = table.createTBody();
  for (const [task, entries] of rows) {
    const [best, next] = entries;
    const range = best.stats.ci95 ? ` (${best.stats.ci95.low}–${best.stats.ci95.high}%)` : "";
    const older = best.current ? "" : " · older test suite";
    body.insertRow().append(
      tuneCell(TASK_NAMES[task]),
      tuneCell(`${label(best.model)}${older}`, best.current ? "" : "No model is tuned on the current test suite for this task yet; re-tune to compare fairly."),
      tuneCell(`${percent(best.stats.rate)}${range}`, "The true rate lies in the range with 95% confidence; overlapping ranges mean the models may be equally good"),
      tuneCell(device(best.model)),
      tuneCell(next && next.current === best.current ? `${label(next.model)} ${percent(next.stats.rate)}` : "–"),
    );
  }
  els.tuneBest.appendChild(table);
}

function renderTuneJob() {
  const job = state.tuneJob;
  const running = job?.status === "running";
  const paused = Boolean(job?.paused) || job?.status === "paused";
  const active = running || paused;
  els.tuneAll.disabled = active;
  els.tuneQuick.disabled = active;
  els.tunePause.disabled = !active;
  els.tunePause.textContent = paused ? "Resume" : "Pause";
  els.tuneCancel.disabled = !active;
  els.tuneRunState.textContent = paused ? "paused" : job ? job.status : "idle";
  els.tuneRunState.className = running ? "badge accent" : job?.status === "complete" ? "badge green" : "badge";
  if (job) {
    const count = (status) => job.items.filter((item) => item.status === status).length;
    const failed = job.items.filter((item) => item.status === "failed").map((item) => `${item.name}: ${item.error}`);
    const guards = job.items.filter((item) => item.guard);
    els.tuneProgress.textContent = `${count("done") + count("skipped")} of ${job.items.length} models finished · ${count("running")} running · ${count("queued")} waiting${paused ? " · paused" : ""}${failed.length ? ` · failed: ${failed.join("; ")}` : ""}${guards.length ? ` · guard stopped: ${guards.map((item) => item.guard.task).join(", ")}` : ""}${job.status === "guarded" ? " · whole queue stopped" : ""}`;
  }
  renderTuneModels();
  renderTuneLive(job);
  renderDashboardTuning();
}

function formatSpan(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "–";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

async function refreshTunePreflight() {
  if (!els.tunePreflight) return;
  const tasks = [...els.tuneTasks.querySelectorAll("input:checked")].map((input) => input.value);
  const stages = [...els.tuneStages.querySelectorAll(".tune-stage input:checked")].map((input) => input.value);
  if (!tasks.length || !stages.length) {
    els.tunePreflight.textContent = "Select at least one task and stage.";
    return;
  }
  try {
    const only = [...els.tuneOnly.querySelectorAll("input:checked")].map((input) => input.value);
    const params = `tasks=${encodeURIComponent(tasks.join(","))}&stages=${encodeURIComponent(stages.join(","))}${only.length ? `&settings=${encodeURIComponent(only.join(","))}` : ""}`;
    const data = await request(`/api/tune/estimate?${params}`);
    const models = data.perModel ?? [];
    const count = data.models === 1 ? "1 model" : `${data.models} models`;
    const fallback = (kind) => (kind === "quick" ? data.quick?.estimate : data.estimate)?.onePassSeconds ?? 0;
    const low = (kind, key) => models.length ? Math.min(...models.map((model) => model[kind][key])) : fallback(kind);
    const high = (kind, key) => models.length ? Math.max(...models.map((model) => model[kind][key])) : fallback(kind);
    const range = (kind) => {
      const first = formatSpan(low(kind, "lowSeconds"));
      const last = formatSpan(high(kind, "highSeconds"));
      return first === last ? first : `${first}–${last}`;
    };
    const measured = models.filter((model) => model.pace).map((model) => model.pace);
    const pace = measured.length
      ? `measured ${Math.min(...measured.map((item) => item.low))}–${Math.max(...measured.map((item) => item.high))} s/answer`
      : "fixed 3 s/answer until a run finishes";
    els.tunePreflight.textContent = `Quick: ${data.quick?.answersPerModel ?? "–"} answers/model · ~${range("quick")}\nFull: ${data.answersPerModel ?? "–"} answers/model · ~${range("full")} · ${count} · ${pace}`;
  } catch {
    els.tunePreflight.textContent = "Could not estimate this run.";
  }
}

async function pauseOrResumeTune() {
  try {
    const route = state.tuneJob?.paused || state.tuneJob?.status === "paused" ? "/api/tune/resume" : "/api/tune/pause";
    const { job } = await request(route, { method: "POST" });
    state.tuneJob = job;
    renderTuneJob();
  } catch (error) {
    showError(error);
  }
}

async function moveTune(profileId, direction) {
  try {
    const { job } = await request("/api/tune/priority", { method: "POST", body: { profileId, direction } });
    state.tuneJob = job;
    renderTuneJob();
  } catch (error) {
    showError(error);
  }
}

/** One running model: its progress, the setting it tries now and what it decided (ADR-055). */
function liveCard(item) {
  const live = item.live ?? {};
  const card = document.createElement("article");
  card.className = "tune-live-card";
  const where = item.progress?.stage ? ` · ${STAGE_NAMES[item.progress.stage] ?? item.progress.stage}${item.progress.task ? ` for ${TASK_NAMES[item.progress.task] ?? item.progress.task}` : ""}${item.progress.axis ? `: ${SETTING_GUIDE[item.progress.axis]?.[1] ?? item.progress.axis}` : ""}` : "";
  card.appendChild(Object.assign(document.createElement("h5"), { textContent: `${item.name}${item.lane ? ` — ${item.lane.toUpperCase()} lane` : ""}${where}` }));
  const bar = Object.assign(document.createElement("progress"), {
    max: live.expectedAnswers || 1,
    value: Math.min(live.answers ?? 0, live.expectedAnswers || 1),
    ariaLabel: "Tune progress",
  });
  const counts = `${live.answers ?? 0}${live.expectedAnswers ? ` of up to ${live.expectedAnswers}` : ""} answers${live.eta ? ` · ${live.eta}` : ""}`;
  card.append(bar, Object.assign(document.createElement("p"), { className: "tune-live-counts", textContent: counts }));
  if (live.axis?.candidates?.length) {
    // Speed settings are judged on time with identical answers; the rest on right answers.
    const speed = live.axis.stage === "speed";
    const best = speed
      ? Math.min(...live.axis.candidates.map((candidate) => candidate.latencyMs ?? Infinity))
      : Math.max(...live.axis.candidates.map((candidate) => candidate.rate ?? -1));
    const table = document.createElement("table");
    table.className = "benchmark-table";
    const head = table.createTHead().insertRow();
    for (const text of [`Trying now: ${SETTING_GUIDE[live.axis.axis]?.[1] ?? live.axis.axis}`, "Questions", "Right answers", "Time", "Tokens"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: text }));
    const body = table.createTBody();
    for (const candidate of live.axis.candidates) {
      const row = body.insertRow();
      if ((speed ? candidate.latencyMs : candidate.rate) === best) row.className = "tune-live-best";
      row.append(tuneCell(patchText(candidate.patch)), tuneCell(String(candidate.rung ?? "–")), tuneCell(`${candidate.rate ?? "–"}%`), tuneCell(candidate.latencyMs === null ? "–" : `${candidate.latencyMs} ms`), tuneCell(candidate.outputTokens === null ? "–" : String(candidate.outputTokens)));
    }
    card.appendChild(table);
  }
  if (live.decisions?.length) {
    card.appendChild(Object.assign(document.createElement("h6"), { textContent: "Decided this run" }));
    const list = document.createElement("ul");
    list.className = "tune-live-decisions";
    for (const decision of [...live.decisions].reverse().slice(0, 8)) {
      const where = `${STAGE_NAMES[decision.stage] ?? decision.stage}${decision.task ? ` (${TASK_NAMES[decision.task] ?? decision.task})` : ""}`;
      const what = `${SETTING_GUIDE[decision.axis]?.[1] ?? decision.axis}: ${patchText(decision.winner)}`;
      const why = decision.kept ?? decision.reason ?? (decision.changed ? "changed" : "kept, nothing did better");
      list.appendChild(Object.assign(document.createElement("li"), { textContent: `${where} · ${what} — ${why}` }));
    }
    card.appendChild(list);
  }
  return card;
}

const BENCH_TAB_KEY = "modelduck.benchTab";
const BENCH_NARROW = typeof matchMedia === "function" ? matchMedia("(max-width: 980px)") : null;

/** The rail is vertical on wide screens and horizontal once the shell stacks. */
function syncBenchOrientation() {
  els.benchTabs?.setAttribute("aria-orientation", BENCH_NARROW?.matches ? "horizontal" : "vertical");
}

/** The Bench dialog's tab that is showing. */
function benchTab() {
  return els.benchTabs.querySelector('[aria-selected="true"]')?.dataset.benchTab ?? "tune";
}

function savedBenchTab() {
  try {
    return localStorage.getItem(BENCH_TAB_KEY) || "tune";
  } catch {
    return "tune";
  }
}

/** Show one tab of the Bench dialog and remember it; the run list loads when its tab opens. */
function showBenchTab(name) {
  const tabs = [...els.benchTabs.querySelectorAll("[data-bench-tab]")];
  const chosen = tabs.some((tab) => tab.dataset.benchTab === name) ? name : "tune";
  for (const tab of tabs) {
    const active = tab.dataset.benchTab === chosen;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("[data-bench-panel]")) panel.hidden = panel.dataset.benchPanel !== chosen;
  try {
    localStorage.setItem(BENCH_TAB_KEY, chosen);
  } catch {
    // A private window keeps the tab for this visit only.
  }
  if (chosen === "runs") void loadTuneRuns();
  if (chosen === "suite") void loadBenchSuite();
}

function renderTuneLive(job) {
  const running = job?.status === "running";
  els.benchTabDot.hidden = !running;
  els.tuneLive.hidden = !running;
  if (!running) return;
  els.tuneLive.replaceChildren(Object.assign(document.createElement("h4"), { textContent: "Running now" }));
  for (const item of job.items.filter((entry) => entry.status === "running")) els.tuneLive.appendChild(liveCard(item));
  const others = job.items.filter((entry) => entry.status !== "running");
  if (others.length) {
    els.tuneLive.appendChild(Object.assign(document.createElement("h6"), { textContent: "Queue" }));
    const list = document.createElement("ul");
    list.className = "tune-live-queue";
    for (const item of others) list.appendChild(Object.assign(document.createElement("li"), { textContent: `${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}` }));
    els.tuneLive.appendChild(list);
  }
}

/** One job update, from the stream or a poll: show it, and refresh everything once the tune ends. */
async function onTuneJob(job) {
  state.tuneJob = job ?? null;
  if (job?.status === "running") {
    renderTuneJob();
    return;
  }
  stopTuneLive();
  await loadTuneOverview();
  if (job?.status === "complete") showToast("Tuning finished", { message: "Tuned settings apply the next time each model loads.", kind: "success" });
}

/** Follow a running tune as it changes; polling every two seconds when the stream is not available. */
function startTuneLive() {
  if (state.tuneStream || state.tuneTimer) return;
  if (typeof EventSource !== "function") {
    startTunePolling();
    return;
  }
  const stream = new EventSource("/api/tune/stream");
  state.tuneStream = stream;
  stream.addEventListener("message", (event) => {
    try {
      void onTuneJob(JSON.parse(event.data).job);
    } catch (error) {
      showError(error);
    }
  });
  stream.addEventListener("error", () => {
    // A LAN browser cannot send its key on a stream; polling carries it.
    stopTuneLive();
    if (els.benchmarkDialog.open) startTunePolling();
  });
}

function stopTuneLive() {
  state.tuneStream?.close();
  state.tuneStream = null;
  stopTunePolling();
}

function stopTunePolling() {
  clearInterval(state.tuneTimer);
  state.tuneTimer = null;
}

function startTunePolling() {
  if (!state.tuneTimer) state.tuneTimer = setInterval(() => void pollTune(), 2000);
}

async function loadTuneOverview() {
  const [overview, status] = await Promise.all([request("/api/tune/overview"), request("/api/tune/status").catch(() => ({ job: null }))]);
  state.tuneOverview = overview.models ?? [];
  // A finished tune adds a run and may leave work to continue.
  void loadTuneRuns();
  // A finished tune changes the sweep logs; reload those whose details are open.
  state.tuneSweeps.clear();
  for (const model of state.tuneOverview.filter((item) => state.tuneOpen.has(item.id) && item.profile)) void loadTuneSweeps(model);
  state.tuneJob = status.job ?? null;
  renderTuneJob();
  renderDashboardTuning();
  void loadRecommendations();
  if (state.tuneJob?.status === "running") startTuneLive();
}

/** What to run on this PC: measured models first, catalog estimates after (ADR-069). */
async function loadRecommendations() {
  try {
    const data = await request("/api/recommendations?task=code");
    const box = els.tuneRecommend;
    const title = Object.assign(document.createElement("h3"), { textContent: "Recommended for this PC" });
    const note = Object.assign(document.createElement("p"), {
      className: "benchmark-progress",
      textContent: `Free memory ${(data.memory.free / 1024 ** 3).toFixed(1)} GiB. Measured models are ranked by right answers on code, then speed; catalog entries are estimates until downloaded and tuned.`,
    });
    const table = document.createElement("table");
    table.className = "benchmark-table";
    const head = table.createTHead().insertRow();
    for (const label of ["Model", "On code", "Speed", "Memory", "Fit"]) head.appendChild(Object.assign(document.createElement("th"), { textContent: label }));
    const body = table.createTBody();
    for (const row of data.installed) {
      body.insertRow().append(
        tuneCell(row.name, row.fileName),
        tuneCell(Number.isFinite(row.rate) ? `${row.rate}%` : "not tuned"),
        tuneCell(Number.isFinite(row.tokensPerSecond) ? `${row.tokensPerSecond} tok/s` : "–"),
        tuneCell(`${(row.memoryBytes / 1024 ** 3).toFixed(1)} GiB`, `at ${row.contextSize} context`),
        tuneCell(row.fit, row.why),
      );
    }
    for (const row of data.catalog) {
      body.insertRow().append(
        tuneCell(`${row.name} (not installed)`, row.id),
        tuneCell("–"),
        tuneCell("–"),
        tuneCell(`${(row.totalBytes / 1024 ** 3).toFixed(1)} GiB`, "weights and runtime; the KV cache adds more"),
        tuneCell("fits (estimated)", `Download ${row.params ?? ""} ${row.quant ?? ""} and tune it to measure speed.`.trim()),
      );
    }
    box.replaceChildren(title, note, table);
  } catch (error) {
    els.tuneRecommend.replaceChildren();
  }
}

async function pollTune() {
  if (!els.benchmarkDialog.open) {
    stopTunePolling();
    return;
  }
  // A slow status call must not stack a second request behind it.
  if (state.tunePolling) return;
  state.tunePolling = true;
  try {
    const { job } = await request("/api/tune/status", { signal: AbortSignal.timeout(10_000) });
    await onTuneJob(job);
  } catch (error) {
    stopTunePolling();
    showError(error);
  } finally {
    state.tunePolling = false;
  }
}

/** Minutes per model from the Tune form, or null when the field is empty or not a positive number. */
function tuneBudget() {
  const minutes = Number(els.tuneBudget?.value);
  return els.tuneBudget?.value && Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

async function startTune(models, { force = false, forceStale = false, stage = null, tasks = null, only = null, continueRun = false, quick = false, useForm = true } = {}) {
  // A stage button (one stage) or the re-run button (several) runs just those, whatever the boxes above say.
  const settings = only ?? (useForm && !stage ? [...els.tuneOnly.querySelectorAll("input:checked")].map((input) => input.value) : []);
  const all = [...els.tuneStages.querySelectorAll(".tune-stage input[value]")].map((input) => input.value);
  // Chosen settings run wherever they belong, so they override the stage boxes.
  const stages = stage ? [].concat(stage) : settings.length ? all : useForm ? [...els.tuneStages.querySelectorAll(".tune-stage input[value]:checked")].map((input) => input.value) : all;
  const selectedTasks = useForm ? [...els.tuneTasks.querySelectorAll("input:checked")].map((input) => input.value) : TUNE_TASKS;
  if (!selectedTasks.length) {
    showToast("Choose at least one task", { kind: "error" });
    return;
  }
  const taskList = tasks ?? (selectedTasks.length === TUNE_TASKS.length ? null : selectedTasks);
  if (!stages.length) {
    showToast("Choose at least one stage", { kind: "error" });
    return;
  }
  // A part run measures its parts again on top of the saved rest; only a whole tune starts a stale profile over (ADR-040).
  // A task subset is a part run too: scratch on a subset would save a profile without the other tasks.
  const partRun = settings.length > 0 || stages.length < all.length || (taskList && taskList.length < TUNE_TASKS.length);
  try {
    const { job } = await request("/api/tune/start", { method: "POST", body: { models, ...(taskList && { tasks: taskList }), ...(continueRun && { continue: true }), stages, settings: settings.length ? settings : null, force: !continueRun && (useForm ? ((force && !partRun) || (!stage && els.tuneForce.checked)) : force), forceStale, quick: Boolean(quick), guard: useForm ? Boolean(els.tuneGuard?.checked) : false, guardQueue: useForm ? Boolean(els.tuneGuardQueue?.checked) : false, ...(useForm && tuneBudget() && { budgetMinutes: tuneBudget() }) } });
    state.tuneJob = job;
    // A started tune is followed on the Tune tab.
    showBenchTab("tune");
    renderTuneJob();
    startTuneLive();
    if (useForm && els.tuneBackground?.checked) {
      els.benchmarkDialog.close();
      showToast("Tune running in background", { message: "Reopen Bench & Tune to follow it.", kind: "success" });
    } else if (quick) {
      showToast("Quick pass started", { message: "The provisional preset appears as soon as the first rung finishes.", kind: "success" });
    }
  } catch (error) {
    showError(error);
  }
}

async function cancelTune() {
  try {
    const { job } = await request("/api/tune/cancel", { method: "POST" });
    state.tuneJob = job;
    renderTuneJob();
  } catch (error) {
    showError(error);
  }
}

// Every editable tune setting: [path in the steps object, label, kind].
const TUNE_STEP_FIELDS = [
  ["Stage 0 · device", [["device.backends", "Devices to probe (cpu is always the reference)"]]],
  ["Lanes on this PC", [["lanes.cpu", "CPU lanes (1-4)", "number"], ["lanes.gpu", "GPU lanes (0-4; 0 = GPU models wait for the CPU lane)", "number"]]],
  ["Stage 1 · quality", [["load.kvCache", "KV cache types"]]],
  ["Stage 2 · speed", [
    ["load.flashAttention", "Flash attention"], ["load.useMmap", "mmap"], ["load.batchSize", "Batch sizes"],
    ["load.threads", "Threads (capped at three quarters of this PC's threads)"],
    ["load.checkpointing.enabled", "Tune checkpointing (hybrid or sliding-window models only)", "checkbox"],
    ["load.checkpointing.interval", "Checkpoint intervals"], ["load.checkpointing.max", "Checkpoints kept"],
  ]],
  ["Stage 3 · sampling, per task", [
    ["sampling.temperature", "Temperature"], ["sampling.maxTokens.code", "Token budgets · code"],
    ["sampling.maxTokens.comprehension", "Token budgets · comprehension"],
    ["sampling.maxTokens.recall", "Token budgets · long context"], ["sampling.repeatPenalty", "Repeat penalty"],
    ["sampling.minP", "Min-p"], ["sampling.topP", "Top-p"], ["sampling.topK", "Top-k (0 = off)"],
  ]],
  ["Stage 4 · prompt, per task", [
    ["prompt.systemPrompt", "System prompts, one per line (the first is the reference)", "lines"],
    ["prompt.reasoning", "Reasoning"], ["prompt.promptRepeat", "Prompt repeats"],
  ]],
];

const stepAt = (steps, key) => key.split(".").reduce((value, part) => value?.[part], steps);

function setStep(steps, key, value) {
  const parts = key.split(".");
  const last = parts.pop();
  const parent = parts.reduce((object, part) => (object[part] ??= {}), steps);
  parent[last] = value;
}

function parseStepText(text) {
  return String(text).split(/[\s,]+/).filter(Boolean).map((part) => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : part));
}

function renderTuneSettings(steps) {
  els.tuneSettingsForm.replaceChildren();
  for (const [title, fields] of TUNE_STEP_FIELDS) {
    const group = document.createElement("fieldset");
    group.className = "tune-settings-group";
    group.appendChild(Object.assign(document.createElement("legend"), { textContent: title }));
    for (const [key, label, kind = "list"] of fields) {
      const field = document.createElement("label");
      field.className = kind === "checkbox" ? "check" : "field";
      const value = stepAt(steps, key);
      let input;
      if (kind === "lines") {
        input = Object.assign(document.createElement("textarea"), { rows: 6, wrap: "off", value: (value ?? []).join("\n") });
      } else {
        input = Object.assign(document.createElement("input"), { type: kind === "list" ? "text" : kind });
        if (kind === "checkbox") input.checked = Boolean(value);
        else input.value = Array.isArray(value) ? value.join(", ") : value ?? "";
      }
      input.dataset.stepKey = key;
      input.dataset.stepKind = kind;
      const caption = Object.assign(document.createElement("span"), { textContent: label });
      if (kind === "checkbox") field.append(input, caption);
      else field.append(caption, input);
      if (TUNE_STEP_HELP[key]) caption.appendChild(helpButton(label, TUNE_STEP_HELP[key]));
      group.appendChild(field);
    }
    els.tuneSettingsForm.appendChild(group);
  }
}

function readTuneSettings() {
  const steps = {};
  for (const input of els.tuneSettingsForm.querySelectorAll("[data-step-key]")) {
    const kind = input.dataset.stepKind;
    const value = kind === "checkbox" ? input.checked
      : kind === "number" ? Number(input.value)
      : kind === "lines" ? input.value.split("\n").map((line) => line.trim()).filter(Boolean)
      : parseStepText(input.value);
    setStep(steps, input.dataset.stepKey, value);
  }
  return steps;
}

function describeTuneEstimate(data) {
  const estimate = data.estimate;
  const perTask = (entries) => Math.max(0, ...Object.values(entries ?? {}).map((entry) => entry.configs));
  const hours = (seconds) => (seconds / 3600).toFixed(1);
  const problems = data.problems?.length ? ` Dropped: ${data.problems.join("; ")}.` : "";
  return `Per pass: device ${estimate.device.configs} · quality ${estimate.quality.configs} · speed ${estimate.speed.configs} · sampling ${perTask(estimate.sampling)} and prompt ${perTask(estimate.prompt)} per task. ` +
    `At about 3 s per answer (a small model on the CPU) one pass is up to ${hours(estimate.onePassSeconds)} h; GPU models are several times faster.${problems}`;
}

function renderTuneOnly(names) {
  if (els.tuneOnly.querySelector("input")) return;
  // Grouped by the stage each setting belongs to, with what it changes.
  for (const stage of Object.keys(STAGE_NAMES)) {
    const group = Object.assign(document.createElement("fieldset"), { className: "tune-only-group" });
    group.appendChild(Object.assign(document.createElement("legend"), { textContent: STAGE_NAMES[stage] }));
    for (const name of names.filter((item) => (SETTING_GUIDE[item]?.[0] ?? "speed") === stage)) {
      const option = Object.assign(document.createElement("label"), { className: "check", title: SETTING_GUIDE[name]?.[2] ?? name });
      const box = Object.assign(document.createElement("input"), { type: "checkbox", value: name });
      const caption = Object.assign(document.createElement("span"), { textContent: SETTING_GUIDE[name]?.[1] ?? name });
      caption.appendChild(helpButton(SETTING_GUIDE[name]?.[1] ?? name, SETTING_GUIDE[name]?.[2] ?? name));
      option.append(box, caption);
      group.appendChild(option);
    }
    if (group.querySelector("input")) els.tuneOnly.appendChild(group);
  }
}

async function loadTuneSettings() {
  const data = await request("/api/tune/steps");
  renderTuneOnly(data.settingNames ?? []);
  state.tuneDefaults = data.defaults;
  renderTuneSettings(data.steps);
  els.tuneSettingsNote.textContent = `${data.custom ? "Your saved settings." : "Built-in defaults."} ${describeTuneEstimate(data)}`;
}

async function saveTuneSettings(steps) {
  if (!els.tuneSettingsForm.querySelector("[data-step-key]")) {
    showToast("Tune settings are not loaded", { message: "Reopen Bench & Tune, then try again.", kind: "error" });
    return;
  }
  try {
    const data = await request("/api/tune/steps", { method: "PUT", body: { steps } });
    renderTuneSettings(data.steps);
    els.tuneSettingsNote.textContent = `Saved. ${describeTuneEstimate(data)}`;
    showToast("Tune settings saved", { message: "The next tune uses them.", kind: data.problems?.length ? "info" : "success" });
  } catch (error) {
    showError(error);
  }
}

async function openBenchmarks() {
  if (!els.benchmarkDialog.open) els.benchmarkDialog.showModal();
  els.benchmarkPhases.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "benchmark-empty";
  loading.textContent = "Loading benchmark report…";
  els.benchmarkPhases.appendChild(loading);
  try {
    const [report, status] = await Promise.all([
      request("/api/benchmarks"),
      request("/api/benchmarks/status").catch(() => ({ job: null })),
    ]);
    renderBenchmarkReport(report);
    state.chatBase = report.chatBase ?? state.chatBase;
    renderChatBase(state.chatBase);
    renderRecommendations(report.recommendations, report.recommendationsTitle);
    state.benchmarkJob = status.job ?? null;
    renderBenchmarkJob(status.job ?? null);
    await loadTuneOverview().catch(showError);
    await loadTuneSettings().catch(showError);
  } catch (error) {
    els.benchmarkPhases.replaceChildren();
    const failed = document.createElement("p");
    failed.className = "benchmark-empty";
    failed.textContent = "The benchmark report could not be loaded.";
    els.benchmarkPhases.appendChild(failed);
    showError(error);
  }
}

async function saveServerSettings(event) {
  event.preventDefault();
  const payload = {
    port: Number(els.serverPort.value),
    requireAuth: els.serverAuth.checked,
    serveOnLocalNetwork: els.serverLan.checked,
    allowPerRequestMcps: els.serverMcpRequest.checked,
    allowCallingServersFromMcpJson: els.serverMcpJson.checked,
    enableCors: els.serverCors.checked,
    justInTimeModelLoading: els.serverJit.checked,
    autoUnloadUnusedJit: els.serverJitAuto.checked,
    maxIdleTtlMinutes: Number(els.serverTtl.value),
    onlyKeepLastJitLoadedModel: els.serverJitLast.checked,
  };
  try {
    const data = await request("/api/server-settings", { method: "PUT", body: { settings: payload } });
    state.serverSettings = { ...data.settings, apiKeys: data.apiKeys, activeKeys: data.activeKeys };
    state.restartRequired = Boolean(data.restartRequired);
    renderDashboard();
    els.serverDialog.close();
    showToast("Server settings saved", {
      message: state.restartRequired ? "The listener change applies after a restart." : "The changes apply now.",
    });
    renderServerRestart();
  } catch (error) {
    showError(error);
  }
}

async function createServerKey() {
  const label = els.serverKeyLabel.value.trim() || "API key";
  els.serverKeyCreate.disabled = true;
  try {
    const data = await request("/api/server-settings/api-keys", {
      method: "POST",
      body: { label },
    });
    els.serverKeyValue.textContent = data.key;
    els.serverKeyOutput.hidden = false;
    els.serverKeyLabel.value = "";
    // Refresh the key list without clearing the key the toast says to copy now.
    await openServerSettings({ keepKey: true });
    showToast("API key created", {
      message: "Copy it now; the full key is not shown again.",
      fix: "Use Authorization: Bearer <key> or X-API-Key.",
    });
  } catch (error) {
    showError(error);
  } finally {
    els.serverKeyCreate.disabled = false;
  }
}

async function revokeServerKey(key) {
  const confirmed = await askConfirm(
    "Revoke this API key?",
    `${key.label} (${key.prefix}…) will stop working immediately.`,
    "Revoke key",
  );
  if (!confirmed) return;
  try {
    await request(`/api/server-settings/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    await openServerSettings();
    showToast("API key revoked");
  } catch (error) {
    showError(error);
  }
}

function updateSettingsOutputs() {
  els.tempOut.textContent = Number(els.settingTemp.value).toFixed(2);
  els.toppOut.textContent = Number(els.settingTopp.value).toFixed(2);
}

async function saveSettings(event) {
  event.preventDefault();
  const payload = {
    systemPrompt: els.settingSystem.value,
    useTunedProfile: els.settingTuned.checked,
    speedPreset: els.settingSpeedPreset.value,
    temperature: Number(els.settingTemp.value),
    topP: Number(els.settingTopp.value),
    topK: Number(els.settingTopk.value),
    minP: Number(els.settingMinp.value),
    repeatPenalty: Number(els.settingRepeat.value),
    reasoning: els.settingReasoning.value,
    contextOverflow: els.settingOverflow.value,
    structuredOutput: els.settingStructured.value,
    jsonSchema: els.settingSchema.value,
    promptRepeat: Number(els.settingRepeatPrompt.value),
    maxTokens: Number(els.settingMax.value), // aikit:allow-secret token limit
    contextSize: Number(els.settingContext.value),
    threads: Number(els.settingThreads.value),
    maxThreads: Number(els.settingMaxThreads.value),
    batchSize: Number(els.settingBatch.value),
    sequences: Number(els.settingSequences.value),
    flashAttention: els.settingFlash.value,
    useMmap: els.settingMmap.value,
    gpuLayers: Number(els.settingGpuLayers.value),
    gpuBackend: els.settingGpuBackend.value,
    checkpoints: els.settingCheckpoints.value === "true",
    checkpointInterval: Number(els.settingCheckpointInterval.value),
    checkpointMax: Number(els.settingCheckpointMax.value),
    kvCache: els.settingKv.value,
  };
  const previous = state.settings;
  try {
    const data = await request("/api/settings", { method: "PUT", body: { settings: payload } });
    state.settings = data.settings;
    setSettingsDirty(false);
    els.settingsDialog.close();
    showToast("Settings saved");
    if (
      state.loaded.status === "ready" &&
      previous &&
      (previous.contextSize !== data.settings.contextSize ||
        previous.threads !== data.settings.threads ||
        previous.maxThreads !== data.settings.maxThreads ||
        previous.kvCache !== data.settings.kvCache ||
        previous.batchSize !== data.settings.batchSize ||
        previous.sequences !== data.settings.sequences ||
        previous.flashAttention !== data.settings.flashAttention ||
        previous.useMmap !== data.settings.useMmap ||
        previous.checkpoints !== data.settings.checkpoints ||
        previous.checkpointInterval !== data.settings.checkpointInterval ||
        previous.checkpointMax !== data.settings.checkpointMax ||
        previous.gpuBackend !== data.settings.gpuBackend ||
        previous.gpuLayers !== data.settings.gpuLayers)
    ) {
      showToast("Reload to apply", {
        message: "Context, threads, GPU backend, batching, attention, mmap, checkpoints and KV cache change the next time a model is loaded.",
        fix: "Open Models → Installed → Load.",
      });
    }
  } catch (error) {
    showError(error);
  }
}

/* Confirm ------------------------------------------------------------------ */

let confirmQueue = Promise.resolve();

function showConfirm(title, message, confirmLabel) {
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;
  els.confirmOk.textContent = confirmLabel;
  if (!els.confirmDialog.open) els.confirmDialog.showModal();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      els.confirmDialog.close();
      resolve(value);
    };
    els.confirmOk.onclick = () => finish(true);
    els.confirmCancel.onclick = () => finish(false);
    els.confirmDialog.onclose = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
  });
}

/**
 * One confirm at a time. Two callers used to overwrite each other's handlers,
 * so the first promise could resolve on the second dialog's button.
 */
function askConfirm(title, message, confirmLabel = "Delete") {
  const next = confirmQueue.then(() => showConfirm(title, message, confirmLabel));
  confirmQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/* Clipboard ---------------------------------------------------------------- */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

/* Events ------------------------------------------------------------------- */

function bindArrowTabs(container, selector, activate) {
  if (!container) return;
  container.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const tabs = [...container.querySelectorAll(selector)];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (forward ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    activate(tabs[next]);
  });
}

function bindEvents() {
  $("open-models").addEventListener("click", () => openModels("installed"));
  els.heroModels.addEventListener("click", () => openModels("installed"));
  els.heroBench.addEventListener("click", openBenchmarks);
  els.mastheadServer.addEventListener("click", openServerSettings);
  $("status-card").addEventListener("click", () => openModels("installed"));
  $("open-settings").addEventListener("click", openSettings);
  $("open-server").addEventListener("click", openServerSettings);
  $("open-benchmarks").addEventListener("click", openBenchmarks);
  els.navOverview.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  els.dashboardCopyApi.addEventListener("click", async () => {
    if (await copyText(`${location.origin}/v1`)) showToast("API URL copied");
  });
  els.dashboard.addEventListener("click", (event) => {
    const load = event.target.closest("[data-dashboard-load]");
    if (load) {
      void loadModel(load.dataset.dashboardLoad);
      return;
    }
    if (event.target.closest("[data-dashboard-unload]")) {
      void unloadModel();
      return;
    }
    const tune = event.target.closest("[data-dashboard-tune]");
    if (tune) {
      const model = state.models.find((item) => item.id === tune.dataset.dashboardTune);
      void (async () => {
        const confirmed = await askConfirm(
          "Start a full tune?",
          `Tuning ${model?.name ?? "this model"} measures device, quality, speed, sampling and prompts for every task and can run for a long time. Start it now?`,
          "Start tune",
        );
        if (!confirmed) return;
        await openBenchmarks();
        await startTune([tune.dataset.dashboardTune], { forceStale: true, useForm: false });
      })();
      return;
    }
    if (event.target.closest("[data-dashboard-open-models]")) {
      openModels("installed");
      return;
    }
    if (event.target.closest("[data-dashboard-open-bench]")) openBenchmarks();
  });
  bindArrowTabs(document.querySelector(".tabs"), ".tab", (tab) => switchTab(tab.dataset.tab));
  bindArrowTabs(els.benchTabs, "[data-bench-tab]", (tab) => showBenchTab(tab.dataset.benchTab));
  els.benchmarkStart.addEventListener("click", startBenchmark);
  els.benchmarkCancel.addEventListener("click", cancelBenchmark);
  els.benchmarkPhase.addEventListener("change", syncBenchmarkPhase);
  syncBenchmarkPhase();
  $("tune-presets-details")?.addEventListener("toggle", (event) => {
    if (event.target.open) void loadShippedPresets();
  });
  const tuneImport = $("tune-import-profile");
  tuneImport?.addEventListener("change", () => {
    const file = tuneImport.files?.[0];
    if (file) void importProfile(file);
    tuneImport.value = "";
  });
  els.tuneAll.addEventListener("click", () => void startTune("all", { forceStale: true }));
  els.tuneQuick.addEventListener("click", () => void startTune("all", { quick: true, forceStale: true }));
  els.tunePause.addEventListener("click", pauseOrResumeTune);
  els.tuneStages.addEventListener("change", () => { void refreshTunePreflight(); });
  els.tuneTasks.addEventListener("change", () => { void refreshTunePreflight(); });
  els.tuneOnly.addEventListener("change", () => { void refreshTunePreflight(); });
  els.tuneCancel.addEventListener("click", cancelTune);
  els.tuneSettingsSave.addEventListener("click", () => void saveTuneSettings(readTuneSettings()));
  els.tuneSettingsReset.addEventListener("click", () => {
    if (state.tuneDefaults) void saveTuneSettings(state.tuneDefaults);
  });
  els.benchmarkShowOld.addEventListener("change", () => {
    if (state.benchmarkReport) renderBenchmarkReport(state.benchmarkReport);
    if (state.benchmarkAdvice) renderRecommendations(state.benchmarkAdvice.advice, state.benchmarkAdvice.headerTitle);
  });
  els.benchTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-bench-tab]");
    if (tab) showBenchTab(tab.dataset.benchTab);
  });
  showBenchTab(savedBenchTab());
  syncBenchOrientation();
  BENCH_NARROW?.addEventListener("change", syncBenchOrientation);
  markSettingHelp();
  void refreshTunePreflight();
  document.addEventListener("click", (event) => {
    if (helpAnchor && !event.target.closest(".field-help") && !event.target.closest("#field-help-popover")) hideHelp();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && helpAnchor) hideHelp();
  });
  window.addEventListener("resize", hideHelp);
  window.addEventListener("scroll", hideHelp, true);
  els.tuneRunsList.addEventListener("click", (event) => {
    const resume = event.target.closest("[data-tune-continue]");
    if (resume) {
      void continueTuneRun(resume.dataset.tuneContinue);
      return;
    }
    const button = event.target.closest("[data-tune-run]");
    if (button) void openTuneRun(button.dataset.tuneRun);
  });
  els.tuneContinue.addEventListener("click", (event) => {
    const resume = event.target.closest("[data-tune-continue]");
    if (resume) void continueTuneRun(resume.dataset.tuneContinue);
  });
  els.tuneModels.addEventListener("click", (event) => {
    const exportProfileButton = event.target.closest("[data-profile-export]");
    if (exportProfileButton) {
      void exportProfile(exportProfileButton.dataset.profileExport);
      return;
    }
    const details = event.target.closest("[data-tune-details]");
    if (details) {
      const id = details.dataset.tuneDetails;
      if (!state.tuneOpen.delete(id)) state.tuneOpen.add(id);
      renderTuneModels();
      const model = (state.tuneOverview ?? []).find((item) => item.id === id);
      if (model && state.tuneOpen.has(id) && !state.tuneSweeps.has(model.profileId)) void loadTuneSweeps(model);
      return;
    }
    const taskStage = event.target.closest("[data-tune-task-stage]");
    if (taskStage) {
      void startTune([taskStage.dataset.tuneTaskModel], { stage: taskStage.dataset.tuneTaskStage, tasks: [taskStage.dataset.tuneTask] });
      return;
    }
    const move = event.target.closest("[data-tune-move]");
    if (move) {
      void moveTune(move.dataset.tuneId, move.dataset.tuneMove);
      return;
    }
    const rerun = event.target.closest("[data-tune-rerun]");
    if (rerun) {
      void startTune([rerun.dataset.tuneRerun], { stage: ["quality", "speed", "sampling", "prompt"] });
      return;
    }
    const stageButton = event.target.closest("[data-tune-stage]");
    if (stageButton) {
      void startTune([stageButton.dataset.tuneStageModel], { stage: stageButton.dataset.tuneStage });
      return;
    }
    const button = event.target.closest("[data-tune-model]");
    if (button) void startTune([button.dataset.tuneModel], { force: button.dataset.tuneForce === "true" });
  });
  els.benchmarkDialog.addEventListener("close", stopBenchmarkPolling);
  els.benchmarkDialog.addEventListener("close", stopTuneLive);
  $("theme-toggle").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.closeDialog);
      if (!dialog) return;
      // The settings form owns an unsaved state; closing it goes through the guard.
      if (dialog === els.settingsDialog) void closeSettings();
      else dialog.close();
    });
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  els.modelsDialog.addEventListener("click", (event) => {
    const download = event.target.closest("[data-download]");
    if (download) {
      if (!download.disabled) startDownload(download.dataset.download, download);
      return;
    }
    const cancel = event.target.closest("[data-cancel-download]");
    if (cancel) {
      cancelDownload(cancel.dataset.cancelDownload);
      return;
    }
    const load = event.target.closest("[data-load]");
    if (load) {
      loadModel(load.dataset.load);
      return;
    }
    const unload = event.target.closest("[data-unload]");
    if (unload) {
      unloadModel();
      return;
    }
    const remove = event.target.closest("[data-delete-model]");
    if (remove) {
      deleteModel(remove.dataset.deleteModel);
      return;
    }
    if (event.target.closest("[data-open-discover]")) {
      switchTab("discover");
      return;
    }
    if (event.target.closest("[data-refresh-models]")) {
      refreshModels();
      refreshCatalog();
    }
  });

  els.modelsDialog.addEventListener("close", () => {
    if (!hasActiveDownloads()) stopDownloadPolling();
  });

  $("open-folder").addEventListener("click", openModelsFolder);
  $("refresh-models").addEventListener("click", () => {
    refreshModels();
    refreshCatalog();
  });
  els.importBtn.addEventListener("click", importModel);
  els.importPath.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      importModel();
    }
  });

  els.settingsForm.addEventListener("submit", saveSettings);
  els.settingTemp.addEventListener("input", updateSettingsOutputs);
  els.settingTopp.addEventListener("input", updateSettingsOutputs);

  els.serverForm.addEventListener("submit", saveServerSettings);
  $("server-settings-retry")?.addEventListener("click", () => void openServerSettings());
  els.serverKeyCreate.addEventListener("click", createServerKey);
  els.serverKeyOutput.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-copy-key]")) return;
    if (await copyText(els.serverKeyValue.textContent || "")) showToast("API key copied");
  });

  document.addEventListener("keydown", (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key === ",") {
      event.preventDefault();
      openSettings();
    }
  });

  els.modelsDialog.addEventListener("click", (event) => {
    if (event.target === els.modelsDialog) els.modelsDialog.close();
  });
  els.settingsDialog.addEventListener("click", (event) => {
    if (event.target === els.settingsDialog) void closeSettings();
  });
  els.settingsDialog.addEventListener("cancel", (event) => {
    if (!state.settingsDirty) return;
    event.preventDefault();
    void closeSettings();
  });
  els.settingsForm.addEventListener("input", () => setSettingsDirty(true));
  els.settingsForm.addEventListener("change", () => setSettingsDirty(true));
  els.serverAuth.addEventListener("change", syncServerExposure);
  els.serverDialog.addEventListener("close", clearServerKeyReveal);
  els.serverDialog.addEventListener("click", (event) => {
    if (event.target === els.serverDialog) els.serverDialog.close();
  });
}

/* Boot --------------------------------------------------------------------- */

async function boot() {
  applyTheme();
  bindEvents();

  try {
    const data = await request("/api/state");
    state.app = data.app;
    state.settings = data.settings;
    state.modelsDir = data.modelsDir;
    state.models = data.models ?? [];
    state.catalog = data.catalog ?? [];
    state.downloads = data.downloads ?? [];
    state.presets = data.presets ?? [];
    state.serverSettings = data.serverSettings ?? null;
    state.restartRequired = data.restartRequired ?? null;
    state.loaded = data.loaded ?? { status: "idle", model: null };
  } catch (error) {
    showError(error);
    state.loaded = { status: "idle", model: null };
  }

  document.body.classList.add("ready");
  renderHeader();
  renderStatus();
  renderCatalog();
  renderInstalled();
  switchTab("discover");
  void refreshDashboardTuning();
  if (hasActiveDownloads()) startDownloadPolling();
}

boot();
