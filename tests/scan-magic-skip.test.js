import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry, magicHeaderReads } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Duck", size_label: "1B" }, tokenizer: { chat_template: "x" } },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [1, 1] }],
};

test("a cached force rescan does not re-read GGUF magic headers", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-magic-skip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "a.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  await writeFile(path.join(dir, "b.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });

  await registry.scan({ force: true });
  const afterFirst = magicHeaderReads();
  assert.equal((await registry.scan({ force: true })).length, 2);
  assert.equal(magicHeaderReads(), afterFirst, "unchanged cached files skip the header read");
});

test("a non-GGUF file is still rejected and re-checked", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-magic-reject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "bad.gguf"), Buffer.from("NOPE-0123456789"));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  assert.equal((await registry.scan({ force: true })).length, 0);
  const afterFirst = magicHeaderReads();
  assert.equal((await registry.scan({ force: true })).length, 0);
  assert.equal(magicHeaderReads(), afterFirst + 1, "uncached files are still checked");
});
