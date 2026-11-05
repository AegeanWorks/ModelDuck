import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(ROOT, "tests");

const USAGE = `Usage: node scripts/test-parallel.mjs [options] [-- <node --test args>]

Runs the hermetic unit + integration suite in parallel segments so a full
run finishes ASAP. Each segment is one \`node --test\` child over its own
file list; shards are deterministic so CI can run "multiple models at once
at different segments" on separate machines and still cover every file once.

Options:
  --jobs <n>       Parallel children for this machine (default: CPU count, capped by shards)
  --shards <n>     Split into N segments (default: --jobs)
  --shard <i/n>    Run only segment i of n (1-based; e.g. --shard 2/4). Single-segment mode.
  --filter <text>  Only files whose name includes <text>
  --list           Print the segments and exit
  --dry-run        Print the child commands without running them
  --help, -h       Show this help

Examples:
  node scripts/test-parallel.mjs
  node scripts/test-parallel.mjs --jobs 4
  node scripts/test-parallel.mjs --shard 1/3
  node scripts/test-parallel.mjs --filter server --jobs 2 -- --test-reporter=spec
`;

function parseArgs(argv) {
  const options = { jobs: null, shards: null, shard: null, filter: null, list: false, dryRun: false, help: false, passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { options.passthrough = argv.slice(i + 1); break; }
    else if (arg === "--jobs") options.jobs = Number(argv[++i]);
    else if (arg.startsWith("--jobs=")) options.jobs = Number(arg.split("=")[1]);
    else if (arg === "--shards") options.shards = Number(argv[++i]);
    else if (arg.startsWith("--shards=")) options.shards = Number(arg.split("=")[1]);
    else if (arg === "--shard") options.shard = String(argv[++i] ?? "");
    else if (arg.startsWith("--shard=")) options.shard = arg.split("=").slice(1).join("=");
    else if (arg === "--filter") options.filter = String(argv[++i] ?? "");
    else if (arg.startsWith("--filter=")) options.filter = arg.split("=").slice(1).join("=");
    else if (arg === "--list") options.list = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
  }
  return options;
}

function parseShard(text) {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(text ?? "").trim());
  if (!match) throw new Error(`Bad shard ${JSON.stringify(text)}; use i/n like 2/4.`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    throw new Error(`Bad shard ${JSON.stringify(text)}; need 1 <= i <= n.`);
  }
  return { index, total };
}

/** Deterministic round-robin split: file idx goes to shard (idx % total). */
export function shardFiles(files, total) {
  const shards = Array.from({ length: total }, () => []);
  files.forEach((file, idx) => { shards[idx % total].push(file); });
  return shards;
}

async function discoverFiles(filter) {
  const entries = await readdir(TESTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.js"))
    .map((e) => e.name)
    .filter((name) => !filter || name.includes(filter))
    .sort();
}

function runShard(files, shardLabel, passthrough) {
  return new Promise((resolve) => {
    const args = ["--test", ...files.map((f) => path.join("tests", f)), ...passthrough];
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      out += text;
      for (const line of text.split("\n")) {
        if (line.trim()) process.stdout.write(`[shard ${shardLabel}] ${line}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      err += text;
      for (const line of text.split("\n")) {
        if (line.trim()) process.stderr.write(`[shard ${shardLabel}] ${line}\n`);
      }
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    child.on("error", (error) => resolve({ code: 1, out, err: `${err}\n${error.message}` }));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }

  const files = await discoverFiles(options.filter);
  if (!files.length) {
    process.stderr.write("[test-parallel] no test files match.\n");
    process.exitCode = 1;
    return;
  }

  const cpus = Math.max(1, os.availableParallelism?.() ?? 4);
  if (options.shard) {
    const { index, total } = parseShard(options.shard);
    const shards = shardFiles(files, total);
    const picked = shards[index - 1];
    process.stdout.write(`[test-parallel] shard ${index}/${total}: ${picked.length}/${files.length} files\n`);
    for (const f of picked) process.stdout.write(`  - tests/${f}\n`);
    if (!picked.length) {
      process.stderr.write(`[test-parallel] shard ${index}/${total} is empty; use fewer shards.\n`);
      process.exitCode = 1;
      return;
    }
    if (options.list || options.dryRun) return;
    const result = await runShard(picked, `${index}/${total}`, options.passthrough);
    process.exitCode = result.code;
    return;
  }

  // Keep the requested shard count for labels so --list matches the
  // --shard i/n indexing exactly; empty shards are skipped at run time.
  const requestedShards = Math.max(1, options.shards ?? options.jobs ?? cpus);
  if (options.jobs !== null && (!Number.isInteger(options.jobs) || options.jobs < 1)) {
    throw new Error(`Bad --jobs ${options.jobs}; need a positive integer.`);
  }
  if (options.shards !== null && (!Number.isInteger(options.shards) || options.shards < 1)) {
    throw new Error(`Bad --shards ${options.shards}; need a positive integer.`);
  }
  const shards = shardFiles(files, requestedShards);
  const runnable = shards
    .map((shard, i) => ({ shard, label: `${i + 1}/${shards.length}` }))
    .filter((entry) => entry.shard.length > 0);
  const jobs = Math.min(runnable.length, Math.max(1, options.jobs ?? runnable.length));

  process.stdout.write(`[test-parallel] ${files.length} files in ${shards.length} shards, ${jobs} parallel (CPUs: ${cpus})\n`);
  for (const [i, shard] of shards.entries()) {
    const note = shard.length ? "" : " (empty — skipped)";
    process.stdout.write(`  shard ${i + 1}/${shards.length} (${shard.length} files): ${shard.slice(0, 4).join(", ")}${shard.length > 4 ? ` +${shard.length - 4} more` : ""}${note}\n`);
  }
  if (options.list || options.dryRun) {
    if (options.dryRun) {
      runnable.forEach((entry) => process.stdout.write(`  [${entry.label}] $ node --test ${entry.shard.map((f) => `tests/${f}`).join(" ")}\n`));
    }
    return;
  }

  const started = Date.now();
  const results = new Array(runnable.length);
  let next = 0;
  async function worker() {
    while (next < runnable.length) {
      const i = next;
      next += 1;
      results[i] = { ...(await runShard(runnable[i].shard, runnable[i].label, options.passthrough)), files: runnable[i].shard, label: runnable[i].label };
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, runnable.length) }, () => worker()));

  const failed = results.map((r, i) => ({ ...r, shard: i + 1 })).filter((r) => r.code !== 0);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`[test-parallel] done in ${secs}s: ${runnable.length - failed.length}/${runnable.length} shards passed\n`);
  for (const r of results) {
    process.stdout.write(`  shard ${r.label}: exit ${r.code} (${r.files.length} files)\n`);
  }
  if (failed.length) {
    process.stderr.write(`[test-parallel] FAILED shards: ${failed.map((r) => r.label).join(", ")}\n`);
    // Propagate the worst child exit code instead of flattening to 1.
    process.exitCode = Math.max(...failed.map((r) => r.code));
  }
}

const invokedDirectly = (() => {
  try {
    if (process.argv[1] == null) return false;
    const invoked = path.resolve(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    // Case-insensitive on Windows (C:\ vs c:\, 8.3 names).
    return process.platform === "win32"
      ? invoked.toLowerCase() === self.toLowerCase()
      : invoked === self;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[test-parallel] ${error?.message ?? error}\n`);
    process.exitCode = 2;
  });
}
