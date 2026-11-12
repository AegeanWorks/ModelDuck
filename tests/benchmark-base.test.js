import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHAT_BASE_FILE,
  chatBaseSettings,
  loadChatBase,
  resolveChatBase,
  selectChatBase,
  selectionFromVariant,
} from "../src/benchmark-base.js";

const MODEL = {
  key: "qwen2.5-coder-1.5b-instruct", // aikit:allow-secret model name
  variantId: "coder-f16",
  label: "Qwen2.5 Coder 1.5B · Q4_K_M · KV F16",
  fileName: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
  catalogId: "qwen2.5-coder-1.5b-instruct-q4",
  kvCache: "f16",
  contextSize: 2048,
  requestedContextSize: 4096,
  threads: 6,
  maxThreads: 8,
  batchSize: 512,
  sequences: 1,
  flashAttention: "auto",
  useMmap: "auto",
  gpuLayers: 0,
  checkpoints: true,
  items: { passed: 70, total: 91, rate: 76.9 },
  error: null,
};

async function fixture(t, models = [MODEL]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-chat-base-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "baseline-model.json"),
    `${JSON.stringify({ phase: "model", models })}\n`,
  );
  return directory;
}

test("a measured variant becomes an apply-ready chat base", () => {
  const selection = selectionFromVariant(MODEL);
  assert.equal(selection.schema, 1);
  assert.equal(selection.variantId, "coder-f16");
  assert.equal(selection.catalogId, "qwen2.5-coder-1.5b-instruct-q4");
  assert.equal(selection.family, "qwen2.5-coder-1.5b-instruct");
  assert.equal(selection.settings.contextSize, 4096, "the requested context wins over a fallback");
  assert.equal(selection.settings.threads, 6);
  assert.equal(selection.settings.checkpoints, true);
  assert.deepEqual(chatBaseSettings(selection), {
    ...selection.settings,
    catalogId: selection.catalogId,
    family: selection.family,
    label: selection.label,
    fileName: selection.fileName,
  });
});

test("selecting writes chat-base.json and loadChatBase reads it back", async (t) => {
  const directory = await fixture(t);
  const selection = await selectChatBase({ benchmarkDir: directory, variantId: "coder-f16" });
  const written = JSON.parse(await readFile(path.join(directory, CHAT_BASE_FILE), "utf8"));
  assert.equal(written.variantId, "coder-f16");
  assert.equal(selection.selectedAt, written.selectedAt);
  const loaded = await loadChatBase({ benchmarkDir: directory });
  assert.deepEqual(loaded, selection);
});

test("an unknown variant and a failed variant cannot be selected", async (t) => {
  const directory = await fixture(t, [MODEL, { ...MODEL, variantId: "bad", error: "load failed", items: null }]);
  await assert.rejects(
    resolveChatBase({ benchmarkDir: directory, variantId: "missing" }),
    (error) => error.code === "chat_base_variant_missing" && error.status === 404,
  );
  await assert.rejects(
    resolveChatBase({ benchmarkDir: directory, variantId: "bad" }),
    (error) => error.code === "chat_base_invalid" && error.status === 422,
  );
});

test("no model result and a corrupt saved base produce actionable errors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-chat-base-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    resolveChatBase({ benchmarkDir: directory, variantId: "coder-f16" }),
    (error) => error.code === "model_benchmark_missing" && error.status === 409,
  );
  await writeFile(path.join(directory, CHAT_BASE_FILE), "{not json\n");
  await assert.rejects(
    loadChatBase({ benchmarkDir: directory }),
    (error) => error.code === "chat_base_invalid" && error.status === 422,
  );
});
