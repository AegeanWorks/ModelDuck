import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Meta Duck" } },
  architectureMetadata: { context_length: 8192 },
  tensorInfo: [],
};

function countMkdirs(t) {
  const real = fs.promises.mkdir;
  let calls = 0;
  fs.promises.mkdir = async (...args) => { calls += 1; return real(...args); };
  t.after(() => { fs.promises.mkdir = real; });
  return () => calls;
}

test("scanning an existing models dir does not call mkdir", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-scanstamp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "one.gguf"), Buffer.from("GGUF12345678"));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  const mkdirs = countMkdirs(t);

  const models = await registry.scan();
  assert.equal(models.length, 1, "the model is still found");
  assert.equal(mkdirs(), 0, "an existing models folder needs no mkdir");
});

test("a forced scan recreates a removed models dir", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-scanstamp2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "one.gguf"), Buffer.from("GGUF12345678"));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  await registry.scan();
  await rm(dir, { recursive: true, force: true });
  const mkdirs = countMkdirs(t);

  const models = await registry.scan({ force: true });
  assert.deepEqual(models, [], "empty library after recreation");
  assert.equal(mkdirs(), 1, "the missing folder is created once");
  assert.equal((await readdir(dir)).length, 0, "the folder exists again");
});
