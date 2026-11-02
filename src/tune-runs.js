import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { AppError } from "./errors.js";
import { ensureDirectory, readJsonWithQuarantine, writeJsonAtomic } from "./fs-atomic.js";

/**
 * A record of every tune run (ADR-050): `<id>.json` holds what was asked, the
 * machine and suite, the outcome, the run's decisions and the resulting presets,
 * rewritten atomically as the run goes; `<id>.answers.jsonl` holds every answer,
 * appended as it comes, so a stopped run keeps everything it measured. Nothing
 * is deleted automatically.
 */

const RUN_SCHEMA = 1;
const ID_PATTERN = /^[0-9A-Za-z-]+$/;

const quiet = { warn() {} };

function checkedId(id) {
  if (typeof id === "string" && ID_PATTERN.test(id)) return id;
  throw new AppError("Unknown tune run", {
    code: "tune_run_bad_id",
    status: 400,
    why: `"${id}" is not a tune run id.`,
    fix: "Pick a run from the list of tune runs.",
  });
}

const summaryFile = (dir, id) => path.join(dir, `${checkedId(id)}.json`);

/** Where a run's answers are kept, one JSON object per line. */
export function answersFile(dir, id) {
  return path.join(dir, `${checkedId(id)}.answers.jsonl`);
}

function isAliveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// While answers arrive, the summary's count and time are saved at most this often.
const ANSWER_SAVE_MS = 15_000;

