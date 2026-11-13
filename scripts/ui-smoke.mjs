import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeout = 15_000, interval = 100) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      if (await check()) return true;
    } catch {
      // Keep waiting while the server or browser starts.
    }
    await delay(interval);
  }
  return false;
}

function browserCandidates() {
  if (process.platform === "win32") {
    return [
      process.env["ProgramFiles(x86)"] &&
        path.join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.ProgramFiles &&
        path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      process.env.ProgramFiles &&
        path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

async function main() {
  const allowSkip = process.argv.includes("--allow-skip");
  if (typeof WebSocket !== "function") {
    console.log("[ui-smoke] skipped: Node 22+ is needed for the built-in WebSocket; pass --allow-skip to accept");
    if (!allowSkip) process.exitCode = 1;
    return;
  }

  const { existsSync } = await import("node:fs");
  const browserPath = browserCandidates().find((candidate) => existsSync(candidate));
  if (!browserPath) {
    console.log("[ui-smoke] skipped: no Edge or Chrome found; pass --allow-skip to accept");
    if (!allowSkip) process.exitCode = 1;
    return;
  }

  const home = await mkdtemp(path.join(os.tmpdir(), "modelduck-ui-"));
  const port = await freePort();
  const cdpPort = await freePort();
  const profile = path.join(home, "browser-profile");
  await mkdir(profile, { recursive: true });
  let server = null;
  let browser = null;
  let ws = null;

  try {
    const logs = [];
    server = spawn(
      process.execPath,
      ["src/main.js", "--port", String(port), "--home", home, "--no-open"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout.on("data", (chunk) => logs.push(String(chunk)));
    server.stderr.on("data", (chunk) => logs.push(String(chunk)));

    const healthy = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok;
    });
    if (!healthy) throw new Error(`ModelDuck did not start:\n${logs.join("")}`);

    const fixtureState = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    const fixtureModel = {
      id: "fixture-model",
      name: "Fixture model",
      fileName: "fixture.gguf",
      size: 1024,
      params: null,
      quant: null,
      blocked: false,
      unreadable: false,
    };
    fixtureState.models = [fixtureModel];
    fixtureState.loaded = { status: "idle", model: null };
    const fixtureOverview = {
      models: [{
        id: fixtureModel.id,
        name: fixtureModel.name,
        fileName: fixtureModel.fileName,
        profileId: fixtureModel.id,
        profile: {
          createdAt: "2026-11-01T00:00:00.000Z",
          tasks: { code: { stats: { rate: 81.2 } }, comprehension: { stats: { rate: 74 } }, recall: { stats: { rate: 66 } } },
        },
        stale: [],
        staleParts: [],
        deviceParts: [],
      }],
    };
    const fixtureScript = `(() => {
      const fixture = ${JSON.stringify({ state: fixtureState, overview: fixtureOverview })};
      window.__uiSmokeRequests = [];
      const realFetch = window.fetch.bind(window);
      const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, location.origin);
        const method = String(init.method ?? (typeof input === "string" ? "GET" : input.method) ?? "GET").toUpperCase();
        if (url.pathname === "/api/state") return json(fixture.state);
        if (url.pathname === "/api/tune/overview") return json(fixture.overview);
        if (url.pathname === "/api/tune/status") return json({ job: null });
        if (url.pathname === "/api/tune/start" && method === "POST") {
          window.__uiSmokeRequests.push({ path: url.pathname, body: JSON.parse(init.body ?? "{}") });
          return json({ job: { status: "running", items: [{ profileId: "fixture-model", name: "Fixture model", status: "running", lane: "cpu", live: { answers: 0, expectedAnswers: 10 } }] } });
        }
        return realFetch(input, init);
      };
    })();`;

    browser = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${cdpPort}`,
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdio: "ignore" },
    );

    const pages = await (async () => {
      let found = null;
      await waitFor(async () => {
        found = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        return Boolean(found?.length);
      });
      return found;
    })();
    if (!pages?.length) throw new Error("The headless browser did not expose a page");

    ws = new WebSocket(pages.find((item) => item.type === "page")?.webSocketDebuggerUrl ?? pages[0].webSocketDebuggerUrl);
    const pending = new Map();
    const exceptions = [];
    let id = 0;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const messageId = ++id;
        pending.set(messageId, { resolve, reject });
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      }
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return result.result.value;
    };

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__uiSmokeErrors = [];
        window.addEventListener("unhandledrejection", (event) => window.__uiSmokeErrors.push(String(event.reason?.stack || event.reason)));
        window.addEventListener("error", (event) => window.__uiSmokeErrors.push(event.message));
        ${fixtureScript}`,
    });
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });

    assert.ok(await waitFor(() => evaluate('Boolean(document.querySelector(".dashboard"))')), "the dashboard did not render");
    assert.equal(await evaluate('document.getElementById("messages") === null'), true, "the chat shell is still present");
    assert.equal(await evaluate('document.getElementById("dashboard-models") !== null'), true, "the model dashboard is missing");
    assert.ok(await waitFor(() => evaluate('document.querySelectorAll(".dash-model").length === 1'), 3_000), "the fixture model row did not render");
    assert.equal(await evaluate('document.getElementById("dash-model-count").textContent'), "1");
    assert.equal(await evaluate('Boolean(document.querySelector("[data-dashboard-tune=\\"fixture-model\\"]"))'), true, "the fixture Tune action is missing");
    assert.ok(await waitFor(() => evaluate('Boolean(document.querySelector(".tune-latest"))'), 3_000), "the latest profile line did not render");
    assert.match(await evaluate('document.querySelector(".tune-latest").textContent'), /Fixture model · code 81\.2%/, "the latest profile line has the wrong model or rate");
    await evaluate('document.querySelector("[data-dashboard-tune=\\"fixture-model\\"]").click(), true');
    assert.ok(
      await waitFor(() => evaluate('document.getElementById("confirm-dialog").open'), 2_000),
      "the dashboard Tune action did not ask before a full tune",
    );
    assert.match(
      await evaluate('document.getElementById("confirm-message").textContent'),
      /Fixture model/,
      "the confirmation does not name the model",
    );
    await evaluate('document.getElementById("confirm-ok").click(), true');
    assert.ok(await waitFor(() => evaluate('window.__uiSmokeRequests.length > 0'), 3_000), "the dashboard Tune action did not start a tune");
    const tuneRequest = await evaluate('window.__uiSmokeRequests[0]');
    assert.deepEqual(tuneRequest.body.models, ["fixture-model"]);
    assert.deepEqual(tuneRequest.body.stages, ["device", "quality", "speed", "sampling", "prompt"]);
    assert.equal(tuneRequest.body.settings, null);
    assert.equal(tuneRequest.body.force, false);
    await evaluate('document.getElementById("benchmark-dialog").close(), true');

    const dialogs = [
      ["open-models", "models-dialog"],
      ["open-benchmarks", "benchmark-dialog"],
      ["open-settings", "settings-dialog"],
      ["open-server", "server-dialog"],
    ];
    for (const [button, dialog] of dialogs) {
      await evaluate(`document.getElementById("${button}").click(), true`);
      const opened = await waitFor(() => evaluate(`document.getElementById("${dialog}").open`), 5_000);
      assert.ok(opened, `${dialog} did not open`);
      const state = await evaluate(`(() => {
        const node = document.getElementById("${dialog}");
        const rect = node.getBoundingClientRect();
        return { display: getComputedStyle(node).display, width: Math.round(rect.width) };
      })()`);
      assert.equal(state.display, "flex", `${dialog} is not displayed`);
      assert.ok(state.width >= 300, `${dialog} is too narrow (${state.width}px)`);
      await evaluate(`document.getElementById("${dialog}").close(), true`);
    }

    await evaluate('document.getElementById("open-settings").click(), true');
    assert.ok(await waitFor(() => evaluate('document.getElementById("settings-dialog").open'), 3_000), "the Settings dialog did not open for help");
    const helpState = await evaluate(`(() => {
      const count = document.querySelectorAll(".field-help").length;
      const button = document.querySelector("#setting-context").closest("label").querySelector(".field-help");
      button.click();
      const popover = document.getElementById("field-help-popover");
      return { count, open: popover.matches(":popover-open") || getComputedStyle(popover).display !== "none", text: popover.textContent };
    })()`);
    assert.ok(helpState.count >= 20, `too few inline help controls (${helpState.count})`);
    assert.equal(helpState.open, true, "the inline help popover did not open");
    assert.match(helpState.text, /context/i, `the inline help text is missing: ${JSON.stringify(helpState)}`);
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
    assert.equal(await evaluate('document.getElementById("field-help-popover").matches(":popover-open")'), false, "Escape did not close the inline help");

    // Dirty-state guard: an edit is marked, and a close asks before discarding it.
    await evaluate(`(() => {
      const input = document.getElementById("setting-system");
      input.value = "an unsaved edit";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    assert.equal(await evaluate('document.getElementById("settings-dirty").hidden'), false, "the unsaved marker did not appear");
    await evaluate('document.querySelector("#settings-dialog [data-close-dialog]").click(), true');
    assert.ok(
      await waitFor(() => evaluate('document.getElementById("confirm-dialog").open'), 2_000),
      "closing a dirty settings form did not ask",
    );
    assert.match(
      await evaluate('document.getElementById("confirm-message").textContent'),
      /not saved/,
      "the discard confirmation does not explain the loss",
    );
    await evaluate('document.getElementById("confirm-cancel").click(), true');
    await delay(120);
    assert.equal(await evaluate('document.getElementById("confirm-dialog").open'), false, "Cancel on the discard prompt left the confirm open");
    assert.equal(await evaluate('document.getElementById("settings-dialog").open'), true, "Cancel on the discard prompt closed the form");
    await evaluate('document.querySelector("#settings-dialog [data-close-dialog]").click(), true');
    assert.ok(await waitFor(() => evaluate('document.getElementById("confirm-dialog").open'), 2_000), "the second close did not ask again");
    await evaluate('document.getElementById("confirm-ok").click(), true');
    let discard = null;
    const closed = await waitFor(async () => {
      discard = JSON.parse(
        await evaluate(`JSON.stringify({
          settings: document.getElementById("settings-dialog").open,
          confirm: document.getElementById("confirm-dialog").open,
          dirty: document.getElementById("settings-dirty").hidden,
        })`),
      );
      return discard.settings === false;
    }, 2_000);
    assert.ok(closed, `Discard did not close the settings form: ${JSON.stringify(discard)}`);

    await evaluate('document.getElementById("open-settings").click(), true');
    await delay(120);
    await evaluate('document.getElementById("settings-dialog").close(), true');
    await evaluate('document.getElementById("open-server").click(), true');
    assert.ok(
      await waitFor(() => evaluate('document.getElementById("server-dialog").open'), 2_000),
      "the Server dialog must open immediately after Settings",
    );
    await evaluate('document.getElementById("server-dialog").close(), true');

    await evaluate('document.getElementById("open-benchmarks").click(), true');
    assert.ok(
      await waitFor(() => evaluate('document.getElementById("benchmark-dialog").open'), 3_000),
      "the Bench dialog did not open",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("[data-bench-tab]").length'),
      6,
      "the Bench rail must list all six sections",
    );
    assert.equal(
      await evaluate('document.querySelector(".bench-nav").getAttribute("aria-orientation")'),
      "vertical",
      "the wide Bench rail must announce a vertical tablist",
    );
    for (const tab of ["tune", "models", "runs", "settings", "suite", "gate"]) {
      await evaluate(`document.querySelector('[data-bench-tab="${tab}"]').click(), true`);
      const state = await evaluate(`(() => {
        const button = document.querySelector('[data-bench-tab="${tab}"]');
        const panel = document.querySelector('[data-bench-panel="${tab}"]');
        const controlled = document.getElementById(button.getAttribute("aria-controls"));
        const otherDisplay = [...document.querySelectorAll("[data-bench-panel]")]
          .filter((node) => node.dataset.benchPanel !== "${tab}")
          .map((node) => getComputedStyle(node).display);
        return { selected: button.getAttribute("aria-selected"), hidden: panel.hidden, display: getComputedStyle(panel).display, controlled: controlled === panel, otherDisplayed: otherDisplay.filter((value) => value !== "none").length };
      })()`);
      assert.equal(state.selected, "true", `the ${tab} Bench tab did not become selected`);
      assert.equal(state.hidden, false, `the ${tab} Bench panel stayed hidden`);
      assert.notEqual(state.display, "none", `the ${tab} Bench panel is not displayed`);
      assert.equal(state.controlled, true, `the ${tab} Bench tab's aria-controls does not point at its panel`);
      assert.equal(state.otherDisplayed, 0, `the ${tab} Bench tab left another panel visible`);
    }
    await evaluate('document.querySelector(\'[data-bench-tab="tune"]\').click(), true');
    await evaluate('document.querySelector(\'[data-bench-tab="suite"]\').click(), true');
    assert.ok(await waitFor(() => evaluate('document.querySelectorAll(".suite-task").length === 3'), 8_000), "the Bench suite did not render three tasks");
    assert.equal(await evaluate('document.querySelectorAll(".suite-optin").length'), 1, "the Bench suite does not describe the opt-in multistep chains");
    assert.equal(await evaluate('document.querySelectorAll(".suite-stat").length'), 4, "the Bench suite is missing its summary stats");
    assert.equal(await evaluate('document.querySelectorAll(".suite-details").length'), 3, "the Bench suite is missing its detail disclosures");
    assert.equal(await evaluate('document.querySelectorAll("#tune-tasks input[type=checkbox]").length'), 3, "the tuning task scope is missing");
    assert.equal(await evaluate('Boolean(document.getElementById("tune-quick"))'), true, "the quick pass control is missing");
    assert.equal(await evaluate('Boolean(document.getElementById("tune-pause"))'), true, "the pause control is missing");
    assert.equal(await evaluate('Boolean(document.getElementById("tune-guard"))'), true, "the guardrail control is missing");
    assert.ok(await waitFor(() => evaluate('document.getElementById("tune-preflight").textContent.includes("answers/model")'), 5_000), "the tune preflight estimate did not load");
    await evaluate('document.querySelector(\'[data-bench-tab="tune"]\').click(), true');
    assert.equal(
      await evaluate('Boolean(document.getElementById("tune-help"))'),
      true,
      "the Tune tab is missing the tuning help section",
    );
    await evaluate('document.querySelector("#tune-help summary").click(), true');
    assert.equal(
      await evaluate('document.getElementById("tune-help").open'),
      true,
      "the tuning help section did not open",
    );
    assert.match(
      await evaluate('document.getElementById("tune-help").textContent'),
      /Increasing rungs/,
      "the tuning help does not explain the rungs",
    );
    await evaluate('document.getElementById("benchmark-dialog").close(), true');

    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(400);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
      true,
      "the dashboard overflows horizontally at 390px",
    );
    await evaluate('document.getElementById("open-models").click(), true');
    assert.ok(
      await waitFor(() => evaluate('document.getElementById("models-dialog").open'), 3_000),
      "the Models dialog did not open at 390px",
    );
    assert.ok(
      (await evaluate('document.getElementById("models-dialog").getBoundingClientRect().width')) <= 390,
      "the Models dialog is wider than a 390px viewport",
    );
    await evaluate('document.getElementById("models-dialog").close(), true');
    await evaluate('document.getElementById("open-benchmarks").click(), true');
    assert.ok(
      await waitFor(() => evaluate('document.getElementById("benchmark-dialog").open'), 3_000),
      "the Bench dialog did not open at 390px",
    );
    assert.ok(
      (await evaluate('document.getElementById("benchmark-dialog").getBoundingClientRect().width')) >= 389,
      "the Bench dialog must fill a 390px viewport",
    );
    assert.equal(
      await evaluate('document.querySelector(".bench-nav").getAttribute("aria-orientation")'),
      "horizontal",
      "the narrow Bench rail must announce a horizontal tablist",
    );
    for (const tab of ["models", "runs"]) {
      await evaluate(`document.querySelector('[data-bench-tab="${tab}"]').click(), true`);
      await delay(80);
      const fit = await evaluate(`(() => {
        const body = document.querySelector(".bench-shell .benchmark-body");
        return { scroll: body.scrollWidth, client: body.clientWidth };
      })()`);
      assert.ok(fit.scroll <= fit.client + 1, `the ${tab} Bench panel overflows at 390px (${fit.scroll} > ${fit.client})`);
    }
    await evaluate('document.getElementById("benchmark-dialog").close(), true');
    for (const [button, dialog] of [["open-settings", "settings-dialog"], ["open-server", "server-dialog"]]) {
      await evaluate(`document.getElementById("${button}").click(), true`);
      assert.ok(await waitFor(() => evaluate(`document.getElementById("${dialog}").open`), 3_000), `${dialog} did not open at 390px`);
      const rect = await evaluate(`(() => { const r = document.getElementById("${dialog}").getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
      assert.ok(rect.width <= 390, `${dialog} is wider than a 390px viewport`);
      assert.ok(rect.height >= 800, `${dialog} is shorter than the 390px viewport`);
      await evaluate(`document.getElementById("${dialog}").close(), true`);
    }

    const pageErrors = await evaluate("window.__uiSmokeErrors ?? []");
    assert.deepEqual([...exceptions, ...pageErrors], [], "the control panel raised a console exception");
    console.log("[ui-smoke] control panel, four dialogs and six Bench sections are OK, including 390px reflow");
  } finally {
    ws?.close();
    browser?.kill();
    server?.kill();
    await delay(400);
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[ui-smoke] ${error.stack || error}`);
  process.exitCode = 1;
});
