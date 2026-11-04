import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDownloadFit, inspectGgufHeader, preflightGgufFile } from "../src/gguf-guard.js";

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

async function tempGguf(t, bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-preflight-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "model.gguf");
  await writeFile(file, bytes);
  return file;
}

// IDEA-1637: GGUF preflight glue refuses doomed downloads early.
test("IDEA-1637: checkDownloadFit refuses a doomed download with an actionable error", async () => {
  const { estimate, verdict } = checkDownloadFit({
    modelBytes: 1024,
    contextSize: 2048,
    kvCache: "f16",
    availableBytes: 8 * 1024 ** 3,
  });
  assert.ok(estimate.total > 0);
  // Pre-download the KV shape is unknown, so a tiny file is "unknown" (not
  // blocked); only the hopeless weights-plus-reserve case refuses.
  assert.ok(["comfortable", "unknown"].includes(verdict.verdict), verdict.verdict);
  assert.throws(
    () => checkDownloadFit({
      modelBytes: 16 * 1024 ** 3,
      contextSize: 2048,
      kvCache: "f16",
      availableBytes: 1 * 1024 ** 3,
    }),
    (error) => error.code === "download_would_not_fit" && Boolean(error.why) && Boolean(error.fix),
  );
});

test("IDEA-1637: preflightGgufFile validates the header then estimates the fit", async (t) => {
  const file = await tempGguf(t, validGguf());
  const header = await inspectGgufHeader(file);
  assert.equal(header.version, 3);
  const ok = await preflightGgufFile(file, { contextSize: 2048, kvCache: "f16", availableBytes: 8 * 1024 ** 3 });
  assert.equal(ok.header.version, 3);
  assert.ok(ok.estimate.total > 0);
  assert.notEqual(ok.verdict.verdict, "will_not_fit");
  await assert.rejects(
    () => preflightGgufFile(file, { contextSize: 32768, kvCache: "f16", availableBytes: 256 * 1024 ** 2 }),
    (error) => error.code === "download_would_not_fit",
  );
});
