import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry, SCAN_STAT_MODE } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Duck", size_label: "1B" }, tokenizer: { chat_template: "x" } },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [1, 1] }],
};

test("the scan gathers independent file stats in parallel", () => {
  assert.equal(SCAN_STAT_MODE, "parallel");
});

test("parallel stat handling keeps valid models and rejects the rest", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-pstat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "b.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  await writeFile(path.join(dir, "a.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  await writeFile(path.join(dir, "bad.gguf"), Buffer.from("NOPE-0123456789"));
  await writeFile(path.join(dir, "tiny.gguf"), Buffer.from("GG"));
  await writeFile(path.join(dir, "skip.txt"), Buffer.from("GGUF-not-a-model"));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  const models = await registry.scan({ force: true });
  assert.deepEqual(models.map((model) => model.fileName), ["a.gguf", "b.gguf"]);
  assert.equal(models.length, 2);
});
