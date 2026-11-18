import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePaths } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { assessEngines, createEngineRegistry, defaultEngines, formatAssessment } from "../src/inference-engines.js";
import { createModelRegistry } from "../src/model-registry.js";

const USAGE = `Usage: npm run engines -- --model <file.gguf|id> [options]

Times every inference engine on one installed model with the same workload
(about 256 prompt tokens, 64 generated) and prints prompt and generation
tokens per second for each, with the engine's version. Engines that are not
installed or will not start are listed with the reason.

  --model <name>        installed file name or id (required)
  --models-dir <dir>    models folder (default: <home>/models)
  --home <folder>       data folder (default: ~/.modelduck)
  --runs <n>            counted runs per engine after one warm-up (default 3)
  --only <ids>          comma-separated engine ids (see the table; default: all)
  --llama-bench <file>  a native llama.cpp llama-bench binary to include
  --ollama-model <tag>  the Ollama model to time (default: a tag matching the file)
  --ollama-url <url>    Ollama server (default http://127.0.0.1:11434)
  --json                print the assessment as JSON
  --save <file>         also write the assessment as JSON to this file
`;

function parseArgs(argv) {
  const options = { runs: 3 };
  const take = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new AppError("Missing option value", { code: "bad_option", why: `${name} needs a value.`, fix: USAGE });
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") options.model = take(index++, arg);
    else if (arg === "--models-dir") options.modelsDir = take(index++, arg);
    else if (arg === "--home") options.home = take(index++, arg);
    else if (arg === "--runs") options.runs = Number.parseInt(take(index++, arg), 10);
    else if (arg === "--only") options.only = take(index++, arg).split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--llama-bench") options.llamaBench = take(index++, arg);
    else if (arg === "--ollama-model") options.ollamaModel = take(index++, arg);
    else if (arg === "--ollama-url") options.ollamaUrl = take(index++, arg);
    else if (arg === "--save") options.save = take(index++, arg);
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not an option.`, fix: USAGE });
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) {
    throw new AppError("Bad run count", { code: "bad_option", why: "--runs must be a whole number from 1 to 20.", fix: "Use for example --runs 3." });
  }
  return options;
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseArgs(argv);
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  if (!options.model) {
    throw new AppError("A model is required", { code: "model_required", why: "No --model was given.", fix: USAGE });
  }
  const paths = resolvePaths({ home: options.home, models: options.modelsDir });
  // A read-only command never creates the models folder just to find it empty.
  if (!fs.existsSync(paths.models)) {
    throw new AppError("Model not found", { code: "model_not_found", status: 404, why: `The models folder ${paths.models} does not exist.`, fix: "Pass --models-dir <folder with .gguf files>, or --home <data folder>." });
  }
  const models = createModelRegistry({ modelsDir: paths.models, logger: { warn() {}, info() {}, error() {} } });
  const installed = await models.scan();
  const wanted = options.model.toLowerCase();
  const found = installed.find((model) => model.id.toLowerCase() === wanted || model.fileName.toLowerCase() === wanted || model.fileName.toLowerCase().replace(/\.gguf$/, "") === wanted);
  const entry = found && models.findById(found.id);
  if (!entry) {
    throw new AppError("Model not found", { code: "model_not_found", status: 404, why: `${options.model} is not in ${paths.models}.`, fix: "Use an installed file name, or pass --models-dir." });
  }
  const registry = createEngineRegistry({ engines: defaultEngines({ llamaBench: options.llamaBench ?? null, ollamaModel: options.ollamaModel ?? null, ollamaUrl: options.ollamaUrl }) });
  if (options.only) {
    const unknown = options.only.filter((id) => !registry.ids().includes(id));
    if (unknown.length) {
      throw new AppError("Unknown engine", { code: "bad_option", why: `${unknown.join(", ")} is not an engine id.`, fix: `Use any of: ${registry.ids().join(", ")}.` });
    }
  }
  const report = await assessEngines({
    registry,
    entry,
    runs: options.runs,
    only: options.only ?? null,
    onProgress: ({ engine, stage }) => process.stderr.write(`[engines] ${stage} ${engine}\n`),
  });
  const record = { assessedAt: new Date().toISOString(), host: { platform: os.platform(), cpu: os.cpus()[0]?.model ?? null }, ...report };
  if (options.save) await writeJsonAtomic(path.resolve(options.save), record);
  out.write(options.json ? `${JSON.stringify(record, null, 2)}\n` : `${formatAssessment(report)}\n`);
  return report.fastest ? 0 : 1;
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
