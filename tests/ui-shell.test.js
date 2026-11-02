import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const html = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../public/styles.css", import.meta.url)), "utf8");
const theme = readFileSync(fileURLToPath(new URL("../public/redesign.css", import.meta.url)), "utf8");

test("the control panel is wired and the chat shell is gone", () => {
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const appIds = new Set([
    ...[...app.matchAll(/\$\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]),
    ...[...app.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]),
  ]);
  const duplicates = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);

  assert.deepEqual([...new Set(duplicates)], [], "the page has duplicate ids");
  assert.deepEqual(
    [...appIds].filter((id) => !htmlIds.includes(id)),
    [],
    "app.js references an id that index.html does not define",
  );
  for (const match of html.matchAll(/\baria-(?:controls|labelledby|describedby)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/).filter(Boolean)) {
      assert.ok(htmlIds.includes(id), `ARIA reference points at a missing id: ${id}`);
    }
  }

  for (const id of [
    "open-models",
    "open-benchmarks",
    "open-settings",
    "open-server",
    "nav-overview",
    "status-card",
    "dashboard-models",
    "dashboard-tuning",
    "dashboard-system",
    "dash-runtime",
    "dash-model-count",
    "dash-tuned-count",
    "dash-api-state",
    "status-announcer",
    "models-dialog",
    "benchmark-dialog",
    "settings-dialog",
    "server-dialog",
    "context-note",
  ]) {
    assert.ok(htmlIds.includes(id), `missing control-panel id: ${id}`);
  }
  for (const id of ["chat-title", "messages", "composer", "conversation-list", "prompt"]) {
    assert.ok(!htmlIds.includes(id), `legacy chat id is still in the page: ${id}`);
  }

  assert.doesNotMatch(app, /\/api\/(?:chat|conversations)\b/, "app.js still calls a removed chat route");
  assert.doesNotMatch(app, /renderMarkdown|SUGGESTIONS|renderSidebar/, "app.js still has chat-only code");

  const opener = app.match(/async function openServerSettings\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(opener, "openServerSettings is missing");
  assert.ok(
    opener.indexOf("showModal") >= 0 && opener.indexOf("showModal") < opener.indexOf('request("/api/server-settings")'),
    "the Server dialog must open before its fetch so the button always responds",
  );

  const cssRules = `${css}\n${theme}`.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const dead of ["sidebar", "messages", "composer", "conversation", "chat-title", "markdown", "code-block", "suggestion", "scrim", "model-pill"]) {
    assert.doesNotMatch(
      cssRules,
      new RegExp(`(^|[,{}]\\s*)\\.${dead}\\b`),
      `legacy selector .${dead} is still in styles.css`,
    );
  }
  assert.match(html, /id="tune-tasks"/);
  for (const id of ["tune-task-code", "tune-task-comprehension", "tune-task-recall", "tune-preflight", "tune-quick", "tune-pause", "tune-guard", "tune-guard-queue", "tune-background"]) {
    assert.ok(html.includes(id), `missing tuning control: ${id}`);
  }
  assert.match(cssRules, /\.tune-scope\b/, "missing tuning task scope style");
  assert.match(cssRules, /\.tune-move\b/, "missing queue move style");
  for (const selector of ["dashboard", "rail", "metric-strip", "panel", "status-card"]) {
    assert.match(cssRules, new RegExp(`\\.${selector}\\b`), `missing control-panel selector .${selector}`);
  }
  for (const selector of [
    "tune-live-best",
    "toast-close",
    "toast-fix",
    "download-state",
    "download-row",
    "msg-action",
    "key-row",
    "key-actions",
    "benchmark-card",
    "benchmark-metrics",
    "benchmark-metric",
    "benchmark-chips",
    "benchmark-chip",
    "benchmark-advice-grid",
    "benchmark-advice-card",
    "benchmark-advice-actions",
    "benchmark-types",
    "benchmark-history",
    "benchmark-items",
    "benchmark-commit",
    "benchmark-empty",
  ]) {
    assert.match(cssRules, new RegExp(`\\.${selector}\\b`), `generated control has no style: .${selector}`);
  }
  for (const selector of ["tune-chip.partial", "tune-chip.pending", "tune-chip.other-device", "tune-chip.dropped"]) {
    assert.match(cssRules, new RegExp(`\\.${selector.replace(".", "\\.")}\\b`), `generated state has no style: .${selector}`);
  }
  assert.match(cssRules, /#tune-models[\s\S]*?#tune-runs-list[\s\S]*?#tune-run-detail[\s\S]*?overflow-x:\s*auto/, "the mobile tune panels need their own horizontal scrollers");
});

test("the tuning help explains the stages and the checks", () => {
  const allCss = `${css}\n${theme}`.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(html, /id="tune-help"/);
  assert.match(html, /id="field-help-popover"/);
  assert.match(app, /const SETTING_HELP = \{/);
  assert.match(allCss, /\.field-help\b/, "missing inline help style");
  for (const text of [
    "How tuning works",
    "Local measurement, not training",
    "Why this order:",
    "Quality sets the",
    "Stage 0 · Device",
    "Stage 1 · Quality",
    "Stage 2 · Speed",
    "Stage 3 · Sampling",
    "Stage 4 · Prompt",
    "Increasing rungs",
    "Only clear gains",
    "Unseen check",
    "Stop and resume",
  ]) {
    assert.ok(html.includes(text), `tuning help is missing: ${text}`);
  }
});

test("the tune preflight covers the Only-settings boxes", () => {
  const preflight = app.match(/async function refreshTunePreflight\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(preflight, "refreshTunePreflight is missing");
  assert.match(preflight, /tuneOnly/, "the preflight reads the Only-settings boxes");
  assert.match(preflight, /settings=/, "the estimate request carries the chosen settings");
  assert.match(
    app,
    /els\.tuneOnly\.addEventListener\("change"[\s\S]*?refreshTunePreflight/,
    "changing Only-settings refreshes the preflight",
  );
});

test("the suite summary never renders NaN or Infinity", () => {
  const render = app.match(/function renderBenchSuite\(suite\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(render, "renderBenchSuite is missing");
  assert.match(render, /Number\.isFinite\(suite\.holdoutShare\)/, "a missing holdout share shows a dash");
  assert.match(render, /rounds\.length \?/, "an empty task list shows a dash for rounds");
  assert.doesNotMatch(css, /\.bench-suite-(total|task)\b/, "the old suite overview styles are gone");
});

test("stage help and the popover fallback degrade gracefully", () => {
  const mark = app.match(/function markSettingHelp\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(mark, "markSettingHelp is missing");
  assert.match(mark, /STAGE_HELP\[input\.value\]/, "stage help comes from the map");
  assert.match(mark, /if \(!span \|\| !text/, "a stage without help text gets no button");
  assert.match(theme, /@supports not selector\(:popover-open\)/, "browsers without popover start with the help box hidden");
});

test("a task subset counts as a part run so scratch never drops the other tasks", () => {
  const start = app.match(/async function startTune\(models[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(start, "startTune is missing");
  assert.match(start, /taskList/, "the form builds an explicit task list");
  assert.match(start, /taskList\.length < TUNE_TASKS\.length/, "a task subset marks the run a part run");
});
