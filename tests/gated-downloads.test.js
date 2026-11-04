import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DownloadManager, gatedDownloadHeaders } from "../src/downloader.js";
import { createModelRegistry } from "../src/model-registry.js";

const SILENT = { warn() {}, error() {}, info() {} };
const FAKE_INFO = {
  metadata: { general: { architecture: "llama" }, tokenizer: {} },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [8, 8] }],
};

// IDEA-1073: the broker only speaks when a token exists, and never logs it.
test("token broker stays silent without HF_TOKEN", () => {
  const saved = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  try {
    assert.deepEqual(gatedDownloadHeaders(), {});
    assert.ok("Authorization" in gatedDownloadHeaders({ token: "secret" }));
  } finally {
    if (saved !== undefined) process.env.HF_TOKEN = saved;
  }
});

// IDEA-1073: gated models fail with the token fix, not a bare 502.
test("a 401 names the HF_TOKEN remedy", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-gated-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new DownloadManager({
    modelsDir: directory,
    logger: SILENT,
    getModel: (id) => (id === "tiny" ? { id: "tiny", name: "Tiny", file: "tiny.gguf", repo: "x/y", size: 8, sha256: null } : null),
    fetchImpl: async () => new Response("private", { status: 401 }),
  });
  const job = await manager.start("tiny");
  for (let index = 0; index < 100 && ["queued", "downloading"].includes(manager.get(job.id).status); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const final = manager.get(job.id);
  assert.equal(final.status, "error");
  assert.equal(final.error.message, "Download failed with HTTP 401");
  assert.match(final.error.fix, /HF_TOKEN/);
  assert.ok(!JSON.stringify(final).includes("Bearer"), "the token never lands in job state");
});

// IDEA-1072: an extensionless HF blob behind a symlink still counts.
test("HF cache blobs resolve read-only through links", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-hf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blob = path.join(directory, "blobs", "abcdef1234567890");
  await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(blob), { recursive: true }));
  await writeFile(blob, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64, 7)]));
  try {
    await symlink(blob, path.join(directory, "snapshot-link"));
  } catch {
    return;
  }
  const registry = createModelRegistry({ modelsDir: directory, readMetadata: async () => FAKE_INFO, logger: SILENT });
  const found = await registry.scan();
  assert.ok(found.some((entry) => entry.fileName === "snapshot-link"));
});
