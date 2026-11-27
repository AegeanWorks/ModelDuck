import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  currentGitInfo,
  deriveRunScope,
  historyImportStats,
  importHistory,
  linkRun,
  listRuns,
  modelProgress,
  modelsProgress,
  openDatabase,
  rebuildDatabase,
  recordRun,
  runScopeBackfillCount,
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

test("a failed SQLite run rolls back every row while JSONL keeps the record", async (t) => {
  const paths = await tempPaths(t);
  const broken = {
    ...RESULT,
    models: [{
      ...RESULT.models[0],
      prompts: [{ ...RESULT.models[0].prompts[0], id: null }],
    }],
  };
  const recorded = await recordRun({
    ...paths,
    result: broken,
    git: { hash: "abc123", subject: "parent", branch: "main", dirty: false },
    logger: { warn() {} },
  });
  assert.equal(recorded.runId, null, "the SQLite failure uses the existing JSONL fallback");
  const lines = (await readFile(paths.historyPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1, "the append-only record is still durable");

  const db = await openDatabase(paths.dbPath);
  try {
    const counts = db.prepare(
      "SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM commits) AS commits, " +
      "(SELECT COUNT(*) FROM model_results) AS models, (SELECT COUNT(*) FROM prompt_results) AS prompts",
    ).get();
    assert.deepEqual({ ...counts }, { runs: 0, commits: 0, models: 0, prompts: 0 });
  } finally {
    db.close();
  }
});

test("a failed history import rolls back the whole batch", async (t) => {
  const paths = await tempPaths(t);
  const base = {
    type: "run",
    recordedAt: "2026-11-24T00:00:00.000Z",
    baseline: false,
    pending: false,
    git: { hash: "abc123", subject: "parent", branch: "main", dirty: false },
  };
  const broken = {
    ...RESULT,
    models: [{
      ...RESULT.models[0],
      prompts: [{ ...RESULT.models[0].prompts[0], id: null }],
    }],
  };
  await writeFile(paths.historyPath, `${JSON.stringify({ ...base, uid: "good", result: RESULT })}\n${JSON.stringify({ ...base, uid: "bad", result: broken })}\n`);
  const db = await openDatabase(paths.dbPath);
  try {
    await assert.rejects(importHistory(db, paths.historyPath, { warn() {} }), /NOT NULL/);
    const counts = db.prepare(
      "SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM commits) AS commits, " +
      "(SELECT COUNT(*) FROM model_results) AS models, (SELECT COUNT(*) FROM prompt_results) AS prompts",
    ).get();
    assert.deepEqual({ ...counts }, { runs: 0, commits: 0, models: 0, prompts: 0 });
  } finally {
    db.close();
  }
});

test("listRuns fetches every selected run's models in one grouped query", async (t) => {
  const paths = await tempPaths(t);
  await recordRun({ ...paths, result: RESULT, git: { hash: "abc123", subject: "first", branch: "main" } });
  await recordRun({
    ...paths,
    result: {
      ...RESULT,
      models: [
        { ...RESULT.models[0], key: "z-model", label: "Z model" },
        { ...RESULT.models[0], key: "a-model", label: "A model" },
      ],
    },
    git: { hash: "abc123", subject: "second", branch: "main" },
  });
  const db = await openDatabase(paths.dbPath);
  try {
    const prepare = db.prepare.bind(db);
    let queries = 0;
    const counted = { prepare(sql) { queries += 1; return prepare(sql); } };
    const runs = listRuns(counted, 10);
    assert.equal(queries, 2, "one run query and one model query serve every row");
    assert.deepEqual(runs[0].models.map((model) => model.model_key), ["a-model", "z-model"]);
    assert.deepEqual(runs[1].models.map((model) => model.model_key), ["test-model"]);
  } finally {
    db.close();
  }
});

test("modelsProgress fetches every key's newest rows in one bounded query", async (t) => {
  const paths = await tempPaths(t);
  for (let i = 0; i < 3; i += 1) {
    await recordRun({
      ...paths,
      result: {
        ...RESULT,
        models: [
          { ...RESULT.models[0], key: "a-model", tokensPerSecond: 10 + i },
          { ...RESULT.models[0], key: "z-model", tokensPerSecond: 20 + i },
        ],
        ...(i === 0 ? { reproRun: true } : {}),
      },
      git: { hash: "abc123", subject: `run ${i}`, branch: "main" },
    });
  }
  const db = await openDatabase(paths.dbPath);
  try {
    const prepare = db.prepare.bind(db);
    let queries = 0;
    const counted = { prepare(sql) { queries += 1; return prepare(sql); } };
    const grouped = modelsProgress(counted, ["a-model", "z-model"], 1);
    assert.equal(queries, 1, "one windowed query serves every model key");
    assert.deepEqual(grouped.get("a-model"), modelProgress(db, "a-model", 1));
    assert.deepEqual(grouped.get("z-model"), modelProgress(db, "z-model", 1));
    assert.equal(grouped.get("a-model")[0].tokens_per_second, 12, "the newest non-repro row wins");
  } finally {
    db.close();
  }
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

test("the run-scope backfill is persisted and skipped on later opens", async (t) => {
  const paths = await tempPaths(t);
  await recordRun({ ...paths, result: RESULT, git: { hash: "abc123", subject: "parent", branch: "main" } });
  const before = runScopeBackfillCount();
  const db = await openDatabase(paths.dbPath);
  try {
    assert.equal(runScopeBackfillCount(), before, "an already migrated database does not backfill again");
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
    raw.exec("DELETE FROM migrations WHERE name = 'run_scope_backfill_v1'");
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

function gitInfoRunner(outputs, calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    if (file !== "git" || !(args[0] in outputs)) throw new Error(`unexpected git call: ${args.join(" ")}`);
    return outputs[args[0]];
  };
}

test("currentGitInfo reads commit metadata and status in two Git calls", () => {
  const calls = [];
  const run = gitInfoRunner({
    log: "abc123\u0000A useful subject\u00002026-11-24T12:34:56+03:00\n",
    status: "## main...origin/main [ahead 1]\n M src/app.js\n",
  }, calls);
  assert.deepEqual(currentGitInfo("C:/repo", "HEAD", run), {
    hash: "abc123",
    subject: "A useful subject",
    branch: "main",
    committedAt: "2026-11-24T12:34:56+03:00",
    dirty: true,
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ["log", "-1", "--format=%H%x00%s%x00%cI", "HEAD"],
    ["status", "--porcelain=v1", "--branch", "--untracked-files=no"],
  ]);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[1].options.timeout, 5000);
});

test("currentGitInfo preserves detached HEAD, clean status and explicit refs", () => {
  const calls = [];
  const run = gitInfoRunner({
    log: "def456\u0000Earlier commit\u00002026-11-23T10:00:00Z\n",
    status: "## HEAD (no branch)\n",
  }, calls);
  assert.deepEqual(currentGitInfo("C:/repo", "HEAD^", run), {
    hash: "def456",
    subject: "Earlier commit",
    branch: "HEAD",
    committedAt: "2026-11-23T10:00:00Z",
    dirty: false,
  });
  assert.equal(calls[0].args.at(-1), "HEAD^");
  assert.ok(calls[1].args.includes("--untracked-files=no"), "untracked-only files do not mark the tree dirty");
});

test("currentGitInfo keeps its all-null fallback when Git fails", () => {
  const calls = [];
  const run = gitInfoRunner({}, calls);
  assert.deepEqual(currentGitInfo("C:/not-a-repo", "HEAD", run), {
    hash: null,
    subject: null,
    branch: null,
    committedAt: null,
    dirty: true,
  });
  assert.equal(calls.length, 1, "a failed first command does not launch more processes");
});

test("importHistory parses only appended history bytes after the first import", async (t) => {
  const paths = await tempPaths(t);
  const git = { hash: "abc123", subject: "parent", branch: "main", dirty: false };
  await recordRun({ ...paths, result: RESULT, git });
  let db = await openDatabase(paths.dbPath);
  try {
    await importHistory(db, paths.historyPath);
  } finally {
    db.close();
  }
  const importedBytes = (await readFile(paths.historyPath)).length;
  await recordRun({ ...paths, result: { ...RESULT, finishedAt: "2026-10-30T10:02:00.000Z" }, git: { ...git, hash: "def456" } });
  const fullBytes = (await readFile(paths.historyPath)).length;
  const appendedBytes = fullBytes - importedBytes;
  const before = historyImportStats().bytesParsed;
  db = await openDatabase(paths.dbPath);
  try {
    const imported = await importHistory(db, paths.historyPath);
    assert.equal(imported.runs, 0, "recordRun already inserted the appended row");
  } finally {
    db.close();
  }
  const parsed = historyImportStats().bytesParsed - before;
  assert.equal(parsed, appendedBytes, "only the appended line was parsed");
});
