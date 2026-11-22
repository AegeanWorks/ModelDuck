import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Duck", size_label: "1B" }, tokenizer: { chat_template: "{{ messages }}" } },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [100, 100] }],
};

test("an externally deleted model loses its sampling override even on a cached scan", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-stale-override-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  const file = path.join(dir, "model.gguf");
  await writeFile(file, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  const [model] = await registry.scan();
  registry.setModelSampling(model.id, { temperature: 0.1 });
  await rm(file);
  // Two fast full scans: the directory stamp may not move within the TTL.
  await registry.scan();
  assert.equal(registry.getModelSampling(model.id), null);
  await registry.scan();
  assert.equal(registry.getModelSampling(model.id), null);
});
