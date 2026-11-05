import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DownloadManager, readInstallReceipt } from "../src/downloader.js";

const logger = { warn() {}, error() {} };
// Same minimal valid GGUF header as downloader.test.js: the download path
// checks the header before promotion, so fixtures must pass it.
const TINY_BYTES = (() => {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(2);
  return Buffer.concat([Buffer.from("GGUF"), version, Buffer.alloc(16)]);
})();
const TINY = {
  id: "tiny",
  name: "Tiny Duck",
  file: "tiny.gguf",
  repo: "duck/tiny",
  size: TINY_BYTES.length,
  sha256: createHash("sha256").update(TINY_BYTES).digest("hex"),
  quant: "Q4_K_M",
};

async function runTiny(t, body, { status = 200, part = null, resume = null, getModel = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (part) await writeFile(path.join(directory, `${TINY.file}.part`), part);
  if (resume) await writeFile(path.join(directory, `${TINY.file}.part.resume.json`), JSON.stringify(resume));
  const manager = new DownloadManager({
    modelsDir: directory,
    logger,
    getModel: getModel ?? ((id) => (id === TINY.id ? TINY : null)),
    fetchImpl: async () => new Response(body, { status }),
  });
  const job = await manager.start(TINY.id);
  for (let index = 0; index < 100 && ["queued", "downloading"].includes(manager.get(job.id).status); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { directory, final: manager.get(job.id) };
}

// IDEA-1067/1194: a completed download writes a measured receipt.
test("completed download writes an install receipt binding digest and source", async (t) => {
  const { directory, final } = await runTiny(t, TINY_BYTES);
  assert.equal(final.status, "complete");
  const receipt = await readInstallReceipt(directory, TINY.file);
  assert.equal(receipt.catalogId, TINY.id);
  assert.equal(receipt.digest, TINY.sha256);
  assert.equal(receipt.quant, TINY.quant);
  assert.match(receipt.url, /huggingface\.co/);
});

// IDEA-1195: a foreign partial without a matching identity is not resumed.
test("foreign partial bytes are discarded instead of appended", async (t) => {
  const foreign = Buffer.from("XXXX");
  const { directory, final } = await runTiny(t, TINY_BYTES, {
    status: 200,
    part: foreign,
    resume: { catalogId: "other-model", file: TINY.file, size: 9999, sha256: "0".repeat(64) },
  });
  assert.equal(final.status, "complete");
  const content = await readFile(path.join(directory, TINY.file));
  assert.deepEqual(content, TINY_BYTES);
  assert.deepEqual(await readdir(directory), [TINY.file, `${TINY.file}.receipt.json`]);
});
