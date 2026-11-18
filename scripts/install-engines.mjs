import path from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "../src/errors.js";
import { DEFAULT_VARIANTS, installVariant, planInstall, readManifest } from "../src/engine-install.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "engines");

const USAGE = `Usage: npm run engines:install -- [options]

Downloads the inference engines ModelDuck ships (llama.cpp's llama-server and
llama-bench, official builds), checks each file against the SHA-256 pinned in
engines/manifest.json, and unpacks it into engines/bin. Nothing is installed
system-wide, and an engine already at the pinned release is left alone.

  --variants <list>  comma-separated: cpu, vulkan, cuda, metal (default: cpu,vulkan;
                     cuda is a ~650 MB download and needs an NVIDIA driver)
  --list             show what would be installed and exit
  --dir <folder>     install under this folder instead of engines/
`;

function parseArgs(argv) {
  const options = { root: ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new AppError("Missing option value", { code: "bad_option", why: `${arg} needs a value.`, fix: USAGE });
      index += 1;
      return next;
    };
    if (arg === "--variants") options.variants = value().split(",").map((variant) => variant.trim()).filter(Boolean);
    else if (arg === "--dir") options.root = path.resolve(value());
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not an option.`, fix: USAGE });
  }
  return options;
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseArgs(argv);
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  const manifest = await readManifest(path.join(ROOT, "manifest.json"));
  const plan = planInstall(manifest, { variants: options.variants ?? null });
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  for (const entry of plan) {
    out.write(`${entry.engine} ${entry.release} ${entry.variant}: ${entry.assets.map((asset) => `${asset.name} (${mb(asset.size)})`).join(" + ")} [${entry.license}]\n`);
  }
  if (options.list) return 0;
  for (const entry of plan) {
    const record = await installVariant(entry, {
      root: options.root,
      onProgress: ({ stage, asset }) => out.write(`  ${entry.variant}: ${stage === "present" ? "already installed" : `${stage} ${asset}`}\n`),
    });
    out.write(`  ${entry.variant}: ${record.skipped ? "kept" : "installed"} -> ${path.join(options.root, "bin", entry.dirName)}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.message}\n${error.why ? `Why: ${error.why}\n` : ""}${error.fix ? `Fix: ${error.fix}\n` : ""}`);
      process.exit(2);
    },
  );
}
