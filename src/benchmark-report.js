import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadChatBase } from "./benchmark-base.js";
import { itemSummary } from "../benchmarks/stats.mjs";
import { recommend } from "../benchmarks/recommend.mjs";
import { BENCHMARK_MODELS, SUITE_VERSION } from "../benchmarks/suite.mjs";

const PHASES = [
  { phase: "model", file: "baseline-model.json" },
  { phase: "chat", file: "baseline-chat.json" },
];

function compactCommit(commit) {
  if (!commit?.hash) return null;
  return {
    hash: String(commit.hash).slice(0, 7),
    subject: commit.subject ?? "",
  };
}

function summarizePhase(result, commit) {
  if (!result || typeof result !== "object") return null;
  const items = result.overall?.items
    ? (() => {
        const derived = result.models?.length
          ? itemSummary(result.models.flatMap((model) => model.prompts ?? []))
          : null;
        return {
          passed: Number(result.overall.items.passed) || 0,
          total: Number(result.overall.items.total) || 0,
          rate: Number(result.overall.items.rate) || 0,
          ci95: result.overall.items.ci95 ?? null,
          byCategory: result.overall.items.byCategory ?? derived?.byCategory ?? null,
          byOrigin: result.overall.items.byOrigin ?? derived?.byOrigin ?? null,
          byDataset: result.overall.items.byDataset ?? derived?.byDataset ?? null,
        };
      })()
    : null;
  const quality = Number(result.overall?.score) || 0;
  const runtimeMs = Number(result.runtimeMs) || 0;
  // The phase card needs the denominator a per-GB claim uses. Take the fastest
  // variant's measured footprint; host RAM and VRAM are both reported.
  const representative = (result.models ?? [])
    .slice()
    .sort((left, right) => (Number(right.tokensPerSecond) || 0) - (Number(left.tokensPerSecond) || 0))[0] ?? null;
  const memoryBytes = Number(representative?.memoryBytes) || 0;
  const gpuVram = Number(representative?.gpuVram) || 0;
  const totalMemoryBytes = memoryBytes + gpuVram || null;
  const qualityPerSecond = runtimeMs > 0 ? Number(((quality / (runtimeMs / 1000))).toFixed(2)) : null;
  const qualityPerSecondPerGb = totalMemoryBytes && qualityPerSecond
    ? Number((qualityPerSecond / (totalMemoryBytes / 1024 ** 3)).toFixed(2))
    : null;
  return {
    phase: result.phase,
    suiteVersion: result.suiteVersion ?? null,
    testHash: result.testHash ?? null,
    createdAt: result.createdAt ?? null,
    runtimeMs,
    quality,
    tokensPerSecond: Number(result.overall?.tokensPerSecond) || 0, // aikit:allow-secret speed metric
    firstTokenMs: Number(result.overall?.firstTokenMs) || 0, // aikit:allow-secret timing metric
    memoryBytes: memoryBytes || null,
    gpuVram: gpuVram || null,
    totalMemoryBytes,
    qualityPerSecond,
    qualityPerSecondPerGb,
    checksPassed: Number(result.overall?.checksPassed) || 0,
    checksTotal: Number(result.overall?.checksTotal) || 0,
    items,
    tests: (result.tests ?? []).map((test) => ({
      id: test.id,
      label: test.label || test.id,
      category: test.category ?? "",
      origin:
        test.origin ??
        (test.source || String(test.category ?? "").startsWith("public-") ? "public" : "own"),
      dataset:
        test.dataset ??
        test.source?.dataset ??
        (String(test.category ?? "").startsWith("public-") ? String(test.category).slice(7) : "own"),
      passed: Number(test.passed) || 0,
      total: Number(test.total) || 0,
      percent: Number(test.percent) || 0,
    })),
    commit: compactCommit(commit),
  };
}

function parseHistory(text) {
  const runs = [];
  const links = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "link" && record.runUid && record.commit?.hash) {
      links.set(record.runUid, record.commit);
    } else if (record.type === "run" && record.result) {
      runs.push(record);
    }
  }
  return { runs, links };
}

