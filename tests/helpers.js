import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DownloadManager } from "../src/downloader.js";
import { ensureDirectory } from "../src/fs-atomic.js";
import { JitManager } from "../src/jit.js";
import { currentFingerprint } from "../src/model-profiles.js";
import { createModelRegistry } from "../src/model-registry.js";
import { createHttpServer } from "../src/server.js";
import { ServerSettingsStore } from "../src/server-settings.js";
import { SettingsStore } from "../src/settings.js";
import { resolvePaths } from "../src/config.js";

const FAKE_INFO = {
  metadata: {
    general: {
      architecture: "llama",
      name: "Test Duck 1B",
      size_label: "1B",
    },
    tokenizer: { chat_template: "{{ messages }}" },
  },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [100, 100] }],
};

const SILENT_LOGGER = {
  warn() {},
  error() {},
  info() {},
};

export class FakeEngine {
  constructor() {
    this.activeIds = new Set();
    this.manifest = {
      fingerprintVersion: 1,
      digest: "a".repeat(64),
      shortDigest: "a".repeat(16),
      runtime: { nodeLlamaCpp: "test" },
      model: { digest: "b".repeat(64), chatTemplateHash: "c".repeat(16) },
      systemPrompt: { digest: "d".repeat(64) },
      history: { count: 1, truncated: false, digest: "e".repeat(64) },
      prompt: { repeat: 1, digest: "f".repeat(64) },
      settings: {},
    };
    this.state = {
      status: "ready",
      model: {
        id: "fake-model",
        name: "Test Duck 1B",
        fileName: "test-model.gguf",
        size: 36,
        sizeLabel: "36 B",
        quant: "Q4_K_M",
        params: "1B",
        architecture: "llama",
        contextLength: 4096,
      },
      contextSize: 2048,
      trainContextSize: 4096,
      threads: 2,
      loadedAt: new Date().toISOString(),
      error: null,
      lastStats: null,
    };
  }

  get loadedId() {
    return this.state.model?.id ?? null;
  }

  get busy() {
    return this.activeIds.size > 0;
  }

  async status() {
    return { ...this.state, memory: { cpuRam: 1024, gpuVram: 0 } };
  }

  async load({ modelId }) {
    this.state = {
      ...this.state,
      status: "ready",
      model: { ...this.state.model, id: modelId },
      error: null,
    };
    return { ...this.state };
  }

  async unload() {
    this.state = { status: "idle", model: null, contextSize: null, threads: null };
  }

  abort(id) {
    return this.activeIds.delete(id);
  }

  dropSession() {}

  async chat({ conversationId, onToken, signal }) {
    this.activeIds.add(conversationId);
    try {
      for (const token of ["Quack", "!"]) {
        if (signal?.aborted) {
          return {
            text: "Quack",
            aborted: true,
            stats: { promptTokens: 3, outputTokens: 1, tokensPerSecond: 1, ms: 1 },
            manifest: this.manifest,
          };
        }
        onToken(token);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return {
        text: "Quack!",
        aborted: false,
        stats: {
          promptTokens: 3,
          outputTokens: 2,
          tokensPerSecond: 20,
          firstTokenMs: 1,
          ms: 5,
          stopReason: "eogToken",
        },
        manifest: this.manifest,
      };
    } finally {
      this.activeIds.delete(conversationId);
    }
  }

  async complete({ conversationId, onToken, signal }) {
    this.activeIds.add(conversationId);
    try {
      for (const token of ["Quack", "!"]) {
        if (signal?.aborted) {
          return {
            text: "Quack",
            aborted: true,
            stats: { promptTokens: 3, outputTokens: 1, tokensPerSecond: 1, ms: 1 },
            manifest: this.manifest,
          };
        }
        onToken(token);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return {
        text: "Quack!",
        aborted: false,
        stats: {
          promptTokens: 3,
          outputTokens: 2,
          tokensPerSecond: 20,
          firstTokenMs: 1,
          ms: 5,
          stopReason: "eogToken",
        },
        manifest: this.manifest,
      };
    } finally {
      this.activeIds.delete(conversationId);
    }
  }
}

export async function makeHarness(
  t,
  { models = 1, engine = new FakeEngine(), benchmarkDir = null, benchmarks = null, tunes = null, host = "127.0.0.1", baseHost = "127.0.0.1", reloadLease = null } = {},
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "modelduck-test-"));
  const paths = resolvePaths({ home });
  await ensureDirectory(paths.models);

  let modelId = null;
  for (let index = 0; index < models; index += 1) {
    const file = path.join(paths.models, `test-model-${index}.gguf`);
    await writeFile(file, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64, index + 1)]));
  }

  const settings = new SettingsStore({ file: paths.settings, logger: SILENT_LOGGER });
  const serverSettings = new ServerSettingsStore({ file: paths.serverSettings, logger: SILENT_LOGGER });
  await settings.load();
  await serverSettings.load();

  const registry = createModelRegistry({
    modelsDir: paths.models,
    readMetadata: async () => FAKE_INFO,
    logger: SILENT_LOGGER,
  });
  const found = await registry.scan();
  modelId = found[0]?.id ?? null;

  const downloads = new DownloadManager({
    modelsDir: paths.models,
    logger: SILENT_LOGGER,
    fetchImpl: async () => {
      throw new Error("network disabled in tests");
    },
  });
  const jit = new JitManager({ engine, registry, settings, serverSettings, logger: SILENT_LOGGER });
  const server = createHttpServer({
    settings,
    registry,
    engine,
    downloads,
    serverSettings,
    jit,
    logger: SILENT_LOGGER,
    profilesDir: paths.profiles,
    tuneRunsDir: paths.tuneRuns,
    tuneStepsFile: paths.tuneGrid,
    profileFingerprint: (entry) => currentFingerprint(entry, { nodeLlamaCpp: "test" }),
    ...(benchmarkDir ? { benchmarkDir } : {}),
    ...(benchmarks ? { benchmarks } : {}),
    ...(tunes ? { tunes } : {}),
    ...(reloadLease ? { reloadLease } : {}),
  });

  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;

  t.after(async () => {
    jit.dispose();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    // Windows can report ENOTEMPTY while a child server still holds a handle;
    // Node retries that class, so the cleanup does not flake under load.
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  return {
    home,
    paths,
    settings,
    serverSettings,
    registry,
    downloads,
    engine,
    jit,
    modelId,
    port,
    // hygiene: allow local test harness base URL, not a third-party fetch
    base: `http://${baseHost}:${port}`,
  };
}
