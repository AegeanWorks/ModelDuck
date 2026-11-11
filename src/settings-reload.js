/**
 * IDEA-1098: the release-barriered engine rebuild lease.
 *
 * Changing a server setting that shapes the load (context, threads, KV
 * cache...) only describes the ask; the loaded context still has the old
 * values. This module closes that contract without ever aborting work:
 *
 * - `reloadFingerprint(value)` digests the reload-affecting settings, so the
 *   settings API can answer "does the live engine differ from the ask?".
 * - `EngineRebuildLease` optionally rebuilds the loaded model on a debounce
 *   when `autoReloadOnSettingsChange` is on. A busy engine defers the
 *   rebuild (reschedules) instead of aborting the generation; only the
 *   newest fingerprint's load becomes visible; teardown is bounded by a
 *   timeout and a failed dispose surfaces as a MODEL_DISPOSE_FAILED-style
 *   error on the lease instead of silently straddling two contexts.
 */

import { createHash } from "node:crypto";

export const RELOAD_SETTING_KEYS = [
  "contextSize",
  "threads",
  "batchSize",
  "kvCache",
  "flashAttention",
  "useMmap",
  "checkpoints",
  "checkpointInterval",
  "checkpointMax",
  "checkpointMemoryMb",
  "gpuLayers",
  "gpuBackend",
];

export function reloadFingerprint(settings) {
  const identity = {};
  for (const key of RELOAD_SETTING_KEYS) {
    identity[key] = settings?.[key] ?? null;
  }
  return createHash("sha256")
    .update(JSON.stringify(identity).normalize("NFC"))
    .digest("hex")
    .slice(0, 16);
}

function loadArguments(modelId, settings) {
  return {
    modelId,
    contextSize: settings.contextSize,
    threads: settings.threads,
    maxThreads: settings.maxThreads,
    batchSize: settings.batchSize,
    sequences: settings.sequences,
    flashAttention: settings.flashAttention,
    useMmap: settings.useMmap,
    gpuLayers: settings.gpuLayers,
    gpuBackend: settings.gpuBackend,
    checkpoints: settings.checkpoints,
    checkpointInterval: settings.checkpointInterval,
    checkpointMax: settings.checkpointMax,
    checkpointMemoryMb: settings.checkpointMemoryMb,
    kvCache: settings.kvCache,
  };
}

export class EngineRebuildLease {
  #engine;
  #logger;
  #delayMs;
  #disposeTimeoutMs;
  #pendingFingerprint = null;
  #pendingSettings = null;
  #timer = null;
  #running = false;
  #phase = "load";
  lastError = null;

  constructor({ engine, logger = null, delayMs = 1500, disposeTimeoutMs = 20000 }) {
    this.#engine = engine;
    this.#logger = logger;
    this.#delayMs = Math.max(1, Number(delayMs) || 1500);
    this.#disposeTimeoutMs = Math.max(1, Number(disposeTimeoutMs) || 20000);
  }

  get pending() {
    return this.#pendingFingerprint !== null;
  }

  /**
   * IDEA-1098: a synchronous, read-only snapshot of the rebuild state. The
   * server reports it so a client can observe a deferred rebuild and the
   * last failure (e.g. MODEL_DISPOSE_FAILED) that never reached a PUT reply.
   */
  status() {
    return {
      pending: this.pending,
      pendingFingerprint: this.#pendingFingerprint,
      phase: this.#phase,
      running: this.#running,
      lastError: this.lastError,
    };
  }

  /**
   * File the newest settings and answer whether the live engine needs a
   * reload. Scheduling happens only with autoReloadOnSettingsChange: the
   * default stays off, so a settings change never reloads on its own.
   */
  update(nextSettings) {
    const fingerprint = reloadFingerprint(nextSettings);
    const current = this.#engineFingerprint();
    if (current === null || fingerprint === current) {
      return { required: false, fingerprint, scheduled: this.pending && this.#pendingFingerprint === fingerprint };
    }
    if (nextSettings?.autoReloadOnSettingsChange !== true) {
      return { required: true, fingerprint, scheduled: false };
    }
    if (this.#pendingFingerprint !== fingerprint) {
      this.#pendingFingerprint = fingerprint;
      this.#pendingSettings = { ...nextSettings };
      this.#schedule();
    }
    return { required: true, fingerprint, scheduled: true };
  }

  dispose() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pendingFingerprint = null;
    this.#pendingSettings = null;
  }

  #engineFingerprint() {
    try {
      const value = this.#engine?.reloadFingerprint;
      return typeof value === "function" || value instanceof Object
        ? this.#engine.reloadFingerprint()
        : (value ?? null);
    } catch {
      return null;
    }
  }

  #schedule() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#rebuild();
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  async #rebuild() {
    if (this.#running) {
      this.#schedule();
      return;
    }
    const fingerprint = this.#pendingFingerprint;
    if (!fingerprint) return;
    this.#running = true;
    let deferred = false;
    try {
      const modelId = this.#engine.loadedId;
      if (!modelId || this.#engine.busy) {
        // Release barrier: defer, never abort a running generation.
        deferred = true;
        return;
      }
      if (fingerprint !== this.#pendingFingerprint) {
        // A newer ask arrived: only the newest fingerprint may become visible.
        deferred = true;
        return;
      }
      this.#phase = "unload";
      await this.#bounded(() => this.#engine.unload());
      if (fingerprint !== this.#pendingFingerprint) {
        deferred = true;
        return;
      }
      this.#phase = "load";
      await this.#engine.load(loadArguments(modelId, this.#pendingSettings));
      this.lastError = null;
    } catch (error) {
      if (error?.code === "generation_in_progress" || this.#engine.busy) {
        deferred = true;
      } else {
        const code = this.#phase === "unload" ? "MODEL_DISPOSE_FAILED" : String(error?.code ?? "engine_reload_failed");
        this.lastError = { code, message: String(error?.message ?? error) };
        this.#logger?.warn?.(`[modelduck] schedule settings reload failed (${code}): ${this.lastError.message}`);
      }
    } finally {
      this.#running = false;
      if (deferred) {
        this.#schedule();
      } else if (this.#pendingFingerprint === fingerprint) {
        this.#pendingFingerprint = null;
        this.#pendingSettings = null;
      }
    }
  }

  /** Bounded teardown: a hung dispose cannot block the lease forever. */
  async #bounded(work) {
    let timer = null;
    try {
      await Promise.race([
        work(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`engine teardown timed out after ${this.#disposeTimeoutMs} ms`);
            error.code = "MODEL_DISPOSE_FAILED";
            reject(error);
          }, this.#disposeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
