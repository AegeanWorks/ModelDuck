import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppError } from "../src/errors.js";
import { inspectGgufHeader, inspectGgufHeaderJs } from "../src/gguf-guard.js";
import { createModelRegistry } from "../src/model-registry.js";

const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const u64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
const str = (text) => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);

/** A small but structurally complete GGUF v3: scalar, string, string array, one tensor. */
function validGguf() {
  return Buffer.concat([
    Buffer.from("GGUF"), u32(3), u64(1), u64(3),
    str("general.alignment"), u32(4), u32(32),
    str("general.name"), u32(8), str("Duck"),
    str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(2), str("a"), str("b"),
    str("blk.0.weight"), u32(2), u64(4), u64(4), u32(0), u64(0),
    Buffer.alloc(64),
  ]);
}

function header({ version = 3, tensors = 0, kvs = 0 } = {}, ...rest) {
  return Buffer.concat([Buffer.from("GGUF"), u32(version), u64(tensors), u64(kvs), ...rest, Buffer.alloc(32)]);
}

async function tempFile(t, bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-gguf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "model.gguf");
  await writeFile(file, bytes);
  return file;
}

const rejected = (error) =>
  error instanceof AppError && error.code === "gguf_header_rejected" && Boolean(error.why) && Boolean(error.fix);

test("a structurally valid GGUF header passes the guard", async (t) => {
  const file = await tempFile(t, validGguf());
  const info = await inspectGgufHeader(file);
  assert.deepEqual(info, { version: 3, tensorCount: 1, kvCount: 3 });
});

test("counts and lengths larger than the file are refused before parsing", async (t) => {
  const hostile = {
    "2^62 tensors": header({ tensors: 1n << 62n }),
    "2^62 metadata entries": header({ kvs: 1n << 62n }),
    "a 2^40-byte key": header({ kvs: 1 }, u64(1n << 40n)),
    "a 2^60-element string array": header({ kvs: 1 }, str("k"), u32(9), u32(8), u64(1n << 60n)),
    "a 2^60-element u64 array": header({ kvs: 1 }, str("k"), u32(9), u32(10), u64(1n << 60n)),
    "nested arrays": header({ kvs: 1 }, str("k"), u32(9), u32(9), u64(1), u32(9), u64(1), u32(9), u64(1)),
    "an unknown value type": header({ kvs: 1 }, str("k"), u32(99)),
    "a tensor with 1000 dimensions": header({ tensors: 1 }, str("t"), u32(1000)),
    "GGUF version 1": header({ version: 1 }),
    "a truncated header": Buffer.from("GGUF\x03\x00\x00\x00"),
  };
  for (const [name, bytes] of Object.entries(hostile)) {
    const file = await tempFile(t, bytes);
    await assert.rejects(() => inspectGgufHeader(file), rejected, name);
  }
});

test("a header-rejected file is listed as blocked and cannot be imported", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createModelRegistry({ modelsDir: directory, logger: { warn() {} } });

  await writeFile(path.join(directory, "planted.gguf"), header({ tensors: 1n << 62n }));
  const [model] = await registry.scan();
  assert.equal(model.blocked, true);
  assert.match(model.blockedReason, /tensor/i);

  const source = path.join(directory, "..", `hostile-${process.pid}-${Date.now()}.gguf`);
  await writeFile(source, header({ kvs: 1n << 62n }));
  t.after(() => rm(source, { force: true }));
  await assert.rejects(() => registry.importFromPath(source), rejected);
  assert.equal((await registry.scan()).length, 1, "the hostile copy is removed again");
});

// --- native (Rust) guard -----------------------------------------------------------------------

test("the native guard returns the same header facts as the JavaScript guard when built", async (t) => {
  const { inspectGgufHeaderNative, nativeGuardAvailable } = await import("../src/gguf-native.js");
  if (!nativeGuardAvailable()) t.skip("build the optional binary with npm run build:native");
  const file = await tempFile(t, validGguf());
  assert.deepEqual(await inspectGgufHeaderNative(file), { version: 3, tensorCount: 1, kvCount: 3 });
  assert.deepEqual(await inspectGgufHeader(file), await inspectGgufHeaderJs(file));
});

test("native and JavaScript guards agree on metadata spans larger than the read buffer", async (t) => {
  const { inspectGgufHeaderNative, nativeGuardAvailable } = await import("../src/gguf-native.js");
  if (!nativeGuardAvailable()) t.skip("build the optional binary with npm run build:native");
  const file = await tempFile(t, header({ kvs: 1 }, str("general.name"), u32(8), str("x".repeat(20000))));
  assert.deepEqual(await inspectGgufHeaderNative(file), { version: 3, tensorCount: 0, kvCount: 1 });
  assert.deepEqual(await inspectGgufHeader(file), await inspectGgufHeaderJs(file));
});

test("a hostile header still produces the JavaScript Why/Fix error with the native guard built", async (t) => {
  const { nativeGuardAvailable } = await import("../src/gguf-native.js");
  if (!nativeGuardAvailable()) t.skip("build the optional binary with npm run build:native");
  const file = await tempFile(t, header({ tensors: 1n << 62n }));
  await assert.rejects(() => inspectGgufHeader(file), rejected);
});
