import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveRunScope,
  importHistory,
  linkRun,
  listRuns,
  modelProgress,
  openDatabase,
  rebuildDatabase,
  recordRun,
} from "../benchmarks/history.mjs";

const RESULT = {
  schema: 1,
  suiteVersion: 1,
  appVersion: "0.1.0",
  createdAt: "2026-10-30T10:00:00.000Z",
  finishedAt: "2026-10-30T10:01:00.000Z",
  machine: { cpu: "Test CPU", platform: "test" },
  settings: { contextSize: 2048, threads: 4 },
  overall: {
    score: 50,
    checksPassed: 1,
    checksTotal: 2,
    byCategory: { reasoning: { passed: 1, total: 2, score: 50 } },
    tokensPerSecond: 10,
    firstTokenMs: 100,
  },
  models: [
    {
      key: "test-model",
      label: "Test Model",
      kind: "tiny",
      fileName: "test.gguf",
      size: 1234,
      params: "1B",
      quant: "Q4",
      score: 50,
      checksPassed: 1,
      checksTotal: 2,
      tokensPerSecond: 10,
      firstTokenMs: 100,
      memoryBytes: 2048,
      gpuVram: 8192,
      byCategory: { reasoning: { passed: 1, total: 2, score: 50 } },
      prompts: [
        {
          id: "prompt-1",
          category: "reasoning",
          passed: 1,
          total: 2,
          text: "answer",
          stats: { tokensPerSecond: 10, firstTokenMs: 100 },
        },
      ],
    },
  ],
};

async function tempPaths(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    dbPath: path.join(directory, "history.sqlite"),
    historyPath: path.join(directory, "history.jsonl"),
  };
}

test("a run is recorded in SQLite and append-only JSONL, then linked to a commit", async (t) => {
  const paths = await tempPaths(t);
  const recorded = await recordRun({
    ...paths,
    result: RESULT,
    git: { hash: "abc123", subject: "parent", branch: "main", dirty: true },
    baseline: true,
    pending: true,
  });
  assert.ok(recorded.uid);

  let db = await openDatabase(paths.dbPath);
  try {
    const imported = await importHistory(db, paths.historyPath);
    assert.equal(imported.runs, 0); // recordRun already inserted it
    const runs = listRuns(db, 5);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].commit_hash, "abc123");
    assert.equal(runs[0].commit_pending, true);
    assert.equal(runs[0].baseline, true);
    assert.equal(runs[0].models[0].model_key, "test-model");
    assert.equal(runs[0].models[0].memory_bytes, 2048);
    assert.equal(runs[0].models[0].gpu_vram, 8192);
    assert.equal(runs[0].models[0].by_category.reasoning.score, 50);
    assert.equal(modelProgress(db, "test-model", 5).length, 1);
  } finally {
    db.close();
  }

  const linked = await linkRun({
    ...paths,
    commit: { hash: "def456", subject: "the change", branch: "main", dirty: false },
  });
  assert.equal(linked.linked, true);

  db = await openDatabase(paths.dbPath);
  try {
    const runs = listRuns(db, 5);
    assert.equal(runs[0].commit_hash, "def456");
    assert.equal(runs[0].commit_subject, "the change");
    assert.equal(runs[0].commit_pending, false);
  } finally {
    db.close();
  }

  const lines = (await readFile(paths.historyPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].type, "run");
  assert.equal(lines[1].type, "link");
  assert.equal(lines[1].commit.hash, "def456");
});

// Partial shard rows and batch-1 repro runs share the history as provenance,
// but trends, links and latest-checks stay on comparable standard runs.
test("run scopes label provenance without corrupting trends or links", async (t) => {
  const paths = await tempPaths(t);
  const git = { hash: "abc123", subject: "parent", branch: "main", dirty: true };
  const standard = await recordRun({ ...paths, result: RESULT, git, pending: true });
  const shard = await recordRun({
    ...paths,
    result: { ...RESULT, shard: { index: 1, total: 2, tag: "core" } },
    git,
    pending: true,
  });
  const repro = await recordRun({ ...paths, result: { ...RESULT, reproRun: true }, git, pending: true });

  const db = await openDatabase(paths.dbPath);
  try {
    const runs = listRuns(db, 10);
    assert.deepEqual(
      runs.map((run) => run.run_scope).sort(),
      ["repro", "shard", "standard"],
    );
    // Repro rows use batch 1, so per-model speed trends skip them; shard
    // rows measure the same settings, so they stay.
    assert.equal(modelProgress(db, "test-model", 10).length, 2);
    // Linking picks the latest comparable run, never a partial or repro row.
    const linked = await linkRun({
      dbPath: paths.dbPath,
      historyPath: paths.historyPath,
      commit: { hash: "def456", subject: "the change", branch: "main", dirty: false },
    });
  assert.equal(linked.linked, true);
  assert.equal(linked.run_scope, "standard");
    assert.equal(linked.uid, standard.uid);
    assert.notEqual(linked.uid, shard.uid);
    assert.notEqual(linked.uid, repro.uid);
  } finally {
    db.close();
  }
});

