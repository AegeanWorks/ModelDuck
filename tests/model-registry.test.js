import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppError } from "../src/errors.js";
import { createModelRegistry, resolveModelSettings } from "../src/model-registry.js";

const logger = { warn() {} };
const INFO = {
  metadata: {
    general: { architecture: "llama", name: "Meta Duck", size_label: "1.2B" },
    tokenizer: { chat_template: "template" },
  },
  architectureMetadata: { context_length: 8192 },
  tensorInfo: [{ dimensions: [10, 10] }],
};

async function makeRegistry(t, { metadata = async () => INFO } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createModelRegistry({
    modelsDir: directory,
    readMetadata: metadata,
    logger,
  });
  return { directory, registry };
}

test("scan finds GGUF files, ignores partials and non-models, and exposes metadata", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  await writeFile(path.join(directory, "meta.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "ignored.gguf.part"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "notes.txt"), "hello");
  await writeFile(path.join(directory, "fake.gguf"), "not a gguf file");

  const models = await registry.scan();
  assert.equal(models.length, 1);
  assert.equal(models[0].name, "Meta Duck");
  assert.equal(models[0].params, "1.2B");
  assert.equal(models[0].quant, "GGUF");
  assert.equal(models[0].contextLength, 8192);
  assert.equal(models[0].chatTemplate, true);
  assert.equal(models[0].chatTemplateHash, "5cde0f1298f41f7d");
  assert.equal(models[0].path, undefined);
  assert.match(models[0].id, /^[a-f0-9]{12}$/);
});

test("a repeated scan reuses the result, force bypasses it, and a new file invalidates", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  await writeFile(path.join(directory, "one.gguf"), Buffer.from("GGUF12345678"));
  const first = await registry.scan();
  const afterFirst = registry.scanStats();
  const second = await registry.scan();
  const afterSecond = registry.scanStats();
  assert.deepEqual(second, first);
  assert.equal(afterFirst.misses, 1);
  assert.equal(afterSecond.hits, afterFirst.hits + 1);
  await registry.scan({ force: true });
  assert.equal(registry.scanStats().misses, afterSecond.misses + 1);
  await writeFile(path.join(directory, "two.gguf"), Buffer.from("GGUF87654321"));
  const third = await registry.scan({ force: true });
  assert.equal(third.length, 2, "a force scan sees the new file");
});

test("scan keeps a stable id when the file does not change", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  await writeFile(path.join(directory, "stable.gguf"), Buffer.from("GGUF12345678"));
  const first = (await registry.scan())[0].id;
  const second = (await registry.scan())[0].id;
  assert.equal(first, second);
});

test("an unreadable header still produces a model entry with a warning", async (t) => {
  const { directory, registry } = await makeRegistry(t, {
    metadata: async () => {
      throw new Error("bad header");
    },
  });
  await writeFile(path.join(directory, "broken.gguf"), Buffer.from("GGUF12345678"));
  const models = await registry.scan();
  assert.equal(models.length, 1);
  assert.equal(models[0].unreadable, true);
  assert.equal(models[0].unreadableReason, "bad header");
});

test("import copies a valid GGUF and delete removes it", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  const source = path.join(directory, "..", `import-${Date.now()}.gguf`);
  await writeFile(source, Buffer.from("GGUF12345678"));
  t.after(() => rm(source, { force: true }));

  const imported = await registry.importFromPath(source);
  assert.equal(imported.fileName, path.basename(source));
  assert.equal(registry.size, 1);

  const deleted = await registry.deleteById(imported.id);
  assert.equal(deleted.id, imported.id);
  assert.equal((await registry.scan()).length, 0);
});

test("import rejects a non-GGUF file with an actionable error", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  const source = path.join(directory, "not-a-model.gguf");
  await writeFile(source, "plain text");

  await assert.rejects(
    () => registry.importFromPath(source),
    (error) =>
      error instanceof AppError &&
      error.code === "invalid_gguf" &&
      error.fix.length > 0,
  );
});

test("delete refuses a loaded model and paths outside the library", async (t) => {  const { directory, registry } = await makeRegistry(t);
  await writeFile(path.join(directory, "loaded.gguf"), Buffer.from("GGUF12345678"));
  const [model] = await registry.scan();
  await assert.rejects(
    () => registry.deleteById(model.id, { loadedId: model.id }),
    (error) => error instanceof AppError && error.code === "model_in_use",
  );
  await assert.rejects(
    () => registry.deleteById("does-not-exist"),
    (error) => error instanceof AppError && error.status === 404,
  );
  assert.deepEqual(await readdir(directory), ["loaded.gguf"]);
});

