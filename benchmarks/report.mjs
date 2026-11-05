import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  historyStats,
  importHistory,
  listRuns,
  modelProgress,
  openDatabase,
  rebuildDatabase,
  testResults,
} from "./history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    limit: 10,
    model: null,
    json: false,
    rebuild: false,
    dbPath: path.join(HERE, "history.sqlite"),
    historyPath: path.join(HERE, "history.jsonl"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].includes("=")
      ? argv[index].split(/=(.*)/s, 2)
      : [argv[index], undefined];
    const take = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${flag}`);
      return argv[index];
    };
    switch (flag) {
      case "--limit":
        options.limit = Number(take());
        break;
      case "--model":
        options.model = take();
        break;
      case "--json":
        options.json = true;
        break;
      case "--rebuild":
        options.rebuild = true;
        break;
      case "--db":
        options.dbPath = path.resolve(take());
        break;
      case "--history":
        options.historyPath = path.resolve(take());
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function shortCommit(run) {
  if (run.commit_pending) return "pending";
  return run.commit_hash ? run.commit_hash.slice(0, 8) : "untracked";
}

function date(value) {
  return String(value ?? "").replace("T", " ").slice(0, 16);
}

function signed(value, digits = 1) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

const HELP = `ModelDuck benchmark history

Usage:
  npm run bench:report -- [options]

Options:
  --limit <n>       Number of runs per model (default: 10)
  --model <key>     Filter to one model key
  --rebuild         Rebuild history.sqlite from history.jsonl first
  --db <path>       Override the SQLite path
  --history <path>  Override the JSONL history path
  --json            Print the report as JSON
  -h, --help        Show this help
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error("--limit must be at least 1");
  }

  let db;
  try {
    db = await openDatabase(options.dbPath);
  } catch (error) {
    if (String(error.message).includes("node:sqlite")) {
      throw new Error(
        "Benchmark history needs Node.js 22 or newer (node:sqlite). " +
          "The app itself still runs on Node 20.",
      );
    }
    throw error;
  }

  try {
    const imported = options.rebuild
      ? await rebuildDatabase(db, options.historyPath)
      : await importHistory(db, options.historyPath);
    const stats = historyStats(db);
    if (!stats.runs) {
      process.stdout.write(
        `No benchmark runs recorded yet.\nHistory file: ${options.historyPath}\nRun: npm run bench\n`,
      );
      return;
    }

    const runs = listRuns(db, options.limit);
    const keys = [
      ...new Set(
        db
          .prepare("SELECT DISTINCT model_key FROM model_results ORDER BY model_key")
          .all()
          .map((row) => row.model_key),
      ),
    ];
    const selectedKeys = options.model ? keys.filter((key) => key === options.model) : keys;
    const progress = Object.fromEntries(
      selectedKeys.map((key) => [key, modelProgress(db, key, options.limit)]),
    );

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            database: options.dbPath,
            history: options.historyPath,
            stats,
            imported,
            runs,
            progress,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    process.stdout.write(
      `ModelDuck benchmark history · ${stats.runs} run(s), ${stats.commits} commit(s)\n`,
    );
    process.stdout.write(`Database: ${options.dbPath}\n\n`);

    process.stdout.write("Runs\n");
    for (const run of runs) {
      const models = run.models
        .map((model) => `${model.label ?? model.model_key} ${Number(model.score).toFixed(0)}%`)
        .join(" · ");
      const scopeTag = run.run_scope && run.run_scope !== "standard" ? `  [${run.run_scope}]` : "";
      process.stdout.write(
        `  ${shortCommit(run).padEnd(10)} ${date(run.recorded_at).padEnd(16)} ` +
          `${`v${run.suite_version}:${String(run.test_hash || "--------").slice(0, 8)}`.padEnd(13)} ` +
          `${String(run.phase || "model").padEnd(6)} ` +
          `${String(Number(run.overall_score).toFixed(1) + "%").padStart(6)} ` +
          `${String(Number(run.tokens_per_second).toFixed(1)).padStart(6)} tok/s  ` +
          `${String(Math.round((Number(run.runtime_ms) || 0) / 1000) + "s").padStart(6)}  ` +
          `${models}${run.baseline ? "  [baseline]" : ""}${scopeTag}\n`,
      );
    }

    for (const key of selectedKeys) {
      const rows = progress[key];
      if (!rows.length) continue;
      process.stdout.write(`\n${key}\n`);
      process.stdout.write("  commit     date             variant                                    quality   speed     ΔQ     Δspeed\n");
      const previousByVariant = new Map();
      for (const row of [...rows].reverse()) {
        const variantKey = row.variant_id || row.variant_label || "base";
        const older = previousByVariant.get(variantKey) ?? null;
        previousByVariant.set(variantKey, { row, older });
      }
      for (const row of rows) {
        const variantKey = row.variant_id || row.variant_label || "base";
        const previous = previousByVariant.get(variantKey)?.older ?? null;
        const qualityDelta =
          previous && Number.isFinite(previous.score) ? row.score - previous.score : null;
        const speedDelta = previous?.tokens_per_second
          ? ((row.tokens_per_second - previous.tokens_per_second) / previous.tokens_per_second) * 100
          : null;
        const variant = String(row.variant_label || row.label || "base").slice(0, 42);
        process.stdout.write(
          `  ${shortCommit(row).padEnd(10)} ${date(row.recorded_at).padEnd(16)} ` +
            `${variant.padEnd(42)} ` +
            `${String(Number(row.score).toFixed(1) + "%").padStart(7)} ` +
            `${String(Number(row.tokens_per_second).toFixed(1)).padStart(7)}  ` +
            `${qualityDelta === null ? "   -" : signed(qualityDelta).padStart(6)}  ` +
            `${speedDelta === null ? "      -" : `${signed(speedDelta).padStart(7)}%`}\n`,
        );
      }
    }

    for (const phase of ["model", "chat"]) {
      // A partial shard or a batch-1 repro never stands in as the phase's
      // checks: prefer the latest standard run, fall back to anything.
      const latest =
        runs.find((run) => (run.phase || "model") === phase && (!run.run_scope || run.run_scope === "standard")) ??
        runs.find((run) => (run.phase || "model") === phase);
      if (!latest) continue;
      const tests = testResults(db, latest.uid);
      if (!tests.length) continue;
      // The fallback can surface a shard or repro run; label it so partial
      // or batch-1 checks are never mistaken for canonical ones.
      const latestScope = latest.run_scope && latest.run_scope !== "standard" ? ` [${latest.run_scope}]` : "";
      process.stdout.write(`\nLatest ${phase} test checks (${shortCommit(latest)}${latestScope})\n`);
      for (const test of tests) {
        process.stdout.write(
          `  ${String(test.label || test.prompt_id).padEnd(28)} ` +
            `${String(test.percent.toFixed(1) + "%").padStart(6)}  ` +
            `(${test.passed}/${test.total})\n`,
        );
      }
    }
  } catch (error) {
    if (String(error.message).includes("node:sqlite")) {
      throw new Error(
        "Benchmark history needs Node.js 22 or newer (node:sqlite). " +
          "The app itself still runs on Node 20.",
      );
    }
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\n[bench:report] ${error.message}\n`);
  process.exit(1);
});
