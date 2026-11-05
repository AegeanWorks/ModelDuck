import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentGitInfo, linkRun } from "./history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    uid: null,
    force: false,
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
      case "--uid":
        options.uid = take();
        break;
      case "--force":
        options.force = true;
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

const HELP = `Link the latest benchmark run to the commit that contains the change.

Usage:
  npm run bench:link -- [options]

Run this after committing the benchmarked change. It updates the run's commit
hash in history.sqlite and appends a link event to history.jsonl.

Options:
  --uid <run>      Link a specific run UID (default: latest pending standard run).
                     An explicit UID links anything, including shard or
                     repro runs; the default never does.
  --force          Allow linking while tracked files are dirty
  --db <path>      Override the SQLite path
  --history <path> Override the JSONL history path
  -h, --help       Show this help
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const git = currentGitInfo(path.resolve(HERE, ".."));
  if (!git.hash) throw new Error("Could not resolve the current git commit.");
  if (git.dirty && !options.force) {
    throw new Error(
      "The working tree is dirty. Commit the benchmarked change first, then run npm run bench:link (or use --force).",
    );
  }

  const result = await linkRun({
    dbPath: options.dbPath,
    historyPath: options.historyPath,
    uid: options.uid,
    commit: git,
  });
  if (!result.linked) {
    process.stderr.write(`\n[bench:link] ${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `Linked run ${result.uid} to ${git.hash.slice(0, 8)} (${git.subject || "no subject"}).\n` +
      "history.jsonl changed; commit that bookkeeping update if you track it.\n",
  );
  if (result.run_scope && result.run_scope !== "standard") {
    process.stdout.write(
      `WARNING: linked run is [${result.run_scope}], not a comparable standard run; trends skip it.\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`\n[bench:link] ${error.message}\n`);
  process.exit(1);
});
