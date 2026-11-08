import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SUITE_VERSION } from "../benchmarks/suite.mjs";
import { latestRunForPhase } from "../benchmarks/report.mjs";
import { loadBenchmarkReport, summarizeBenchmark } from "../src/benchmark-report.js";

const MODEL = {
  phase: "model",
  suiteVersion: 4,
  testHash: "modelhash",
  createdAt: "2026-10-30T00:00:00.000Z",
  runtimeMs: 120000,
  overall: { score: 82.5, tokensPerSecond: 47.1, firstTokenMs: 198, checksPassed: 100, checksTotal: 120 },
  tests: [
    { id: "exact-word", label: "Exact word", category: "instruction", passed: 14, total: 39, percent: 35.9 },
    { id: "arithmetic", label: "Arithmetic", category: "reasoning", passed: 34, total: 39, percent: 87.2 },
  ],
};
const CHAT = {
  phase: "chat",
  suiteVersion: 4,
  testHash: "chathash",
  createdAt: "2026-10-30T00:05:00.000Z",
  runtimeMs: 139000,
  overall: { score: 86.3, tokensPerSecond: 43.1, firstTokenMs: 213, checksPassed: 110, checksTotal: 127 },
  tests: [{ id: "json-format", label: "JSON format", category: "format", passed: 36, total: 36, percent: 100 }],
};

function historyRecord(uid, phase, testHash, commit) {
  return JSON.stringify({
    type: "run",
    uid,
    recordedAt: `2026-10-30T00:0${phase === "model" ? 1 : 6}:00.000Z`,
    baseline: true,
    git: { hash: null, subject: null },
    result: {
      phase,
      testHash,
      runtimeMs: phase === "model" ? 120000 : 139000,
      overall: { score: 82, tokensPerSecond: 47 },
    },
  });
}

test("benchmark summary exposes per-test percentages and linked commits", () => {
  const links = new Map([
    ["run-model", { hash: "abcdef123456", subject: "model commit" }],
    ["run-chat", { hash: "1234567890ab", subject: "chat commit" }],
  ]);
  const summary = summarizeBenchmark({
    model: MODEL,
    chat: CHAT,
    history: {
      runs: [
        { uid: "run-model", recordedAt: "2026-10-30T00:01:00.000Z", baseline: true, git: {}, result: MODEL },
        { uid: "run-chat", recordedAt: "2026-10-30T00:06:00.000Z", baseline: true, git: {}, result: CHAT },
      ],
      links,
    },
  });
  assert.equal(summary.available, true);
  assert.equal(summary.phases.length, 2);
  const model = summary.phases.find((phase) => phase.phase === "model");
  assert.equal(model.quality, 82.5);
  assert.equal(model.tests[0].percent, 35.9);
  assert.equal(model.tests[1].passed, 34);
  assert.equal(model.commit.hash, "abcdef1");
  assert.equal(model.commit.subject, "model commit");
  assert.equal(summary.phases.find((phase) => phase.phase === "chat").tests[0].percent, 100);
  assert.equal(summary.history.length, 2);
  assert.equal(summary.history[0].phase, "chat");
});

test("a benchmark phase exposes host + VRAM and quality per second per GB", () => {
  const result = {
    ...MODEL,
    models: [{ tokensPerSecond: 47.1, memoryBytes: 1_000_000_000, gpuVram: 2_000_000_000 }],
  };
  const summary = summarizeBenchmark({ model: result, history: { runs: [], links: new Map() } });
  const phase = summary.phases[0];
  assert.equal(phase.memoryBytes, 1_000_000_000);
  assert.equal(phase.gpuVram, 2_000_000_000);
  assert.equal(phase.totalMemoryBytes, 3_000_000_000);
  assert.equal(phase.qualityPerSecond, 0.69, "82.5% over 120 s");
  assert.ok(Number.isFinite(phase.qualityPerSecondPerGb), "per-GB quality uses host + VRAM");
});

test("a missing benchmark report is empty instead of throwing", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-bench-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summary = await loadBenchmarkReport({ benchmarkDir: directory });
  assert.equal(summary.available, false);
  assert.deepEqual(summary.phases, []);
  assert.deepEqual(summary.history, []);
});

test("the loader reads baselines and history links from disk", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-bench-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "baseline-model.json"), `${JSON.stringify(MODEL)}\n`);
  await writeFile(path.join(directory, "baseline-chat.json"), `${JSON.stringify(CHAT)}\n`);
  await writeFile(
    path.join(directory, "history.jsonl"),
    `${historyRecord("run-model", "model", "modelhash")}\n` +
      `${JSON.stringify({ type: "link", runUid: "run-model", commit: { hash: "deadbeef00", subject: "linked" } })}\n`,
  );
  const summary = await loadBenchmarkReport({ benchmarkDir: directory });
  assert.equal(summary.available, true);
  assert.equal(summary.phases.find((phase) => phase.phase === "model").commit.hash, "deadbee");
  assert.equal(summary.history[0].commit.subject, "linked");
});