// IDEA-1675: per-model stops die with the model instead of attaching to the
// next file that reuses the folder.
test("per-model sampling overrides are pruned on delete and rescan", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  await writeFile(path.join(directory, "a.gguf"), Buffer.from("GGUF12345678"));
  const [model] = await registry.scan();
  assert.deepEqual(
    registry.setModelSampling(model.id, { temperature: 0.2, customStopTriggers: ["```"] }),
    { temperature: 0.2, customStopTriggers: ["```"] },
  );
  assert.deepEqual(registry.getModelSampling(model.id), { temperature: 0.2, customStopTriggers: ["```"] });
  const resolved = resolveModelSettings({ temperature: 0.7 }, registry.getModelSampling(model.id));
  assert.equal(resolved.temperature, 0.2, "the standalone merge helper takes (global, override) and the override wins");

  // Unknown keys never make it into the store.
  assert.deepEqual(registry.setModelSampling(model.id, { maxTokens: 1 }), {});

  // Delete drops the override with the file.
  await registry.deleteById(model.id);
  assert.equal(registry.getModelSampling(model.id), null);

  // And a rescan drops overrides for models that vanished outside the API.
  await writeFile(path.join(directory, "b.gguf"), Buffer.from("GGUF12345678"));
  const [again] = await registry.scan();
  registry.setModelSampling(again.id, { temperature: 0.1 });
  assert.ok(registry.getModelSampling(again.id));
  await rm(path.join(directory, "b.gguf"));
  await registry.scan();
  assert.equal(registry.getModelSampling(again.id), null, "a rescan prunes overrides for missing files");
});

// A tune process needs one model: reading every file's GGUF metadata cost 8.1 s
// for a 16-model library on every start, three times per model in a quick pass.
test("a narrowed scan reads metadata only for the files it keeps", async (t) => {
  const read = [];
  const { directory, registry } = await makeRegistry(t, { metadata: async (file) => { read.push(path.basename(file)); return INFO; } });
  await writeFile(path.join(directory, "wanted.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "other-a.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "other-b.gguf"), Buffer.from("GGUF12345678"));

  const models = await registry.scan({ only: (file) => path.basename(file) === "wanted.gguf" });
  assert.deepEqual(models.map((model) => model.fileName), ["wanted.gguf"]);
  assert.deepEqual(read, ["wanted.gguf"], "the other files' metadata is never read");
  const [entry] = models;
  assert.equal(registry.findById(entry.id).fileName, "wanted.gguf", "the kept model is usable by id");
});

test("a narrowed scan offers the id the full scan would give, and never stands in for a full listing", async (t) => {
  const { directory, registry } = await makeRegistry(t);
  await writeFile(path.join(directory, "wanted.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "other.gguf"), Buffer.from("GGUF12345678"));
  const full = await registry.scan({ force: true });
  const wantedId = full.find((model) => model.fileName === "wanted.gguf").id;

  const seen = [];
  const narrowed = await registry.scan({ only: (file, { id }) => { seen.push(id); return id === wantedId; } });
  assert.deepEqual(narrowed.map((model) => model.id), [wantedId], "matching by id works");
  assert.ok(seen.includes(wantedId));
  const again = await registry.scan();
  assert.equal(again.length, 2, "the next plain scan lists everything instead of reusing the narrowed one");
});

test("a narrowed scan leaves the other models' sampling overrides and metadata cache alone", async (t) => {
  const read = [];
  const { directory, registry } = await makeRegistry(t, { metadata: async (file) => { read.push(path.basename(file)); return INFO; } });
  await writeFile(path.join(directory, "wanted.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "other.gguf"), Buffer.from("GGUF12345678"));
  const full = await registry.scan({ force: true });
  const otherId = full.find((model) => model.fileName === "other.gguf").id;
  registry.setModelSampling(otherId, { temperature: 0.3 });
  assert.equal(registry.getModelSampling(otherId)?.temperature, 0.3);

  await registry.scan({ only: (file) => path.basename(file) === "wanted.gguf" });
  assert.equal(registry.getModelSampling(otherId)?.temperature, 0.3, "a model left out of the narrowed list still exists on disk");
  read.length = 0;
  await registry.scan({ force: true });
  assert.deepEqual(read, [], "the full scan after it reuses every cached header");
});
