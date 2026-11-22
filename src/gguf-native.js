/**
 * In-process bridge to the optional Rust GGUF header validator (rust/gguf-guard).
 *
 * The addon is built with `npm run build:native` and is intentionally optional:
 * a source checkout without a Rust toolchain keeps the original JavaScript guard.
 * A rejected header is left to the JavaScript guard so the AppError still carries
 * the exact Why/Fix text the rest of the app and its tests expect. Calling the
 * addon through `process.dlopen` avoids a process spawn per model (measured:
 * 104 ms for a CLI spawn versus 7.5 ms for the JavaScript walk on Windows).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDON = path.join(PROJECT_ROOT, "rust", "gguf-guard", "target", "release", "gguf-guard.node");

let loaded = null;

function addon() {
  if (loaded === null) {
    try {
      const module = { exports: {} };
      process.dlopen(module, ADDON);
      loaded = typeof module.exports.inspectGguf === "function" ? module.exports : false;
    } catch {
      loaded = false;
    }
  }
  return loaded;
}

export function nativeGuardPath() {
  return ADDON;
}

export function nativeGuardAvailable() {
  return Boolean(addon());
}

export function resetNativeGuardAvailability() {
  loaded = null;
}

export async function inspectGgufHeaderNative(file) {
  const native = addon();
  if (!native) return null;
  try {
    const result = native.inspectGguf(file);
    if (!Number.isInteger(result.version) || !Number.isSafeInteger(result.tensorCount)
      || !Number.isSafeInteger(result.kvCount)) return null;
    return result;
  } catch {
    return null;
  }
}
