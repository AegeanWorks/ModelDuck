/** Build the optional Rust GGUF addon. No npm dependency: cargo is the only requirement. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "rust", "gguf-guard");
const manifest = path.join(crate, "Cargo.toml");
const target = path.join(crate, "target", "release");
const suffixes = { win32: ".dll", linux: ".so", darwin: ".dylib" };

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
}

// N-API symbols are supplied by node.exe at runtime. On Windows GNU there is no
// node.lib in the distribution, so make a tiny import library from the names
// the addon uses and point rustc at it.
if (process.platform === "win32") {
  const libDir = path.join(crate, "target", "nativelib");
  fs.mkdirSync(libDir, { recursive: true });
  const dlltool = spawnSync("where", ["dlltool"], { cwd: root, encoding: "utf8" });
  const tool = dlltool.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!tool) {
    console.error("dlltool not found; install the MinGW toolchain that cargo uses.");
    process.exit(1);
  }
  const built = run(tool, ["-d", path.join(crate, "node.def"), "-l", path.join(libDir, "libnode.a")]);
  if (built.status !== 0) process.exit(built.status ?? 1);
  process.env.RUSTFLAGS = `${process.env.RUSTFLAGS ?? ""} -L native=${libDir}`;
}

const args = ["build", "--release", "--manifest-path", manifest];
let result = run("cargo", args);
if (result.status !== 0 && process.platform === "win32") {
  // This host has the GNU toolchain but not the MSVC linker.
  result = run("cargo", ["+stable-x86_64-pc-windows-gnu", ...args]);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const built = path.join(target, `gguf_guard${suffixes[process.platform] ?? ""}`);
const addon = path.join(target, process.platform === "win32" ? "gguf-guard.node" : "gguf-guard.so");
fs.copyFileSync(built, addon);
console.log(`[OK] native GGUF addon: ${addon}`);
