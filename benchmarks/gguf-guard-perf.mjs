/** Before/after check for the optional Rust GGUF header guard. Run: npm run bench:gguf */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { inspectGgufHeaderJs } from "../src/gguf-guard.js";
import { inspectGgufHeaderNative, nativeGuardAvailable } from "../src/gguf-native.js";
import { isMainModule } from "./stats-util.mjs";

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const str = (text) => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);

export function largeGguf({ tokens = 20000, tensors = 2000 } = {}) {
  const kvs = [str("general.alignment"), u32(4), u32(32),
    str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(tokens)];
  const entries = Array.from({ length: tokens }, (_, i) => str(`tok${i}`));
  const shapes = Array.from({ length: tensors }, (_, i) =>
    Buffer.concat([str(`blk.${i}.weight`), u32(1), u64(4), u32(2), u64(0)]));
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(tensors), u64(2),
    ...kvs, ...entries, ...shapes, Buffer.alloc(64)]);
}

async function time(label, fn, iterations) {
  for (let i = 0; i < 2; i += 1) await fn();
  const start = performance.now();
  let result;
  for (let i = 0; i < iterations; i += 1) result = await fn();
  const ms = performance.now() - start;
  console.log(`${label}: ${(ms / iterations).toFixed(2)} ms/op (${iterations} ops) -> ${JSON.stringify(result)}`);
}

export async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-gguf-perf-"));
  try {
    const file = path.join(directory, "large.gguf");
    await writeFile(file, largeGguf());
    await time("JavaScript bounded walk", () => inspectGgufHeaderJs(file), 10);
    if (nativeGuardAvailable()) {
      await time("Rust addon (in-process)", () => inspectGgufHeaderNative(file), 10);
    } else {
      console.log("Rust guard not built; run npm run build:native first.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) await main();