// Databases written before the scope column backfill from the stored JSON.
test("pre-scope history rows gain their scope on open", async (t) => {
  const paths = await tempPaths(t);
  await recordRun({
    ...paths,
    result: { ...RESULT, shard: { index: 2, total: 2, tag: "core" } },
    git: { hash: "abc123", subject: "parent", branch: "main", dirty: true },
  });
  // A pre-flag batch-1 repro run carries the marker on its variants only.
  await recordRun({
    ...paths,
    result: {
      ...RESULT,
      testHash: "repro-hash",
      models: [{ ...RESULT.models[0], key: "repro-model", deterministicRepro: true, batchSize: 1 }],
    },
    git: { hash: "abc123", subject: "parent", branch: "main", dirty: true },
  });
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(paths.dbPath);
  try {
    raw.exec("UPDATE runs SET run_scope = NULL");
  } finally {
    raw.close();
  }
  const db = await openDatabase(paths.dbPath);
  try {
    const runs = listRuns(db, 5);
    assert.equal(runs.find((run) => run.test_hash === "repro-hash").run_scope, "repro");
  } finally {
    db.close();
  }
});

// Batch-1 rows never join per-model speed trends, whatever their scope.
test("modelProgress skips batch-1 measurements", async (t) => {
  const paths = await tempPaths(t);
  const git = { hash: "abc123", subject: "parent", branch: "main", dirty: true };
  await recordRun({ ...paths, result: RESULT, git });
  await recordRun({
    ...paths,
    result: {
      ...RESULT,
      testHash: "repro-hash",
      models: [{ ...RESULT.models[0], deterministicRepro: true, batchSize: 1, tokensPerSecond: 999 }],
    },
    git,
  });
  const db = await openDatabase(paths.dbPath);
  try {
    const progress = modelProgress(db, "test-model", 10);
    assert.equal(progress.length, 1);
    assert.notEqual(progress[0].tokens_per_second, 999);
  } finally {
    db.close();
  }
});

test("history.sqlite can be rebuilt from the append-only log", async (t) => {
  const paths = await tempPaths(t);
  await recordRun({
    ...paths,
    result: RESULT,
    git: { hash: "abc123", subject: "parent", branch: "main", dirty: true },
    pending: true,
  });
  await linkRun({
    ...paths,
    commit: { hash: "def456", subject: "linked", branch: "main", dirty: false },
  });

  const db = await openDatabase(paths.dbPath);
  try {
    const rebuilt = await rebuildDatabase(db, paths.historyPath);
    assert.equal(rebuilt.runs, 1);
    assert.equal(rebuilt.links, 1);
    const runs = listRuns(db, 5);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].commit_hash, "def456");
    const again = await importHistory(db, paths.historyPath);
    assert.equal(again.runs, 0);
    assert.equal(listRuns(db, 5).length, 1);
  } finally {
    db.close();
  }
});

test("flash and single-model runs scope as provenance, never standard", async (t) => {
  assert.equal(deriveRunScope({ settings: { matrixScope: "core" } }), "standard");
  assert.equal(deriveRunScope({ settings: { matrixScope: "flash" } }), "flash");
  assert.equal(deriveRunScope({ settings: { matrixScope: "flash-core" } }), "flash");
  assert.equal(deriveRunScope({ settings: { matrixScope: "single:qwen2.5-0.5b-instruct-q4" } }), "single");
  assert.equal(deriveRunScope({ shard: { index: 1, total: 2, tag: "flash-core" }, settings: { matrixScope: "shard" } }), "flash");
  assert.equal(deriveRunScope({ shard: { index: 1, total: 2, tag: "single-abc" }, settings: { matrixScope: "shard" } }), "single");
  assert.equal(deriveRunScope({ shard: { index: 1, total: 2, tag: "core" }, settings: { matrixScope: "shard" } }), "shard");
  assert.equal(deriveRunScope({ settings: { matrixScope: "merged:flash-core:2" } }), "flash");
  assert.equal(deriveRunScope({ settings: { matrixScope: "merged:single-abc:2" } }), "single");
  assert.equal(deriveRunScope({ settings: { matrixScope: "merged:core:2" } }), "standard");

  const paths = await tempPaths(t);
  const git = { hash: "abc123", subject: "parent", branch: "main", dirty: true };
  const standard = await recordRun({ ...paths, result: RESULT, git, pending: true });
  await recordRun({ ...paths, result: { ...RESULT, settings: { matrixScope: "flash" } }, git, pending: true });
  await recordRun({ ...paths, result: { ...RESULT, settings: { matrixScope: "single:qwen2.5-0.5b-instruct-q4" } }, git, pending: true });
  const db = await openDatabase(paths.dbPath);
  try {
    const scopes = listRuns(db, 10).map((run) => run.run_scope).sort();
    assert.deepEqual(scopes, ["flash", "single", "standard"]);
    assert.equal(modelProgress(db, "test-model", 10).length, 1);
    const linked = await linkRun({
      dbPath: paths.dbPath,
      historyPath: paths.historyPath,
      commit: { hash: "def456", subject: "the change", branch: "main", dirty: false },
    });
    assert.equal(linked.linked, true);
    assert.equal(linked.run_scope, "standard");
    assert.equal(linked.uid, standard.uid);
  } finally {
    db.close();
  }
});
