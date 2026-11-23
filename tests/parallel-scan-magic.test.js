import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry, magicHeaderReads, SCAN_MAGIC_MODE } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Duck", size_label: "1B" }, tokenizer: { chat_template: "x" } },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [1, 1] }],
};

test("uncached magic headers are checked in parallel", () => {
  assert.equal(SCAN_MAGIC_MODE, "parallel");
});

test("a first scan validates every header and rejects non-GGUF files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-pmagic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "c.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  await writeFile(path.join(dir, "a.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  await writeFile(path.join(dir, "bad.gguf"), Buffer.from("NOPE-0123456789"));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  const before = magicHeaderReads();
  const models = await registry.scan();
  assert.deepEqual(models.map((model) => model.fileName), ["a.gguf", "c.gguf"]);
  assert.equal(magicHeaderReads(), before + 3, "all three files had their header checked");
});

test("a second scan reuses cached headers without rechecking", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-pmagic2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "a.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  await registry.scan();
  const before = magicHeaderReads();
  assert.equal((await registry.scan({ force: true })).length, 1);
  assert.equal(magicHeaderReads(), before);
});
