import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS commits (
  hash TEXT PRIMARY KEY,
  subject TEXT,
  branch TEXT,
  committed_at TEXT,
  first_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  suite_version INTEGER NOT NULL,
  test_hash TEXT,
  app_version TEXT NOT NULL,
  runtime_version TEXT,
  prompt_fingerprint_version INTEGER,
  phase TEXT,
  commit_hash TEXT,
  commit_subject TEXT,
  commit_branch TEXT,
  commit_dirty INTEGER NOT NULL DEFAULT 0,
  commit_pending INTEGER NOT NULL DEFAULT 0,
  commit_linked_at TEXT,
  machine_cpu TEXT,
  machine_platform TEXT,
  context_size INTEGER,
  threads INTEGER,
  overall_score REAL,
  checks_passed INTEGER,
  checks_total INTEGER,
  tokens_per_second REAL,
  first_token_ms INTEGER,
  runtime_ms INTEGER,
  by_category_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS model_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uid TEXT NOT NULL REFERENCES runs(uid) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  variant_id TEXT,
  variant_label TEXT,
  label TEXT,
  kind TEXT,
  file_name TEXT,
  size INTEGER,
  params TEXT,
  quant TEXT,
  chat_template_hash TEXT,
  preset TEXT,
  kv_key_type TEXT,
  kv_value_type TEXT,
  flash_attention INTEGER,
  requested_context_size INTEGER,
  context_size INTEGER,
  threads INTEGER,
  max_threads INTEGER,
  batch_size INTEGER,
  sequences INTEGER,
  use_mmap TEXT,
  gpu_layers INTEGER,
  checkpoints INTEGER,
  score REAL,
  checks_passed INTEGER,
  checks_total INTEGER,
  tokens_per_second REAL,
  first_token_ms INTEGER,
  runtime_ms INTEGER,
  memory_bytes INTEGER,
  by_category_json TEXT NOT NULL,
  prompts_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_result_id INTEGER NOT NULL REFERENCES model_results(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL,
  label TEXT,
  category TEXT,
  passed INTEGER,
  total INTEGER,
  tokens_per_second REAL,
  first_token_ms INTEGER,
  manifest_digest TEXT,
  prompt_fingerprint TEXT,
  chat_template_hash TEXT,
  history_digest TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS runs_recorded_at ON runs(recorded_at);
CREATE INDEX IF NOT EXISTS runs_commit ON runs(commit_hash);
CREATE INDEX IF NOT EXISTS model_results_run ON model_results(run_uid);
CREATE INDEX IF NOT EXISTS model_results_key ON model_results(model_key);
CREATE INDEX IF NOT EXISTS prompt_results_model ON prompt_results(model_result_id);
`;

export function currentGitInfo(cwd = process.cwd()) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const hash = run(["rev-parse", "HEAD"]);
    const subject = run(["log", "-1", "--format=%s"]);
    const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
    const committedAt = run(["log", "-1", "--format=%cI"]);
    const dirty = run(["status", "--porcelain", "--untracked-files=no"]).length > 0;
    return { hash, subject, branch, committedAt, dirty };
  } catch {
    return { hash: null, subject: null, branch: null, committedAt: null, dirty: true };
  }
}

export async function openDatabase(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  ensureColumns(db, "model_results", [
    ["variant_id", "TEXT"],
    ["variant_label", "TEXT"],
    ["preset", "TEXT"],
    ["kv_key_type", "TEXT"],
    ["kv_value_type", "TEXT"],
    ["flash_attention", "INTEGER"],
    ["requested_context_size", "INTEGER"],
    ["context_size", "INTEGER"],
    ["threads", "INTEGER"],
    ["max_threads", "INTEGER"],
    ["batch_size", "INTEGER"],
    ["sequences", "INTEGER"],
    ["use_mmap", "TEXT"],
    ["gpu_layers", "INTEGER"],
    ["checkpoints", "INTEGER"],
    ["runtime_ms", "INTEGER"],
    ["chat_template_hash", "TEXT"],
  ]);
  ensureColumns(db, "prompt_results", [
    ["label", "TEXT"],
    ["manifest_digest", "TEXT"],
    ["prompt_fingerprint", "TEXT"],
    ["chat_template_hash", "TEXT"],
    ["history_digest", "TEXT"],
  ]);
  ensureColumns(db, "runs", [
    ["phase", "TEXT"],
    ["test_hash", "TEXT"],
    ["runtime_ms", "INTEGER"],
    ["runtime_version", "TEXT"],
    ["prompt_fingerprint_version", "INTEGER"],
    // Partial shard rows and batch-1 repro rows share the history with
    // canonical runs; the scope keeps trends and links on comparable data.
    ["run_scope", "TEXT"],
  ]);
  // Backfill scopes for databases written before the column existed. The
  // result JSON already carries the markers, so old shard and repro rows
  // are labeled without touching the append-only log. The models check
  // covers repro runs from before the top-level flag existed.
  db.exec(
    `UPDATE runs SET run_scope = CASE
       WHEN json_extract(result_json, '$.reproRun') IS NOT NULL
         AND json_extract(result_json, '$.reproRun') != 0 THEN 'repro'
       WHEN EXISTS (SELECT 1 FROM json_each(result_json, '$.models')
         WHERE json_extract(value, '$.deterministicRepro') = 1) THEN 'repro'
       WHEN json_extract(result_json, '$.shard') IS NOT NULL THEN 'shard'
       ELSE 'standard'
     END WHERE run_scope IS NULL AND json_valid(result_json)`,
  );
  return db;
}

function ensureColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

async function appendRecord(historyPath, record) {
  await mkdir(path.dirname(historyPath), { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(record)}\n`, "utf8");
}

