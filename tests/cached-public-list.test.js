import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry, listPublicRebuilds } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Duck", size_label: "1B" }, tokenizer: { chat_template: "{{ messages }}" } },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [100, 100] }],
};

async function makeRegistry(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-public-list-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  return { dir, registry };
}

async function addModel(dir, name) {
  await writeFile(path.join(dir, name), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
}

test("listPublic builds the sorted list once until entries change", async (t) => {
  const { dir, registry } = await makeRegistry(t);
  await addModel(dir, "b.gguf");
  await addModel(dir, "a.gguf");
  await registry.scan();

  const before = listPublicRebuilds();
  const first = registry.listPublic();
  const second = registry.listPublic();
  assert.deepEqual(second, first);
  assert.equal(listPublicRebuilds(), before, "unchanged entries reuse the cached list");

  // A caller mutating its array must not corrupt the cache for the next caller.
  first.push("tamper");
  const third = registry.listPublic();
  assert.equal(third.length, 2);
  assert.equal(listPublicRebuilds(), before, "the cached list is shared read-only");
});

test("deleting a model invalidates the cached list", async (t) => {
  const { dir, registry } = await makeRegistry(t);
  await addModel(dir, "a.gguf");
  await addModel(dir, "b.gguf");
  await registry.scan();
  const before = listPublicRebuilds();
  const first = registry.listPublic();
  const id = first[0].id;
  await registry.deleteById(id);
  const after = registry.listPublic();
  assert.equal(after.length, 1);
  assert.ok(!after.some((model) => model.id === id));
  assert.equal(listPublicRebuilds(), before + 1, "the delete forced exactly one rebuild");
});
