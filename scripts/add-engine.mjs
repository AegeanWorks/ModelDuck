import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerBuild, unregisterBuild } from "../src/engine-install.js";
import { AppError } from "../src/errors.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "engines");

const USAGE = `Usage: npm run engines:add -- --name <name> --binary <llama-server> [--backend cpu|vulkan|cuda|metal] [--label <text>]
       npm run engines:add -- --remove <name>

Registers a llama.cpp-family server you built or downloaded yourself (ik_llama.cpp, BitNet,
a llamafile server, a custom llama.cpp) as one more engine. Nothing is copied. It is timed
next to the others by \`npm run engines\` and a tune, and when it wins the app serves with it.

  --name <name>      the engine id suffix: it appears as llama-server:<name>
  --binary <file>    the build's llama-server executable
  --backend <name>   the device it runs on (default: what the build finds on this machine)
  --label <text>     how reports name it, for example ik_llama.cpp
  --remove <name>    forget a registered build (its files stay where they are)
  --dir <folder>     register under this folder instead of engines/
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
    if (arg === "--name") options.name = value();
    else if (arg === "--binary") options.binary = value();
    else if (arg === "--backend") options.backend = value();
    else if (arg === "--label") options.label = value();
    else if (arg === "--remove") options.remove = value();
    else if (arg === "--dir") options.root = path.resolve(value());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new AppError("Unknown option", { code: "bad_option", why: `${arg} is not an option.`, fix: USAGE });
  }
  return options;
}

export function main(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseArgs(argv);
  if (options.help || (!options.remove && !options.name)) {
    out.write(USAGE);
    return options.help ? 0 : 2;
  }
  if (options.remove) {
    out.write(unregisterBuild({ root: options.root, name: options.remove }) ? `Forgot llama-server:${options.remove}.\n` : `llama-server:${options.remove} was not registered with engines:add.\n`);
    return 0;
  }
  const record = registerBuild({ root: options.root, name: options.name, binary: options.binary, backend: options.backend ?? null, label: options.label ?? null });
  out.write(`Registered llama-server:${record.variant} -> ${record.binary}\nTime it with: npm run engines -- --model <file.gguf>\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\nWhy: ${error.why ?? error.message}\nFix: ${error.fix ?? "see --help"}\n`);
    process.exitCode = 1;
  }
}