function insertCommit(db, git, seenAt) {
  if (!git?.hash) return;
  db.prepare(
    `INSERT OR IGNORE INTO commits (hash, subject, branch, committed_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(git.hash, git.subject ?? null, git.branch ?? null, git.committedAt ?? null, seenAt);
}

function insertRun(db, record) {
  const result = record.result;
  const git = record.git ?? {};
  const existing = db.prepare("SELECT id FROM runs WHERE uid = ?").get(record.uid);
  if (existing) return { inserted: false, runId: Number(existing.id) };

  insertCommit(db, git, record.recordedAt);
  const scope = result.reproRun ? "repro" : result.shard ? "shard" : "standard";
  const info = db
    .prepare(
      `INSERT INTO runs (
        uid, recorded_at, suite_version, test_hash, app_version, runtime_version,
        prompt_fingerprint_version, phase, commit_hash, commit_subject,
        commit_branch, commit_dirty, commit_pending, machine_cpu, machine_platform,
        context_size, threads, overall_score, checks_passed, checks_total,
        tokens_per_second, first_token_ms, runtime_ms, by_category_json, result_json, baseline,
        run_scope
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.uid,
      record.recordedAt,
      Number(result.suiteVersion) || 0,
      result.testHash ?? null,
      String(result.appVersion ?? ""),
      result.runtime?.nodeLlamaCpp ?? null,
      Number(result.runtime?.promptFingerprintVersion) || null,
      result.phase ?? null,
      git.hash ?? null,
      git.subject ?? null,
      git.branch ?? null,
      git.dirty ? 1 : 0,
      record.pending ? 1 : 0,
      result.machine?.cpu ?? null,
      result.machine?.platform ?? null,
      Number(result.settings?.contextSize) || null,
      Number(result.settings?.threads) || null,
      Number(result.overall?.score) || 0,
      Number(result.overall?.checksPassed) || 0,
      Number(result.overall?.checksTotal) || 0,
      Number(result.overall?.tokensPerSecond) || 0,
      Number(result.overall?.firstTokenMs) || 0,
      Number(result.runtimeMs) || 0,
      JSON.stringify(result.overall?.byCategory ?? {}),
      JSON.stringify(result),
      record.baseline ? 1 : 0,
      scope,
    );
  const runId = Number(info.lastInsertRowid);

  for (const model of result.models ?? []) {
    const modelInfo = db
      .prepare(
        `INSERT INTO model_results (
          run_uid, model_key, variant_id, variant_label, label, kind, file_name, size,
          params, quant, chat_template_hash, preset, kv_key_type, kv_value_type, flash_attention,
          requested_context_size, context_size, threads, max_threads, batch_size, sequences,
          use_mmap, gpu_layers, checkpoints, runtime_ms, score, checks_passed,
          checks_total, tokens_per_second, first_token_ms, memory_bytes,
          by_category_json, prompts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.uid,
        model.key ?? model.modelId ?? model.label,
        model.variantId ?? null,
        model.variantLabel ?? model.label ?? null,
        model.label ?? null,
        model.kind ?? null,
        model.fileName ?? null,
        Number(model.size) || null,
        model.params ?? null,
        model.quant ?? null,
        model.chatTemplateHash ?? null,
        model.preset ?? null,
        model.kvCache ?? null,
        model.kvCache ?? null,
        model.kvCache && model.kvCache !== "f16" ? 1 : 0,
        Number(model.requestedContextSize) || Number(model.contextSize) || null,
        Number(model.contextSize) || null,
        Number(model.threads) || null,
        Number(model.maxThreads) || null,
        Number(model.batchSize) || null,
        Number(model.sequences) || null,
        model.useMmap ?? null,
        Number(model.gpuLayers) || null,
        model.checkpoints === false ? 0 : 1,
        Number(model.runtimeMs) || 0,
        Number(model.score) || 0,
        Number(model.checksPassed) || 0,
        Number(model.checksTotal) || 0,
        Number(model.tokensPerSecond) || 0,
        Number(model.firstTokenMs) || 0,
        Number(model.memoryBytes) || null,
        JSON.stringify(model.byCategory ?? {}),
        JSON.stringify(model.prompts ?? []),
      );
    const modelResultId = Number(modelInfo.lastInsertRowid);
    for (const prompt of model.prompts ?? []) {
      db.prepare(
        `INSERT INTO prompt_results (
          model_result_id, prompt_id, label, category, passed, total, tokens_per_second,
          first_token_ms, manifest_digest, prompt_fingerprint, chat_template_hash,
          history_digest, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        modelResultId,
        prompt.id,
        prompt.label ?? null,
        prompt.category ?? null,
        Number(prompt.passed) || 0,
        Number(prompt.total) || 0,
        Number(prompt.stats?.tokensPerSecond) || 0,
        Number(prompt.stats?.firstTokenMs) || 0,
        prompt.manifest?.digest ?? null,
        prompt.manifest?.promptDigest ?? null,
        prompt.manifest?.chatTemplateHash ?? model.chatTemplateHash ?? null,
        prompt.manifest?.historyDigest ?? null,
        String(prompt.text ?? "").slice(0, 4000),
      );
    }
  }
  return { inserted: true, runId };
}

function applyLink(db, link) {
  const target = db.prepare("SELECT id FROM runs WHERE uid = ?").get(link.runUid);
  if (!target) return false;
  insertCommit(db, link.commit, link.linkedAt);
  db.prepare(
    `UPDATE runs
     SET commit_hash = ?, commit_subject = ?, commit_branch = ?, commit_dirty = 0,
         commit_pending = 0, commit_linked_at = ?
     WHERE uid = ? AND commit_linked_at IS NULL`,
  ).run(
    link.commit.hash,
    link.commit.subject ?? null,
    link.commit.branch ?? null,
    link.linkedAt,
    link.runUid,
  );
  return true;
}

export async function importHistory(db, historyPath, logger = console) {
  let text;
  try {
    text = await readFile(historyPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { runs: 0, links: 0 };
    throw error;
  }
  let runs = 0;
  let links = 0;
  const pendingLinks = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      logger.warn?.("[bench] Skipped a damaged history line.");
      continue;
    }
    if (record.type === "run") {
      const inserted = insertRun(db, record);
      if (inserted.inserted) runs += 1;
    } else if (record.type === "link") {
      pendingLinks.push(record);
    }
  }
  for (const link of pendingLinks) {
    if (applyLink(db, link)) links += 1;
  }
  return { runs, links };
}

