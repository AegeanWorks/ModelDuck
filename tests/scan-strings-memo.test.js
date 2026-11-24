import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createModelRegistry, quantFromNameComputations, resetModelScanStringCaches,
  templateOpensThinking, templateOpensThinkingComputations,
} from "../src/model-registry.js";

const INFO = { metadata: { general: { architecture: "llama", name: "M" } }, architectureMetadata: { context_length: 8192 }, tensorInfo: [] };

test("template thinking flags are derived once per template", () => {
  resetModelScanStringCaches();
  const open = "{% if add_generation_prompt %}<think>\n{% endif %}";
  assert.equal(templateOpensThinking(open), true);
  assert.equal(templateOpensThinkingComputations(), 1);
  const after = templateOpensThinkingComputations();
  assert.equal(templateOpensThinking(open), true);
  assert.equal(templateOpensThinkingComputations(), after, "repeated template is cached");
  assert.equal(templateOpensThinking("{% if add_generation_prompt %}<think></think>{% endif %}"), false);
  assert.equal(templateOpensThinkingComputations(), after + 1, "a different template gets its own entry");
  assert.equal(templateOpensThinking(null), false, "non-string templates still say no");
});

test("quant labels are derived once per file name across scans", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-quant-memo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "model-Q4_K_M.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(dir, "model-BF16.gguf"), Buffer.from("GGUF12345678"));
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  resetModelScanStringCaches();

  const first = await registry.scan({ force: true });
  assert.equal(quantFromNameComputations(), 2, "two distinct names derived once");
  assert.deepEqual(first.map((model) => model.quant).sort(), ["BF16", "Q4_K_M"]);
  const after = quantFromNameComputations();
  const second = await registry.scan({ force: true });
  assert.deepEqual(second, first);
  assert.equal(quantFromNameComputations(), after, "repeat scans reuse the labels");
});
