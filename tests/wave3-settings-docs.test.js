import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SETTINGS,
  SETTING_PRESETS,
  applyPreset,
  normalizeSettings,
} from "../src/config.js";
import { buildSystemPrompt } from "../src/generation-manifest.js";
import { createModelRegistry } from "../src/model-registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// IDEA-1675: per-model stops/sampling registry isolates models, falls back to global.
test("IDEA-1675 per-model sampling registry isolates models with global fallback", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-wave3-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const INFO = (template) => ({
    metadata: {
      general: { architecture: "llama", name: "Duck", size_label: "1B" },
      tokenizer: { chat_template: template },
    },
    architectureMetadata: { context_length: 4096 },
    tensorInfo: [{ dimensions: [10, 10] }],
  });
  let call = 0;
  const registry = createModelRegistry({
    modelsDir: directory,
    readMetadata: async () => INFO(call++ === 0 ? "template-a" : "template-b"),
    logger: { warn() {} },
  });
  await writeFile(path.join(directory, "a.gguf"), Buffer.from("GGUF12345678"));
  await writeFile(path.join(directory, "b.gguf"), Buffer.from("GGUF12345678"));
  const models = await registry.scan();
  assert.equal(models.length, 2);
  const [modelA, modelB] = models.sort((x, y) => x.fileName.localeCompare(y.fileName));
  assert.ok(modelA.chatTemplateHash, "chat template hash is stored");
  assert.notEqual(modelA.chatTemplateHash, modelB.chatTemplateHash);

  assert.equal(typeof registry.setModelSampling, "function");
  assert.equal(typeof registry.resolveModelSettings, "function");

  const global = normalizeSettings({ customStopTriggers: ["```"], temperature: 0.7 });
  registry.setModelSampling(modelA.id, { customStopTriggers: ["<|eot|>"], temperature: 0.2 });

  const forA = registry.resolveModelSettings(modelA.id, global);
  const forB = registry.resolveModelSettings(modelB.id, global);
  assert.deepEqual(forA.customStopTriggers, ["<|eot|>"]);
  assert.equal(forA.temperature, 0.2);
  assert.deepEqual(forB.customStopTriggers, ["```"], "model B falls back to global");
  assert.equal(forB.temperature, 0.7, "no cross-model bleed");
});

// IDEA-1676: reasoning defaults off for chat/drafts.
test("IDEA-1676 reasoning defaults off but explicit auto/deep still work", () => {
  assert.equal(DEFAULT_SETTINGS.reasoning, "off");
  assert.equal(normalizeSettings({}).reasoning, "off");
  assert.equal(normalizeSettings({ reasoning: undefined }).reasoning, "off");
  assert.equal(normalizeSettings({ reasoning: "auto" }).reasoning, "auto");
  assert.equal(normalizeSettings({ reasoning: "deep" }).reasoning, "deep");
  assert.equal(buildSystemPrompt("  base  ", "off"), "base");
  assert.match(buildSystemPrompt("", "deep"), /Think through/);
});

// IDEA-1496: temperature-as-cost cheap preset pairs low-temp with truncated top-p.
test("IDEA-1496 cheap preset resolves with tuner-v8 low-temp pairing", () => {
  assert.ok(SETTING_PRESETS.cheap, "cheap preset exists");
  const preset = applyPreset("cheap", { systemPrompt: "keep me" });
  assert.equal(preset.temperature, 0.2);
  assert.equal(preset.topP, 0.8);
  assert.equal(preset.minP, 0.1);
  assert.equal(preset.reasoning, "off");
  assert.equal(preset.systemPrompt, "keep me");
});

// IDEA-1644: seven-party threat model doc exists, concise, linked.
test("IDEA-1644 threat model doc exists, is concise, and is linked", async () => {
  const docPath = path.join(ROOT, "docs", "THREAT-MODEL.md");
  const text = await fs.readFile(docPath, "utf8");
  const lines = text.trim().split("\n");
  assert.ok(lines.length < 100, `threat model is ${lines.length} lines, must be under 100`);
  for (const party of ["user", "model publisher", "host os", "lan", "skill", "benchmark", "runtime"]) {
    assert.match(text.toLowerCase(), new RegExp(party.replace(/ /g, ".*")), `mentions ${party}`);
  }
  const readme = await fs.readFile(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /THREAT-MODEL\.md/);
});