function commitFor(run, links) {
  return links.get(run.uid) ?? run.git ?? null;
}

function latestCommit(runs, links, phase, testHash) {
  const matches = runs.filter(
    (run) => run.result?.phase === phase && (!testHash || run.result?.testHash === testHash),
  );
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const commit = commitFor(matches[index], links);
    if (commit?.hash) return commit;
  }
  return null;
}

function historySummary(runs, links, limit) {
  return runs
    .filter((run) => run.result?.phase)
    .slice(-limit)
    .reverse()
    .map((run) => ({
      phase: run.result.phase,
      recordedAt: run.recordedAt ?? run.result.finishedAt ?? null,
      quality: Number(run.result.overall?.score) || 0,
      tokensPerSecond: Number(run.result.overall?.tokensPerSecond) || 0, // aikit:allow-secret speed metric
      runtimeMs: Number(run.result.runtimeMs) || 0,
      testHash: run.result.testHash ?? null,
      baseline: Boolean(run.baseline),
      commit: compactCommit(commitFor(run, links)),
    }));
}

export function summarizeBenchmark({ model = null, chat = null, latestModel = null, singleModel = null, chatBase = null, history = [], limit = 8 } = {}) {
  const runs = Array.isArray(history) ? history : history?.runs ?? [];
  const links = Array.isArray(history) ? new Map() : history?.links ?? new Map();
  const phases = PHASES.map(({ phase }) => {
    const result = phase === "model" ? model : chat;
    return summarizePhase(result, latestCommit(runs, links, phase, result?.testHash));
  }).filter(Boolean);
  if (singleModel) {
    const summary = summarizePhase(singleModel, null);
    if (summary) {
      summary.phase = "single";
      summary.catalogId = String(singleModel.settings?.matrixScope ?? "").replace(/^single:/, "") || null;
      summary.label = BENCHMARK_MODELS.find((item) => item.catalogId === summary.catalogId)?.label ?? summary.catalogId;
      phases.push(summary);
    }
  }
  const advice = singleModel ?? latestModel ?? model;
  const singleLabel = singleModel
    ? BENCHMARK_MODELS.find((item) => item.catalogId === String(singleModel.settings?.matrixScope ?? "").replace(/^single:/, ""))?.label
    : null;
  return {
    // Reports from an older suite are shown only when asked for (Bench panel).
    currentSuiteVersion: SUITE_VERSION,
    available: phases.length > 0,
    phases,
    history: historySummary(runs, links, limit),
    recommendations: advice ? recommend(advice) : { available: false, items: [] },
    recommendationsTitle: singleModel ? `Best settings for ${singleLabel ?? "this model"}` : "Recommended configurations",
    chatBase,
    models: BENCHMARK_MODELS.map((entry) => ({
      catalogId: entry.catalogId,
      label: entry.label,
      kind: entry.kind,
      fileName: entry.fileName,
    })),
  };
}

export async function loadBenchmarkReport({
  benchmarkDir,
  historyPath = path.join(benchmarkDir, "history.jsonl"),
  limit = 8,
} = {}) {
  const readJson = async (file) => {
    try {
      return JSON.parse(await readFile(path.join(benchmarkDir, file), "utf8"));
    } catch {
      return null;
    }
  };
  const [model, chat, latestModel, singleModel, historyText, chatBase] = await Promise.all([
    readJson("baseline-model.json"),
    readJson("baseline-chat.json"),
    readJson(path.join("results", "latest-model.json")),
    readJson(path.join("results", "latest-single-model.json")),
    readFile(historyPath, "utf8").catch(() => ""),
    loadChatBase({ benchmarkDir }).catch(() => null),
  ]);
  return summarizeBenchmark({
    model,
    chat,
    latestModel,
    singleModel,
    chatBase,
    history: parseHistory(historyText),
    limit,
  });
}
