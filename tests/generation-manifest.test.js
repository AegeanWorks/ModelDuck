import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatHistory,
  buildGenerationManifest,
  buildSystemPrompt,
  canReuseSession,
  manifestSummary,
  nextSessionHistoryLength,
  repeatPrompt,
} from "../src/generation-manifest.js";

const MODEL = {
  id: "abc123",
  fileName: "qwen.gguf",
  size: 1234,
  quant: "Q4_K_M",
  architecture: "qwen2",
  chatTemplateHash: "templatehash00001",
};
const SETTINGS = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1.1,
  promptRepeat: 1,
  maxTokens: 128,
  contextSize: 4096,
  seed: 42,
  reasoning: "off",
  structuredOutput: "none",
  jsonSchema: "",
  contextOverflow: "shift",
};

function manifest(overrides = {}) {
  return buildGenerationManifest({
    model: MODEL,
    originalSystemPrompt: "You are precise.",
    messages: [{ role: "user", content: "Earlier question" }],
    promptText: "What is 2 + 2?",
    settings: SETTINGS,
    runtimeVersion: "3.22.2",
    chatTemplateHash: "templatehash00001",
    ...overrides,
  });
}

test("the same generation input produces the same manifest digest", () => {
  const first = manifest();
  const second = manifest();
  assert.equal(first.digest, second.digest);
  assert.equal(first.shortDigest, first.digest.slice(0, 16));
  assert.equal(first.systemPrompt.effective, "You are precise.");
});

test("the system prompt and reasoning directive change the fingerprint", () => {
  const plain = manifest();
  const changed = manifest({ originalSystemPrompt: "You are brief." });
  const reasoning = manifest({ settings: { ...SETTINGS, reasoning: "auto" } });
  assert.notEqual(plain.systemPrompt.digest, changed.systemPrompt.digest);
  assert.notEqual(plain.digest, changed.digest);
  assert.match(reasoning.systemPrompt.effective, /Reason carefully/);
  assert.notEqual(plain.digest, reasoning.digest);
});

test("reasoning off keeps the base system prompt unchanged", () => {
  assert.equal(buildSystemPrompt("  base  ", "off"), "base");
  assert.equal(buildSystemPrompt("", "off"), "");
  assert.match(buildSystemPrompt("", "deep"), /Think through/);
});

test("the manifest hashes the exact truncated history the session receives", () => {
  const messages = [];
  for (let index = 0; index < 30; index += 1) {
    messages.push({ role: "user", content: `question ${index}` });
    messages.push({ role: "assistant", content: `answer ${index}` });
  }
  const history = buildChatHistory(messages);
  assert.equal(history.length, 40);
  const full = manifest({ messages, history });
  assert.equal(full.history.count, 40);
  assert.equal(full.history.truncated, true);

  const shorter = manifest({ messages: messages.slice(-6) });
  assert.equal(shorter.history.truncated, false);
  assert.notEqual(full.history.digest, shorter.history.digest);
  assert.notEqual(full.digest, shorter.digest);
});

test("history that starts with an assistant turn is marked as truncated", () => {
  const messages = [
    { role: "assistant", content: "orphan reply" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  const history = buildChatHistory(messages);
  assert.deepEqual(history, [{ type: "user", text: "hello" }, { type: "model", response: ["hi"] }]);
  assert.equal(manifest({ messages, history }).history.truncated, true);
});

test("prompt repetition changes the exact prompt text and its digest", () => {
  assert.equal(repeatPrompt("do x", 2), "do x\n\ndo x");
  assert.equal(repeatPrompt("do x", 1), "do x");
  assert.equal(repeatPrompt("do x", 9), "do x\n\ndo x\n\ndo x");
  const once = manifest();
  const twice = manifest({
    promptText: repeatPrompt("What is 2 + 2?", 2),
    settings: { ...SETTINGS, promptRepeat: 2 },
  });
  assert.notEqual(once.prompt.digest, twice.prompt.digest);
  assert.equal(twice.prompt.repeat, 2);
  assert.notEqual(once.digest, twice.digest);
});

test("runtime, chat template and sampling changes each change the fingerprint", () => {
  const base = manifest();
  const runtime = manifest({ runtimeVersion: "3.23.0" });
  const template = manifest({ chatTemplateHash: "templatehash00002" });
  const sampling = manifest({ settings: { ...SETTINGS, temperature: 0 } });
  for (const changed of [runtime, template, sampling]) {
    assert.notEqual(base.digest, changed.digest);
  }
  assert.equal(template.model.chatTemplateHash, "templatehash00002");
  assert.equal(runtime.runtime.nodeLlamaCpp, "3.23.0");
});

test("IDEA-1076: stops and the chat prefix are cache-keyed, never shared", () => {
  const base = manifest();
  const stopped = manifest({ settings: { ...SETTINGS, customStopTriggers: ["```"] } });
  const prefixed = manifest({ settings: { ...SETTINGS, responsePrefix: "```js\n" } });
  assert.notEqual(base.digest, stopped.digest);
  assert.notEqual(base.digest, prefixed.digest);
  assert.notEqual(stopped.digest, prefixed.digest);
  assert.deepEqual(stopped.settings.customStopTriggers, ["```"]);
  assert.equal(prefixed.settings.responsePrefix, "```js\n");
  // The identity copies the stops so later mutation cannot alias the key.
  const mutable = { ...SETTINGS, customStopTriggers: ["a"] };
  const keyed = manifest({ settings: mutable });
  mutable.customStopTriggers.push("b");
  assert.deepEqual(keyed.settings.customStopTriggers, ["a"]);
});

test("IDEA-1082: dropped history is marked without rebuilding the manifest", () => {
  const messages = [{ role: "user", content: "hello" }];
  const plain = manifest({ messages });
  assert.equal(plain.history.truncated, false);
  const dropped = manifest({ messages, forceHistoryTruncated: true });
  assert.equal(dropped.history.truncated, true);
  assert.notEqual(plain.digest, dropped.digest);
});

test("the summary carries only digests and counts", () => {
  const summary = manifestSummary(manifest());
  assert.equal(summary.fingerprintVersion, 1);
  assert.equal(summary.shortDigest.length, 16);
  assert.equal(summary.chatTemplateHash, "templatehash00001");
  assert.equal(summary.historyLength, 1);
  assert.equal(summary.historyTruncated, false);
  assert.equal(summary.systemPromptDigest.length, 64);
  assert.equal("systemPrompt" in summary, false);
  assert.equal(manifestSummary(null), null);
});

test("session reuse only matches an untruncated history and the next turn length", () => {
  const signature = "model::prompt::4096";
  const record = { signature, historyLength: 0 };
  assert.equal(
    canReuseSession(record, { signature, priorCount: 0, historyComplete: true }),
    true,
  );
  assert.equal(
    canReuseSession(record, { signature, priorCount: 2, historyComplete: true }),
    false,
  );
  assert.equal(
    canReuseSession(record, { signature: "other", priorCount: 0, historyComplete: true }),
    false,
  );
  assert.equal(
    canReuseSession(record, { signature, priorCount: 0, historyComplete: false }),
    false,
  );

  // First turn: one user message, then the session holds user + assistant.
  assert.equal(nextSessionHistoryLength(1, true), 2);
  record.historyLength = nextSessionHistoryLength(1, true);
  // Second turn: prior messages are user, assistant.
  assert.equal(
    canReuseSession(record, { signature, priorCount: 2, historyComplete: true }),
    true,
  );
  // Truncated history must never be marked reusable.
  assert.equal(nextSessionHistoryLength(3, false), null);
});
