import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DownloadManager } from "../src/downloader.js";

const logger = { warn() {}, error() {} };

async function makeManager(t, fetchImpl) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-downloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new DownloadManager({ modelsDir: directory, logger, fetchImpl });
}

test("unknown catalogue ids are rejected before any network work", async (t) => {
  const manager = await makeManager(t, async () => {
    throw new Error("should not fetch");
  });
  await assert.rejects(
    () => manager.start("not-a-model"),
    (error) => error.code === "catalog_model_not_found",
  );
});

test("a cancel that arrives before the worker starts leaves the job canceled", async (t) => {
  const manager = await makeManager(t, async () => {
    throw new Error("should not fetch");
  });
  const job = await manager.start("smollm2-135m-instruct-q4");
  await manager.cancel(job.id);
  await new Promise((resolve) => setImmediate(resolve));

  const current = manager.get(job.id);
  assert.equal(current.status, "canceled");
  assert.equal(current.received, 0);
});

test("starting a model that is already downloading reuses that job instead of writing the file twice", async (t) => {
  let fetches = 0;
  let release;
  let fetched;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const firstFetch = new Promise((resolve) => {
    fetched = resolve;
  });
  const manager = await makeManager(t, async (url, { signal }) => {
    fetches += 1;
    fetched();
    await gate;
    signal.throwIfAborted();
    throw new Error("network disabled in tests");
  });
  const first = await manager.start("smollm2-135m-instruct-q4");
  const second = await manager.start("smollm2-135m-instruct-q4");
  assert.equal(second.id, first.id);
  assert.equal(manager.list().length, 1);

  await firstFetch;
  assert.equal((await manager.start("smollm2-135m-instruct-q4")).id, first.id, "still one job mid-download");
  assert.equal(fetches, 1);
  release();
  await manager.cancel(first.id);
});

test("a download that stops sending data fails as stalled and keeps its partial file", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-downloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new DownloadManager({
    modelsDir: directory,
    logger,
    idleTimeoutMs: 40,
    fetchImpl: async (url, { signal }) => {
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(1024));
            return undefined;
          }
          return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          });
        },
      });
      return new Response(body, { status: 200 });
    },
  });
  const job = await manager.start("smollm2-135m-instruct-q4");
  for (let index = 0; index < 100 && ["queued", "downloading"].includes(manager.get(job.id).status); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const final = manager.get(job.id);
  assert.equal(final.status, "error");
  assert.match(final.error.message, /stalled/i);
  assert.match(final.error.fix, /resume/i);
  const files = await readdir(directory);
  assert.ok(files.some((name) => name.endsWith(".part")), files.join(","));
});

const TINY_BYTES = Buffer.from("GGUFduck");
const TINY = {
  id: "tiny",
  name: "Tiny Duck",
  file: "tiny.gguf",
  repo: "duck/tiny",
  size: TINY_BYTES.length,
  sha256: createHash("sha256").update(TINY_BYTES).digest("hex"),
};

async function tinyManager(t, body, { status = 200, part = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-downloads-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (part) await writeFile(path.join(directory, `${TINY.file}.part`), part);
  const manager = new DownloadManager({
    modelsDir: directory,
    logger,
    getModel: (id) => (id === TINY.id ? TINY : null),
    fetchImpl: async () => new Response(body, { status }),
  });
  const job = await manager.start(TINY.id);
  for (let index = 0; index < 100 && ["queued", "downloading"].includes(manager.get(job.id).status); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { directory, final: manager.get(job.id) };
}

test("a download whose bytes match the catalog SHA-256 is promoted", async (t) => {
  const { directory, final } = await tinyManager(t, TINY_BYTES);
  assert.equal(final.status, "complete");
  const files = await readdir(directory);
  assert.ok(files.includes(TINY.file), files.join(","));
});

test("a right-sized download with the wrong content is rejected and removed", async (t) => {
  const { directory, final } = await tinyManager(t, Buffer.from("AAAAAAAA"));
  assert.equal(final.status, "error");
  assert.match(final.error.message, /corrupt|did not match/i);
  assert.deepEqual(await readdir(directory), []);
});

test("a resumed download hashes the existing partial bytes too", async (t) => {
  const { final } = await tinyManager(t, TINY_BYTES.subarray(4), { status: 206, part: TINY_BYTES.subarray(0, 4) });
  assert.equal(final.status, "complete");
});

test("every catalog model pins a SHA-256 from its Hugging Face LFS pointer", async () => {
  const { MODEL_CATALOG } = await import("../src/model-catalog.js");
  for (const model of MODEL_CATALOG) assert.match(model.sha256 ?? "", /^[0-9a-f]{64}$/, model.id);
});

// IDEA-1381: durable promotion fsyncs the file and directory before exposing it.
test("IDEA-1381: promotion fsyncs the file and directory before exposing it", async (t) => {
  const { promoteFileAtomic, fsyncFile, fsyncDirectory } = await import("../src/fs-atomic.js");
  assert.equal(typeof promoteFileAtomic, "function");
  assert.equal(typeof fsyncFile, "function");
  assert.equal(typeof fsyncDirectory, "function");
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-promote-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const part = path.join(directory, "model.gguf.part");
  const final = path.join(directory, "model.gguf");
  await writeFile(part, Buffer.from("GGUFduck"));
  await promoteFileAtomic(part, final);
  const files = await readdir(directory);
  assert.ok(files.includes("model.gguf"), files.join(","));
  assert.ok(!files.some((name) => name.endsWith(".part")), files.join(","));
  // Helpers are best-effort and never throw on missing paths.
  await fsyncFile(path.join(directory, "missing.gguf"));
  await fsyncDirectory(directory);
});
