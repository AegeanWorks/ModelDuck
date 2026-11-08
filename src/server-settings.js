import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { readJsonWithQuarantine, writeJsonAtomic } from "./fs-atomic.js";
import { AppError } from "./errors.js";

export const DEFAULT_SERVER_SETTINGS = Object.freeze({
  port: 4141,
  requireAuth: false,
  serveOnLocalNetwork: false,
  allowPerRequestMcps: false,
  allowCallingServersFromMcpJson: false,
  enableCors: false,
  justInTimeModelLoading: false,
  autoUnloadUnusedJit: true,
  maxIdleTtlMinutes: 60,
  onlyKeepLastJitLoadedModel: true,
});

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeServerSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    port: clampInteger(source.port, 1, 65535, DEFAULT_SERVER_SETTINGS.port),
    requireAuth: Boolean(source.requireAuth), // aikit:allow-secret auth flag, not a credential
    serveOnLocalNetwork: Boolean(source.serveOnLocalNetwork),
    allowPerRequestMcps: Boolean(source.allowPerRequestMcps),
    allowCallingServersFromMcpJson: Boolean(source.allowCallingServersFromMcpJson),
    enableCors: Boolean(source.enableCors),
    justInTimeModelLoading: Boolean(source.justInTimeModelLoading),
    autoUnloadUnusedJit: source.autoUnloadUnusedJit === undefined
      ? DEFAULT_SERVER_SETTINGS.autoUnloadUnusedJit
      : Boolean(source.autoUnloadUnusedJit),
    maxIdleTtlMinutes: clampInteger(
      source.maxIdleTtlMinutes,
      1,
      1440,
      DEFAULT_SERVER_SETTINGS.maxIdleTtlMinutes,
    ),
    onlyKeepLastJitLoadedModel: source.onlyKeepLastJitLoadedModel === undefined
      ? DEFAULT_SERVER_SETTINGS.onlyKeepLastJitLoadedModel
      : Boolean(source.onlyKeepLastJitLoadedModel),
  };
}

/**
 * True when the saved listener differs from the one this process is running.
 * Auth, CORS and JIT switches apply on the next request; only the port and the
 * LAN binding need a restart. Without running-info the safe answer is "yes".
 */
export function restartRequiredFor(running, next = {}) {
  if (!running || running.port == null || running.host == null) return true;
  const runningLan = String(running.host) === "0.0.0.0";
  return Number(next.port) !== Number(running.port) || Boolean(next.serveOnLocalNetwork) !== runningLan;
}

/** LAN serving and CORS expose the API beyond this computer's own UI. */
export function exposedWithoutAuth(settings) {
  return Boolean((settings.serveOnLocalNetwork || settings.enableCors) && !settings.requireAuth);
}

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

export class ServerSettingsStore {
  #file;
  #logger;
  #value;
  #keys = [];
  #saveTimer = null;

  constructor({ file, logger = console }) {
    this.#file = file;
    this.#logger = logger;
    this.#value = { ...DEFAULT_SERVER_SETTINGS };
  }

  get value() {
    return { ...this.#value };
  }

  get activeKeys() {
    return this.#keys.length;
  }

  async load() {
    const data = await readJsonWithQuarantine(this.#file, null, { logger: this.#logger });
    const raw = data && typeof data === "object" ? data : {};
    this.#value = normalizeServerSettings(raw.settings ?? raw);
    const unsafe = exposedWithoutAuth(this.#value);
    if (unsafe) {
      this.#value = { ...this.#value, serveOnLocalNetwork: false, enableCors: false };
      this.#logger.warn?.(
        "[modelduck] Serve on Local Network and CORS were on without Require Authentication; "
          + "both are now off. Turn on Require Authentication, then enable them again in Server settings.",
      );
    }
    this.#keys = Array.isArray(raw.apiKeys)
      ? raw.apiKeys
          .filter((key) => key && typeof key.id === "string" && typeof key.hash === "string")
          .map((key) => ({
            id: key.id,
            label: typeof key.label === "string" ? key.label : "API key",
            prefix: typeof key.prefix === "string" ? key.prefix : "mdk_",
            hash: key.hash,
            createdAt: key.createdAt || new Date().toISOString(),
            lastUsedAt: key.lastUsedAt || null,
          }))
      : [];
    if (unsafe) await this.save();
    return this.value;
  }

  async save() {
    await writeJsonAtomic(this.#file, {
      version: 1,
      settings: this.#value,
      apiKeys: this.#keys,
    });
  }

  async update(patch) {
    const next = normalizeServerSettings({ ...this.#value, ...(patch ?? {}) });
    if (exposedWithoutAuth(next)) {
      throw new AppError("Turn on Require Authentication first", {
        code: "auth_required_for_exposure",
        status: 400,
        why: "Serve on Local Network and Enable CORS let other devices or web pages reach ModelDuck, so they need an API key.",
        fix: "Turn on Require Authentication and create an API key, or leave Local Network and CORS off.",
      });
    }
    this.#value = next;
    await this.save();
    return this.value;
  }

  listKeys() {
    return this.#keys.map((key) => ({
      id: key.id,
      label: key.label,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
    }));
  }

  async createKey(label = "API key") {
    const raw = `mdk_${randomBytes(24).toString("base64url")}`;
    const record = {
      id: randomUUID(),
      label: String(label || "API key").slice(0, 60),
      prefix: raw.slice(0, 10),
      hash: hashKey(raw),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.#keys.push(record);
    await this.save();
    return { key: raw, record: { ...record, hash: undefined } };
  }

  async revokeKey(id) {
    const before = this.#keys.length;
    this.#keys = this.#keys.filter((key) => key.id !== id);
    if (this.#keys.length === before) return false;
    await this.save();
    return true;
  }

  verifyKey(raw) {
    if (typeof raw !== "string" || !raw) return false;
    const digest = Buffer.from(hashKey(raw), "hex");
    for (const key of this.#keys) {
      const expected = Buffer.from(key.hash, "hex");
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) {
        key.lastUsedAt = new Date().toISOString();
        this.#scheduleKeySave();
        return true;
      }
    }
    return false;
  }

  #scheduleKeySave() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.save().catch((error) => this.#logger.warn?.(`[modelduck] Could not save API key usage: ${error.message}`));
    }, 1000);
    this.#saveTimer.unref?.();
  }
}