export async function recordRun({
  dbPath,
  historyPath,
  result,
  git = null,
  baseline = false,
  pending = null,
  logger = console,
}) {
  const uid = randomUUID();
  const recordedAt = result.finishedAt || result.createdAt || new Date().toISOString();
  const record = {
    type: "run",
    uid,
    recordedAt,
    baseline: Boolean(baseline),
    pending: pending === null ? Boolean(git?.dirty) : Boolean(pending),
    git: git ?? {},
    result,
  };
  await appendRecord(historyPath, record);

  let db = null;
  try {
    db = await openDatabase(dbPath);
    const inserted = insertRun(db, record);
    return { uid, runId: inserted.runId, recordedAt };
  } catch (error) {
    logger.warn?.(`[bench] SQLite history unavailable (${error.message}); JSONL history was still written.`);
    return { uid, runId: null, recordedAt };
  } finally {
    db?.close();
  }
}

export async function linkRun({ dbPath, historyPath, uid = null, commit, linkedAt = new Date().toISOString(), logger = console }) {
  const db = await openDatabase(dbPath);
  try {
    await importHistory(db, historyPath, logger);
    let target = uid;
    if (!target) {
      // Only a complete, comparable run links to a commit: partial shards
      // and batch-1 repro rows stay visible as provenance, never as the
      // commit's benchmark.
      const latest = db
        .prepare("SELECT uid FROM runs WHERE commit_pending = 1 AND run_scope = 'standard' ORDER BY recorded_at DESC, id DESC LIMIT 1")
        .get();
      target = latest?.uid ?? null;
    }
    if (!target) {
      return { linked: false, reason: "No pending benchmark run. Run npm run bench first." };
    }
    const link = {
      type: "link",
      runUid: target,
      linkedAt,
      commit,
    };
    await appendRecord(historyPath, link);
    applyLink(db, link);
    const scope = db.prepare("SELECT run_scope FROM runs WHERE uid = ?").get(target)?.run_scope ?? null;
    return { linked: true, uid: target, commit, runScope: scope };
  } finally {
    db.close();
  }
}

