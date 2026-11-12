import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultThreads, resolvePaths } from "../src/config.js";
import { LlamaEngine } from "../src/engine.js";
import {
  buildChatHistory,
  digest,
  PROMPT_FINGERPRINT_VERSION,
} from "../src/generation-manifest.js";
import { createModelRegistry } from "../src/model-registry.js";

const HELP = `
ModelDuck manifest verification

Usage:
  node benchmarks/verify-manifest.mjs --models-dir <folder>

Checks against a real GGUF model:
  - a second chat turn reuses the session (one setChatHistory call)
  - a 45-pair conversation truncates to 40 messages and hashes them
  - prompt repetition uses the duplicated text
  - a completion works after a chat session has occupied the sequence
  - the manifest carries the chat-template and runtime identity

This does not write benchmark history or change baselines.
`;

function parseArgs(argv) {
  const options = { modelsDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--models-dir") {
      options.modelsDir = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--models-dir=")) {
      options.modelsDir = arg.slice("--models-dir=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function findModel(registry) {
  const models = registry.listPublic();
  return (
    models.find((model) => /qwen2\.5-0\.5b.*q4_k_m/i.test(model.fileName)) ??
    models.find((model) => /qwen2\.5-0\.5b/i.test(model.fileName)) ??
    models[0] ??
    null
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const paths = resolvePaths({ models: options.modelsDir });
  const registry = createModelRegistry({ modelsDir: paths.models });
  await registry.scan();
  const entry = findModel(registry);
  if (!entry) {
    throw new Error(`No GGUF model found in ${paths.models}. Pass --models-dir.`);
  }

  const llama = await import("node-llama-cpp");
  const runtimeVersion = await llama.getModuleVersion().catch(() => "unknown");
  let historyCalls = 0;
  const originalSetHistory = llama.LlamaChatSession.prototype.setChatHistory;
  llama.LlamaChatSession.prototype.setChatHistory = function counted(...args) {
    historyCalls += 1;
    return originalSetHistory.apply(this, args);
  };

  const engine = new LlamaEngine({ registry });
  let failed = 0;
  const check = (name, condition, detail = "") => {
    const status = condition ? "PASS" : "FAIL";
    process.stdout.write(`  ${status} ${name}${detail ? ` (${detail})` : ""}\n`);
    if (!condition) failed += 1;
  };

  const ask = async ({ conversationId, messages, promptRepeat = 1 }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      return await engine.chat({
        conversationId,
        messages,
        systemPrompt: "Be brief.",
        settings: {
          temperature: 0,
          topP: 1,
          topK: 40,
          minP: 0.05,
          repeatPenalty: 1.1,
          promptRepeat,
          reasoning: "off",
          structuredOutput: "none",
          jsonSchema: "",
          seed: 42,
          contextOverflow: "shift",
          maxTokens: 8,
          contextSize: 2048,
        },
        signal: controller.signal,
        onToken: () => {},
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const complete = async ({ conversationId, prompt }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      return await engine.complete({
        conversationId,
        prompt,
        settings: {
          temperature: 0,
          topP: 1,
          topK: 40,
          minP: 0.05,
          repeatPenalty: 1.1,
          promptRepeat: 1,
          reasoning: "off",
          structuredOutput: "none",
          jsonSchema: "",
          seed: 42,
          contextOverflow: "shift",
          maxTokens: 8,
          contextSize: 2048,
        },
        signal: controller.signal,
        onToken: () => {},
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    process.stdout.write(`\nModelDuck manifest verification\n  model: ${entry.fileName}\n`);
    await engine.load({
      modelId: entry.id,
      contextSize: 2048,
      threads: defaultThreads(),
      maxThreads: defaultThreads(),
      batchSize: 512,
      sequences: 1,
      flashAttention: "auto",
      useMmap: "auto",
      gpuLayers: 0,
      gpuBackend: "cpu",
      checkpoints: true,
      kvCache: "f16",
    });

    const first = await ask({
      conversationId: "verify-reuse",
      messages: [{ role: "user", content: "Reply with exactly: one" }],
    });
    const beforeReuse = historyCalls;
    const second = await ask({
      conversationId: "verify-reuse",
      messages: [
        { role: "user", content: "Reply with exactly: one" },
        { role: "assistant", content: first.text },
        { role: "user", content: "Reply with exactly: two" },
      ],
    });
    check("second turn reuses the session", historyCalls === beforeReuse, `${historyCalls - beforeReuse} new setChatHistory call(s)`);
    check("reused manifest history count", second.manifest.history.count === 2, `${second.manifest.history.count}`);
    check(
      "reused history digest",
      second.manifest.history.digest === digest(buildChatHistory([
        { role: "user", content: "Reply with exactly: one" },
        { role: "assistant", content: first.text },
      ])),
    );
    engine.dropSession("verify-reuse");

    const longMessages = [];
    for (let index = 0; index < 45; index += 1) {
      longMessages.push({ role: "user", content: `Question ${index}` });
      longMessages.push({ role: "assistant", content: `Answer ${index}` });
    }
    longMessages.push({ role: "user", content: "Reply with exactly: done" });
    const beforeTruncated = historyCalls;
    const truncated = await ask({ conversationId: "verify-truncated", messages: longMessages });
    const expectedHistory = buildChatHistory(longMessages.slice(0, -1));
    check("long history is truncated", truncated.manifest.history.truncated === true);
    check("long history keeps 40 messages", truncated.manifest.history.count === 40, `${truncated.manifest.history.count}`);
    check("truncated history digest", truncated.manifest.history.digest === digest(expectedHistory));
    check("truncated session is rebuilt", historyCalls === beforeTruncated + 1);
    engine.dropSession("verify-truncated");

    const prompt = "Reply with exactly: quack";
    const repeated = await ask({
      conversationId: "verify-repeat",
      messages: [{ role: "user", content: prompt }],
      promptRepeat: 2,
    });
    const repeatedPrompt = `${prompt}\n\n${prompt}`;
    check("prompt repeat count", repeated.manifest.prompt.repeat === 2);
    check("prompt repeat text", repeated.manifest.prompt.text === repeatedPrompt);
    check("prompt repeat digest", repeated.manifest.prompt.digest === digest(repeatedPrompt));
    check(
      "manifest schema version",
      repeated.manifest.fingerprintVersion === PROMPT_FINGERPRINT_VERSION,
    );
    check(
      "chat template identity",
      Boolean(entry.chatTemplateHash) &&
        repeated.manifest.model.chatTemplateHash === entry.chatTemplateHash,
      repeated.manifest.model.chatTemplateHash ?? "missing",
    );
    check(
      "runtime identity",
      repeated.manifest.runtime.nodeLlamaCpp === runtimeVersion,
      runtimeVersion,
    );
    const completion = await complete({
      conversationId: "verify-completion",
      prompt: "The capital of France is",
    });
    check("completion after chat session", completion.text.trim().length > 0);
    check("completion did not abort", completion.aborted === false);
    engine.dropSession("verify-completion");
    engine.dropSession("verify-repeat");

    if (failed) {
      process.stdout.write(`\n${failed} check(s) failed.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("\nAll manifest checks passed.\n");
    }
  } finally {
    await engine.dispose().catch(() => {});
  }
}

// A CLI, not a library: importing this module must not verify anything
// (the same guard report.mjs and merge-shards.mjs already ship).
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`\n[verify-manifest] ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