test("the Bench summary carries the item pass rate and its interval when present", () => {
  const byOrigin = {
    own: { passed: 30, total: 40, rate: 75, ci95: { low: 60, high: 86 } },
    public: { passed: 10, total: 17, rate: 58.8, ci95: { low: 36, high: 78 } },
  };
  const byCategory = {
    code: { passed: 12, total: 14, rate: 85.7, ci95: { low: 60, high: 96 } },
    "public-code": { passed: 8, total: 12, rate: 66.7, ci95: { low: 39, high: 86 } },
  };
  const withItems = { ...MODEL, overall: { ...MODEL.overall, items: { passed: 40, total: 57, rate: 70.2, ci95: { low: 57.3, high: 80.5 }, byCategory, byOrigin } } };
  const report = summarizeBenchmark({ model: withItems, chat: CHAT });
  const byPhase = Object.fromEntries(report.phases.map((phase) => [phase.phase, phase]));
  assert.deepEqual(byPhase.model.items, {
    passed: 40,
    total: 57,
    rate: 70.2,
    ci95: { low: 57.3, high: 80.5 },
    byCategory,
    byOrigin,
    byDataset: null,
  });
  assert.equal(byPhase.chat.items, null);
});

test("origin is derived for results saved before the split", () => {
  const legacy = {
    ...MODEL,
    overall: { ...MODEL.overall, items: { passed: 1, total: 2, rate: 50, ci95: { low: 10, high: 90 } } },
    models: [
      {
        prompts: [
          { id: "own", category: "facts", passed: 1, total: 1, error: null },
          { id: "pub", category: "public-code", passed: 0, total: 1, error: null },
        ],
      },
    ],
  };
  const report = summarizeBenchmark({ model: legacy });
  assert.equal(report.phases[0].items.byOrigin.own.total, 1);
  assert.equal(report.phases[0].items.byOrigin.own.passed, 1);
  assert.equal(report.phases[0].items.byOrigin.public.total, 1);
  assert.equal(report.phases[0].items.byOrigin.public.passed, 0);
  assert.equal(report.phases[0].items.byCategory.facts.total, 1);
  assert.equal(report.phases[0].items.byCategory["public-code"].passed, 0);
});

test("the Bench summary exposes the saved chat-phase base", () => {
  const chatBase = { variantId: "coder-f16", label: "Coder Q4", catalogId: "qwen2.5-coder-1.5b-instruct-q4" };
  const report = summarizeBenchmark({ model: MODEL, chatBase });
  assert.equal(report.chatBase, chatBase);
});

test("a single-model diagnostic appears as its own phase", () => {
  const single = {
    ...MODEL,
    settings: { matrixScope: "single:qwen2.5-0.5b-instruct-q4" },
  };
  const report = summarizeBenchmark({ singleModel: single });
  const phase = report.phases.find((item) => item.phase === "single");
  assert.equal(phase.catalogId, "qwen2.5-0.5b-instruct-q4");
  assert.equal(phase.label, "Qwen2.5 0.5B");
  assert.equal(report.models.length, 6);
  assert.match(report.recommendationsTitle, /Qwen2\.5 0\.5B/);
});

test("the Bench summary recommends settings from the latest model run", () => {
  const variant = (variantId, rate, tokensPerSecond) => ({
    variantId,
    key: variantId,
    label: `${variantId} · Q4_K_M`,
    fileName: `${variantId}.gguf`,
    kvCache: "f16",
    requestedContextSize: 2048,
    tokensPerSecond,
    firstTokenMs: 100,
    items: {
      passed: Math.round((rate / 100) * 91),
      total: 91,
      rate,
      ci95: { low: rate - 5, high: rate + 5 },
      byCategory: { code: { passed: 4, total: 6 } },
    },
  });
  const latestModel = {
    phase: "model",
    suiteVersion: 6,
    createdAt: "2026-10-30T01:00:00.000Z",
    models: [variant("big-f16", 90, 10), variant("coder-f16", 86, 22)],
  };
  const report = summarizeBenchmark({ model: MODEL, chat: CHAT, latestModel });
  assert.equal(report.recommendations.available, true);
  assert.equal(report.recommendations.items[0].kind, "quality");
  assert.equal(report.recommendations.items[0].variantId, "big-f16");
  assert.equal(report.recommendations.suiteVersion, 6);
});

test("the report names the current suite version so older reports can be told apart", () => {
  assert.equal(summarizeBenchmark().currentSuiteVersion, SUITE_VERSION);
});

test("latestRunForPhase prefers standard runs and falls back with scope intact", () => {
  const standard = { uid: "s", phase: "model", run_scope: "standard" };
  const repro = { uid: "r", phase: "model", run_scope: "repro" };
  const shard = { uid: "h", phase: "model", run_scope: "shard" };
  assert.equal(latestRunForPhase([repro, standard], "model"), standard);
  assert.equal(latestRunForPhase([repro, shard], "model"), repro);
  assert.equal(latestRunForPhase([repro], "chat"), undefined);
  assert.equal(latestRunForPhase([{ uid: "x" }], "model").uid, "x", "missing scope counts as standard");
});