/** Start recording a run; the recorder keeps the summary and appends answers as they come. */
export async function startRun(dir, { profileId, model, request, fingerprint = null, expectedAnswers = null, now = new Date(), pid = process.pid, clock = Date.now }) {
  await ensureDirectory(dir);
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${pid}`;
  let record = {
    schema: RUN_SCHEMA,
    id,
    pid,
    profileId,
    model,
    request,
    fingerprint,
    expectedAnswers,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    durationMs: null,
    outcome: "running",
    error: null,
    answers: 0,
  };
  const save = () => writeJsonAtomic(summaryFile(dir, id), record);
  await save();
  let savedAt = clock();
  // Writes go one after another, so a slow disk never reorders a summary.
  let queue = Promise.resolve();
  const later = (work) => (queue = queue.then(work, work));
  return {
    id,
    answers: (rows) => later(async () => {
      if (!rows.length) return;
      await fs.promises.appendFile(answersFile(dir, id), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
      // Keep the count and time current, so a run stopped inside a long setting still shows them.
      record = { ...record, answers: record.answers + rows.length, updatedAt: new Date(clock()).toISOString() };
      if (clock() - savedAt >= ANSWER_SAVE_MS) {
        savedAt = clock();
        await save();
      }
    }),
    update: (patch) => later(() => {
      record = { ...record, ...patch, updatedAt: new Date().toISOString() };
      return save();
    }),
    finish: ({ outcome, error = null, now: ended = new Date(), ...patch }) => later(() => {
      record = { ...record, ...patch, outcome, error, finishedAt: ended.toISOString(), updatedAt: ended.toISOString(), durationMs: ended - new Date(record.startedAt) };
      return save();
    }),
  };
}

/** A run as shown: interrupted when its process died while running, and with its time so far when unfinished. */
function present(record, isAlive) {
  const shown = { ...record };
  if (shown.outcome === "running" && !isAlive(shown.pid)) shown.outcome = "interrupted";
  shown.durationMs ??= Date.parse(shown.updatedAt) - Date.parse(shown.startedAt);
  return shown;
}

/** A saved run with all its details, or null when there is none. */
export async function loadRun(dir, id, { isAlive = isAliveDefault } = {}) {
  const record = await readJsonWithQuarantine(summaryFile(dir, id), null, { logger: quiet });
  return record ? present(record, isAlive) : null;
}

const median = (sorted) => percentile(sorted, 0.5);

/**
 * Recent measured pace per model, from completed or stopped runs: seconds of
 * whole-run time per answer. The run summary already has the duration and
 * answer count, so this does not open the answer files. The latest three runs
 * per model give a median and a low/high range for the preflight.
 */
export async function answerPaceByProfile(dir, { perProfile = 3 } = {}) {
  const runs = await listRuns(dir);
  const samples = new Map();
  for (const run of runs) {
    if (!run.profileId || !(run.answers > 0) || !(run.durationMs > 0)) continue;
    if (!["done", "stopped", "interrupted"].includes(run.outcome)) continue;
    const seconds = run.durationMs / 1000 / run.answers;
    if (!(seconds >= 0.05 && seconds <= 300)) continue;
    const list = samples.get(run.profileId) ?? [];
    if (list.length >= perProfile) continue;
    list.push(seconds);
    samples.set(run.profileId, list);
  }
  return new Map([...samples].map(([profileId, list]) => {
    const sorted = [...list].sort((left, right) => left - right);
    return [profileId, {
      secondsPerAnswer: Math.round(median(sorted) * 1000) / 1000,
      low: Math.round(sorted[0] * 1000) / 1000,
      high: Math.round(sorted.at(-1) * 1000) / 1000,
      samples: sorted.length,
    }];
  }));
}

/** Every saved run without its details, newest first; one left running by a process that has died is "interrupted". */
export async function listRuns(dir, { isAlive = isAliveDefault } = {}) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  const runs = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const record = await readJsonWithQuarantine(path.join(dir, name), null, { logger: quiet });
    if (record?.schema !== RUN_SCHEMA) continue;
    const { sweeps: _sweeps, result: _result, ...summary } = record;
    runs.push(present(summary, isAlive));
  }
  return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** Nearest-rank percentile of sorted numbers: the median of ten is the fifth. */
const percentile = (sorted, share) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];

/**
 * A run's answers in a few numbers, read line by line so a large run never loads at once:
 * how many, the share of checks passed, errors, median and 90th-percentile time, tokens.
 */
export async function summarizeAnswers(dir, id) {
  const file = answersFile(dir, id);
  const times = [];
  let answers = 0;
  let passed = 0;
  let total = 0;
  let errors = 0;
  let wrong = 0;
  let unreadable = 0;
  const unreadableExamples = [];
  let tokens = 0;
  let counted = 0;
  try {
    const lines = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a line cut off by a crash
      }
      answers += 1;
      passed += Number(row.passed) || 0;
      total += Number(row.total) || 0;
      if (row.error) errors += 1;
      else if (row.unreadable) {
        unreadable += 1;
        // A few to look at, so a format problem can be seen, not only counted.
        if (unreadableExamples.length < 5) unreadableExamples.push({ item: row.item, text: String(row.text ?? "").slice(0, 200) });
      }
      else if ((Number(row.passed) || 0) < (Number(row.total) || 0)) wrong += 1;
      if (Number.isFinite(row.ms)) times.push(row.ms);
      if (Number.isFinite(row.outputTokens)) {
        tokens += row.outputTokens;
        counted += 1;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  times.sort((left, right) => left - right);
  return {
    answers,
    right: total ? Math.round((passed / total) * 1000) / 10 : null,
    errors,
    wrong,
    unreadable,
    unreadableExamples,
    ms: times.length ? { median: percentile(times, 0.5), p90: percentile(times, 0.9) } : null,
    outputTokens: counted ? { mean: Math.round((tokens / counted) * 10) / 10 } : null,
  };
}

/**
 * Per-item outcomes from every saved run of one model: how often each item was
 * right or wrong, ignoring errors. `saturated` holds the items no recorded
 * setting has ever flipped (all right or all wrong after a minimum of looks
 * across at least two distinct settings), which a tune leaves out of its
 * search (ADR-064, S6). Runs from another suite, runtime or tuner version do
 * not count: a format fix can unstick an item.
 */
const OUTCOME_FINGERPRINT_KEYS = Object.freeze(["suiteVersion", "taskHash", "nodeLlamaCpp", "tunerVersion"]);

/**
 * Saved answers grouped for a measurement-cache prefill (G8): the most recent
 * runs of one model, filtered like the saturation counts, grouped by exact
 * settings and seed. A continue or re-tune reuses these instead of re-asking;
 * `answers.jsonl` already holds settings, seed and item for every answer.
 */
export async function cachedAnswers(dir, { profileId, fingerprint = null, limitRuns = 3, limitRows = 20000 } = {}) {
  const FINGERPRINT_KEYS = ["suiteVersion", "taskHash", "nodeLlamaCpp", "tunerVersion"];
  const names = await fs.promises.readdir(dir).catch(() => []);
  const runs = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const record = await readJsonWithQuarantine(path.join(dir, name), null, { logger: quiet });
    if (record?.schema !== RUN_SCHEMA) continue;
    if (profileId && record.profileId !== profileId) continue;
    if (fingerprint && FINGERPRINT_KEYS.some((key) => record.fingerprint?.[key] !== fingerprint[key])) continue;
    runs.push({ name: name.slice(0, -5), startedAt: record.startedAt ?? "" });
  }
  runs.sort((left, right) => (left.startedAt < right.startedAt ? 1 : -1));
  const groups = new Map();
  let rows = 0;
  for (const run of runs.slice(0, limitRuns)) {
    let file;
    try {
      file = answersFile(dir, run.name);
    } catch {
      continue;
    }
    try {
      const lines = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || !row.item || row.error) continue;
        if (rows >= limitRows) break;
        rows += 1;
        const key = `${JSON.stringify(row.settings ?? null)}|${row.seed}`;
        const group = groups.get(key) ?? { settings: row.settings ?? {}, seed: row.seed, rows: [] };
        group.rows.push(row);
        groups.set(key, group);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (rows >= limitRows) break;
  }
  return [...groups.values()];
}

export async function itemOutcomes(dir, { profileId, minObservations = 6, minSettings = 2, fingerprint = null } = {}) {
  const names = await fs.promises.readdir(dir).catch(() => []);
  const counts = new Map();
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const record = await readJsonWithQuarantine(path.join(dir, name), null, { logger: quiet });
    if (record?.schema !== RUN_SCHEMA) continue;
    if (profileId && record.profileId !== profileId) continue;
    if (fingerprint && OUTCOME_FINGERPRINT_KEYS.some((key) => record.fingerprint?.[key] !== fingerprint[key])) continue;
    let file;
    try {
      file = answersFile(dir, name.slice(0, -5));
    } catch {
      continue; // a file name that cannot be a run id
    }
    try {
      const lines = createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // a line cut off by a crash
        }
        const total = Number(row.total) || 0;
        if (row.error || !row.item || !(total > 0)) continue;
        const entry = counts.get(row.item) ?? { right: 0, wrong: 0, settings: new Set() };
        if ((Number(row.passed) || 0) >= total) entry.right += 1;
        else entry.wrong += 1;
        // Greedy load-stage repeats of one setting must not saturate an item (S6).
        try {
          const key = JSON.stringify(row.settings ?? null);
          if (entry.settings.size < 16) entry.settings.add(key);
        } catch {
          // unstringifiable settings still count as a look, just not a new setting
        }
        counts.set(row.item, entry);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const saturated = new Set();
  const totals = {};
  for (const [id, entry] of counts) {
    const seen = entry.right + entry.wrong;
    if (seen >= minObservations && entry.settings.size >= minSettings && (entry.right === 0 || entry.wrong === 0)) saturated.add(id);
    totals[id] = { right: entry.right, wrong: entry.wrong, seen, settings: entry.settings.size };
  }
  return { saturated, counts: totals };
}
