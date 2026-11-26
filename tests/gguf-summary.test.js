import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGgufSummary } from "../src/gguf-summary.js";

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const f32 = (value) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
const str = (text) => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
const kv = (key, type, body) => Buffer.concat([str(key), u32(type), body]);
const tensor = (name, dims) => Buffer.concat([str(name), u32(dims.length), ...dims.map(u64), u32(0), u64(0)]);

function gguf({ tokens = 5000, version = 3 } = {}) {
  const entries = [
    kv("general.architecture", 8, str("llama")),
    kv("general.name", 8, str("Tiny")),
    kv("llama.context_length", 4, u32(4096)),
    kv("llama.block_count", 4, u32(2)),
    kv("llama.attention.head_count", 4, u32(8)),
    kv("llama.attention.head_count_kv", 4, u32(2)),
    kv("llama.rope.freq_base", 6, f32(10000)),
    kv("llama.huge", 10, u64(2 ** 40)),
    kv("tokenizer.chat_template", 8, str("{{ messages }}")),
    kv("tokenizer.ggml.tokens", 9, Buffer.concat([u32(8), u64(tokens), ...Array.from({ length: tokens }, (_, i) => str(`tok${i}`))])),
    kv("tokenizer.ggml.scores", 9, Buffer.concat([u32(6), u64(tokens), Buffer.alloc(4 * tokens)])),
    kv("llama.small_list", 9, Buffer.concat([u32(4), u64(2), u32(7), u32(9)])),
  ];
  return Buffer.concat([Buffer.from("GGUF"), u32(version), u64(2), u64(entries.length), ...entries,
    tensor("a.weight", [64, 32]), tensor("b.weight", [10]), Buffer.alloc(64)]);
}

async function withFile(t, bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "m.gguf");
  await writeFile(file, bytes);
  return file;
}

test("the summary keeps the metadata the scan reads and skips the vocabulary", async (t) => {
  const info = await readGgufSummary(await withFile(t, gguf()));
  assert.equal(info.metadata.general.architecture, "llama");
  assert.equal(info.metadata.general.name, "Tiny");
  assert.equal(info.metadata.tokenizer.chat_template, "{{ messages }}");
  assert.equal(info.metadata.tokenizer.ggml, undefined, "large arrays are not decoded");
  assert.deepEqual(info.architectureMetadata, {
    context_length: 4096, block_count: 2, attention: { head_count: 8, head_count_kv: 2 },
    rope: { freq_base: 10000 }, huge: 2 ** 40, small_list: [7, 9],
  });
  assert.deepEqual(info.tensorInfo.map((tensorInfo) => tensorInfo.dimensions), [[64, 32], [10]]);
});

test("a vocabulary larger than the read window is skipped correctly", async (t) => {
  const info = await readGgufSummary(await withFile(t, gguf({ tokens: 200000 })));
  assert.equal(info.tensorInfo.length, 2, "the tensors after the vocabulary are still found");
  assert.equal(info.architectureMetadata.block_count, 2);
});

test("a file the lean reader does not understand is refused so the library can read it", async (t) => {
  await assert.rejects(readGgufSummary(await withFile(t, gguf({ version: 1 }))), /library/);
  await assert.rejects(readGgufSummary(await withFile(t, Buffer.from("not a gguf file at all, really"))), /not a GGUF|truncated/);
  const whole = gguf();
  await assert.rejects(readGgufSummary(await withFile(t, whole.subarray(0, whole.length - 200))), /truncated/);
});
