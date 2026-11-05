import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentGitInfo, recordRun } from "./history.mjs";
import { modelMatrix, modelMatrixFor, buildChatMatrix, flashMatrix } from "./matrix.mjs";
import { itemSummary, promptDataset, promptOrigin } from "./stats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, "results");

const USAGE = `Usage: node benchmarks/merge-shards.mjs --phase <model|chat> --total <n> [--tag <scope>] [--out <file>]

Merges per-shard bench outputs (one \`latest-shard-i-of-n-<phase>-<tag>.json\`
per segment from \`run.mjs --shard i/n\`) into a single combined result so
parallel "multiple models at once at different segments" runs finish ASAP
and still produce one report. Refuses to merge mismatched suites/hashes,
runtimes, or run settings. Writes results/latest-<phase>.json (plus
results/latest.json) and records history.

The tag is printed by each shard run (core, full, flash, single-<id>, chat,
..., each optionally suffixed with -repro). When shards were --full-matrix,
--flash, or --deterministic, pass the same tag here so the merge picks up
the right files; without --tag every matching tag group must agree on
exactly one tag. Merging deterministic shards keeps the repro scope: the
output goes to results/latest-repro-<phase>-<tag>.json and never touches the
shared latest files.
`;

function parseArgs(argv) {
  const options = { phase: "model", total: null, tag: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--phase") options.phase = argv[++i];
    else if (arg.startsWith("--phase=")) options.phase = arg.split("=").slice(1).join("=");
    else if (arg === "--total") options.total = Number(argv[++i]);
    else if (arg.startsWith("--total=")) options.total = Number(arg.split("=")[1]);
    else if (arg === "--tag") options.tag = argv[++i];
    else if (arg.startsWith("--tag=")) options.tag = arg.split("=").slice(1).join("=");
    else if (arg === "--out") options.out = argv[++i];
    else if (arg.startsWith("--out=")) options.out = arg.split("=").slice(1).join("=");
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  return options;
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function categoryScores(prompts) {
  const categories = {};
  for (const prompt of prompts) {
    const category = prompt.category || "other";
    categories[category] ??= { passed: 0, total: 0 };
    categories[category].passed += prompt.passed;
    categories[category].total += prompt.total;
  }
  return Object.fromEntries(
    Object.entries(categories).map(([category, value]) => [
      category,
      { ...value, score: value.total ? Number(((value.passed / value.total) * 100).toFixed(1)) : 0 },
    ]),
  );
}

function shardFilePattern(index, total, phase) {
  return new RegExp(`^latest-shard-${index}-of-${total}-${phase}-(.+)\\.json$`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }
  if (!["model", "chat"].includes(options.phase)) throw new Error(`Bad --phase ${options.phase}; use model or chat.`);
  if (!Number.isInteger(options.total) || options.total < 2) throw new Error(`Bad --total ${options.total}; merging needs at least 2 shards.`);

  const files = await readdir(RESULTS_DIR).catch(() => []);
  const shards = [];
  for (let i = 1; i <= options.total; i += 1) {
    const pattern = shardFilePattern(i, options.total, options.phase);
    const matches = files.filter((name) => pattern.test(name));
    if (!matches.length) {
      throw new Error(`Missing shard file latest-shard-${i}-of-${options.total}-${options.phase}-<tag>.json. Run every shard first: npm run bench -- --shard ${i}/${options.total}.`);
    }
    const tags = [...new Set(matches.map((name) => name.match(pattern)[1]))].sort();
    const tag = options.tag ?? (tags.length === 1 ? tags[0] : null);
    if (!tag) {
      throw new Error(`Shard ${i} has several scopes (${tags.join(", ")}); pass --tag to choose one.`);
    }
    if (options.tag && !tags.includes(options.tag)) {
      throw new Error(`Shard ${i} has no --tag ${options.tag} (found: ${tags.join(", ")}); run that shard scope first.`);
    }
    const file = path.join(RESULTS_DIR, `latest-shard-${i}-of-${options.total}-${options.phase}-${tag}.json`);
    try {
      shards.push({ file, tag, result: JSON.parse(await readFile(file, "utf8")) });
    } catch (error) {
      throw new Error(`Cannot read shard file ${file} (${error?.code ?? error?.message}).`);
    }
  }

  const [first] = shards;
  const same = (pick, label) => {
    const want = JSON.stringify(pick(first.result));
    for (const { file, result } of shards) {
      if (JSON.stringify(pick(result)) !== want) {
        throw new Error(`${file}: ${label} differs between shards; shards must come from identical runs (same flags, runtime, and git).`);
      }
    }
  };
  for (const { file, result } of shards) {
    if (result.phase !== options.phase) throw new Error(`${file}: phase ${result.phase} != ${options.phase}.`);
    if (result.suiteVersion !== first.result.suiteVersion) throw new Error(`${file}: suite v${result.suiteVersion} != v${first.result.suiteVersion}.`);
    if (result.testHash !== first.result.testHash) throw new Error(`${file}: test hash differs; shards must come from the same matrix. Delete stale shard files and rerun.`);
  }
  // Runtime, app, run flags, and chat base must agree: shards ran the same
  // experiment on different machines, not different experiments.
  same((result) => result.runtime, "runtime");
  same((result) => result.appVersion, "appVersion");
  same((result) => result.settings?.contextSizeOverride ?? null, "context-size override");
  same((result) => result.settings?.threadsOverride ?? null, "threads override");
  same((result) => result.settings?.chatBase ?? null, "chat base");

  const seen = new Map();
  for (const { file, result } of shards) {
    for (const model of result.models ?? []) {
      if (seen.has(model.variantId)) throw new Error(`Duplicate variant ${model.variantId} in ${file}; shards overlap.`);
      seen.set(model.variantId, model);
    }
  }

  // Warn when the union does not cover the expected matrix for this tag.
  // The tag encodes the shard scope (core, full, flash-*, single-<id>,
  // chat[-base-<id>], each optionally suffixed with -repro for deterministic
  // repro runs); a tag the merger does not recognize skips the coverage
  // check instead of warning spuriously.
  const expectedIds = (() => {
    const raw = (first.tag ?? "").replace(/-repro$/, "");
    const isFlash = raw === "flash" || raw.startsWith("flash-");
    const base = isFlash ? raw.slice("flash".length).replace(/^-/, "") || "core" : raw;
    const wrap = (ids) => (isFlash ? flashMatrix(ids) : ids);
    if (options.phase === "chat") {
      if (base === "chat" || base.startsWith("chat-base-")) return wrap(buildChatMatrix()).map((spec) => spec.id);
      return null;
    }
    if (base === "core") return wrap(modelMatrix({ full: false })).map((spec) => spec.id);
    if (base === "full") return wrap(modelMatrix({ full: true })).map((spec) => spec.id);
    if (base.startsWith("single-")) {
      const ids = modelMatrixFor(base.slice("single-".length));
      return ids.length ? wrap(ids).map((spec) => spec.id) : null;
    }
    return null;
  })();
  const missing = expectedIds ? expectedIds.filter((id) => !seen.has(id)) : [];
  const extra = expectedIds ? [...seen.keys()].filter((id) => !expectedIds.includes(id)) : [];

  const models = [...seen.values()];
  const checksPassed = models.reduce((sum, model) => sum + (model.checksPassed ?? 0), 0);
  const checksTotal = models.reduce((sum, model) => sum + (model.checksTotal ?? 0), 0);
  const allPrompts = models.flatMap((model) => model.prompts ?? []);
  const aggregate = {};
  for (const prompt of allPrompts) {
    const key = prompt.id;
    aggregate[key] ??= { id: key, label: prompt.label, category: prompt.category, origin: promptOrigin(prompt), dataset: promptDataset(prompt), passed: 0, total: 0 };
    aggregate[key].passed += prompt.passed;
    aggregate[key].total += prompt.total;
  }
  const tests = Object.values(aggregate)
    .map((test) => ({ ...test, percent: test.total ? Number(((test.passed / test.total) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // A merged repro run measures the noise floor on batch 1: like a direct
  // repro run it never touches the shared latest files, and the history
  // scopes it as repro from the flag below.
  const isRepro = (first.tag ?? "").endsWith("-repro") ||
    shards.every(({ result }) => result.reproRun || (result.models ?? []).some((model) => model.deterministicRepro));
  const merged = {
    schema: 3,
    phase: options.phase,
    suiteVersion: first.result.suiteVersion,
    testHash: first.result.testHash,
    runtime: first.result.runtime,
    appVersion: first.result.appVersion,
    createdAt: first.result.createdAt,
    finishedAt: new Date().toISOString(),
    runtimeMs: shards.reduce((sum, { result }) => sum + (result.runtimeMs ?? 0), 0),
    wallClockNote: "sum of shard runtimes; wall-clock was less when shards ran in parallel",
    machine: first.result.machine,
    machines: shards.map(({ result }, i) => ({ shard: i + 1, ...(result.machine ?? {}) })),
    settings: { ...(first.result.settings ?? {}), matrix: true, shard: null, matrixScope: isRepro ? `merged-repro:${options.total}` : `merged:${options.total}`, mergedFrom: options.total },
    ...(isRepro ? { reproRun: true } : {}),
    overall: {
      score: checksTotal ? Number(((checksPassed / checksTotal) * 100).toFixed(2)) : 0,
      checksPassed,
      checksTotal,
      byCategory: categoryScores(allPrompts),
      items: itemSummary(allPrompts),
      tokensPerSecond: Number(median(models.map((m) => m.tokensPerSecond)).toFixed(2)),
      firstTokenMs: Math.round(median(models.map((m) => m.firstTokenMs))),
    },
    tests,
    models,
  };

  const outFile = options.out ?? path.join(RESULTS_DIR, isRepro ? `latest-repro-${options.phase}-${first.tag}.json` : `latest-${options.phase}.json`);
  await writeFile(outFile, `${JSON.stringify(merged, null, 2)}\n`);
  if (!options.out && !isRepro) await writeFile(path.join(RESULTS_DIR, "latest.json"), `${JSON.stringify(merged, null, 2)}\n`);

  const history = await recordRun({
    dbPath: path.join(HERE, "history.sqlite"),
    historyPath: path.join(HERE, "history.jsonl"),
    result: merged,
    git: currentGitInfo(path.resolve(HERE, "..")),
    baseline: false,
  });

  process.stdout.write(`Merged ${shards.length} shards [${first.tag}] (${models.length} variants) -> ${outFile}\n`);
  process.stdout.write(`Overall: ${merged.overall.score}% · ${merged.overall.checksPassed}/${merged.overall.checksTotal} checks · run ${history.uid}\n`);
  if (missing.length) process.stdout.write(`WARNING: ${missing.length} expected variants missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " ..." : ""}\n`);
  if (extra.length) process.stdout.write(`NOTE: ${extra.length} variants not in the default matrix: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " ..." : ""}\n`);
  if (isRepro) {
    process.stdout.write("Repro merge: batch-1 noise-floor measurement, informational only — it never compares to a baseline.\n");
  } else {
    process.stdout.write("Compare against the baseline with a full (unsharded) read or npm run bench:report.\n");
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[merge-shards] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