export function listRuns(db, limit = 20) {
  const runs = db
    .prepare(
      `SELECT id, uid, recorded_at, suite_version, test_hash, app_version, phase, commit_hash, commit_subject,
              commit_branch, commit_dirty, commit_pending, commit_linked_at, machine_cpu,
              context_size, threads, overall_score, checks_passed, checks_total,
              tokens_per_second, first_token_ms, runtime_ms, by_category_json, baseline, run_scope
       FROM runs ORDER BY recorded_at DESC, id DESC LIMIT ?`,
    )
    .all(limit);
  return runs.map((run) => ({
    ...run,
    id: Number(run.id),
    commit_dirty: Boolean(run.commit_dirty),
    commit_pending: Boolean(run.commit_pending),
    baseline: Boolean(run.baseline),
    by_category: JSON.parse(run.by_category_json),
    models: db
      .prepare(
        `SELECT model_key, variant_id, variant_label, label, kind, file_name, size, params,
                quant, preset, kv_key_type, kv_value_type, flash_attention, requested_context_size,
                context_size, threads, max_threads, batch_size, sequences, use_mmap,
                gpu_layers, checkpoints, runtime_ms, score, checks_passed, checks_total,
                tokens_per_second, first_token_ms, memory_bytes, by_category_json
         FROM model_results WHERE run_uid = ? ORDER BY model_key, variant_id`,
      )
      .all(run.uid)
      .map((model) => ({
        ...model,
        id: undefined,
        by_category: JSON.parse(model.by_category_json),
      })),
  }));
}

export function modelProgress(db, modelKey, limit = 20) {
  return db
    .prepare(
      `SELECT r.recorded_at, r.commit_hash, r.commit_subject, r.commit_pending,
              m.model_key, m.variant_id, m.variant_label, m.label, m.kv_key_type,
              m.context_size, m.threads, m.score, m.tokens_per_second, m.first_token_ms,
              m.memory_bytes
       FROM model_results m JOIN runs r ON r.uid = m.run_uid
       WHERE m.model_key = ? AND (r.run_scope = 'standard' OR r.run_scope = 'shard')
         AND (m.batch_size IS NULL OR m.batch_size <> 1)
       ORDER BY r.recorded_at DESC, r.id DESC LIMIT ?`,
    )
    .all(modelKey, limit)
    .map((row) => ({ ...row, commit_pending: Boolean(row.commit_pending) }));
}

export function testResults(db, runUid) {
  return db
    .prepare(
      `SELECT pr.prompt_id, pr.label, pr.category,
              SUM(pr.passed) AS passed, SUM(pr.total) AS total
       FROM prompt_results pr
       JOIN model_results m ON m.id = pr.model_result_id
       WHERE m.run_uid = ?
       GROUP BY pr.prompt_id, pr.label, pr.category
       ORDER BY pr.prompt_id`,
    )
    .all(runUid)
    .map((row) => ({
      ...row,
      passed: Number(row.passed) || 0,
      total: Number(row.total) || 0,
      percent: Number(row.total) ? Number(((Number(row.passed) / Number(row.total)) * 100).toFixed(1)) : 0,
    }));
}

export function historyStats(db) {
  const runs = db.prepare("SELECT COUNT(*) AS count FROM runs").get();
  const commits = db.prepare("SELECT COUNT(*) AS count FROM commits").get();
  return { runs: Number(runs.count), commits: Number(commits.count) };
}

export function rebuildDatabase(db, historyPath, logger = console) {
  db.exec("DELETE FROM prompt_results; DELETE FROM model_results; DELETE FROM runs; DELETE FROM commits;");
  return importHistory(db, historyPath, logger);
}
