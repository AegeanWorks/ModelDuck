import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppError } from "./errors.js";
import { assertDiskSpace, ensureDirectory, formatBytes, promoteFileAtomic, withoutBom } from "./fs-atomic.js";
import { checkDownloadFit, inspectGgufHeader } from "./gguf-guard.js";
import { assertHuggingFaceFileUrl } from "./hf-reference.js";
import { downloadUrl, getCatalogModel } from "./model-catalog.js";
import { DOWNLOAD_MACHINE, moveTo } from "./state-machine.js";

const MAX_ACTIVE = 2;
const IDLE_TIMEOUT_MS = 60_000;
// IDEA-0995: a user-chosen file is capped so a bad link cannot fill the disk.
const MAX_SOURCE_BYTES = 32 * 1024 ** 3;
// Hugging Face resolve URLs redirect to its own CDN hosts; the token stays
// only on Hugging Face infrastructure, never on a third-party host.
const MAX_REDIRECT_HOPS = 5;

function receiptPath(modelsDir, fileName) {
  return path.join(modelsDir, `${path.basename(String(fileName ?? ""))}.receipt.json`);
}

function resumeIdentityPath(modelsDir, fileName) {
  return path.join(modelsDir, `${path.basename(String(fileName ?? ""))}.part.resume.json`);
}

/** IDEA-1073: the token broker. A PAT comes only from HF_TOKEN (or an explicit
 * argument) and is never logged, stored, or written to a receipt; it only
 * rides the outgoing request headers. */
export function gatedDownloadHeaders({ token } = {}) {
  const pat = typeof token === "string" && token ? token : process.env.HF_TOKEN;
  if (typeof pat === "string" && pat) return { Authorization: `Bearer ${pat}` };
  return {};
}

let missingReceiptSkips = 0;
// A failed readFile costs ~1.7 ms each on this host, while a model with a real
// receipt only pays one successful read. Remember only the negative result, so
// the common present-receipt path stays unchanged; the writer clears the mark.
const MISSING_RECEIPTS = new Map();
const MISSING_RECEIPT_TTL_MS = 500;

export function receiptMissingSkips() {
  return missingReceiptSkips;
}
export function invalidateReceiptCache(modelsDir, fileName) {
  MISSING_RECEIPTS.delete(receiptPath(modelsDir, fileName));
}
export function resetReceiptCounters() {
  missingReceiptSkips = 0;
  MISSING_RECEIPTS.clear();
}

/** IDEA-1067/1194: measured install receipt; null when no receipt was written. */
export async function readInstallReceipt(modelsDir, fileName, { clock = Date.now, ttlMs = MISSING_RECEIPT_TTL_MS } = {}) {
  const file = receiptPath(modelsDir, fileName);
  const now = clock();
  const missedAt = MISSING_RECEIPTS.get(file);
  if (missedAt !== undefined && now - missedAt < ttlMs) {
    missingReceiptSkips += 1;
    return null;
  }
  try {
    // A BOM written by a Windows editor must not hide the receipt, the same
    // tolerance the settings reader gives its files (ADR-114).
    const text = await fs.promises.readFile(file, "utf8");
    return JSON.parse(withoutBom(text));
  } catch {
    MISSING_RECEIPTS.set(file, now);
    return null;
  }
}

export class DownloadManager {
  #modelsDir;
  #logger;
  #fetch;
  #idleTimeoutMs;
  #getModel;
  #jobs = new Map();
  // Catalog ids whose start() is past its active check but has not created a
  // job yet. Without it, two concurrent requests both pass the check during
  // the awaited stat and append to one .part file.
  #starting = new Set();

  constructor({
    modelsDir,
    logger = console,
    fetchImpl = globalThis.fetch,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    getModel = getCatalogModel,
  }) {
    this.#modelsDir = modelsDir;
    this.#logger = logger;
    this.#fetch = fetchImpl;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#getModel = getModel;
  }

  list() {
    return [...this.#jobs.values()]
      .map((job) => this.#publicJob(job))
      .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  }

  get(id) {
    const job = this.#jobs.get(id);
    return job ? this.#publicJob(job) : null;
  }

  async start(catalogId) {
    const model = this.#getModel(catalogId);
    if (!model) {
      throw new AppError("Unknown model", {
        code: "catalog_model_not_found",
        status: 404,
        why: "That model is not in ModelDuck's curated catalog.",
        fix: "Refresh the model list and choose one of the listed downloads.",
      });
    }
    return this.#startModel(model);
  }

  /**
   * IDEA-0995: download one file the user named on Hugging Face. The source is
   * already resolved and inspected by the caller, so no catalog entry exists;
   * the job carries its own URL and the receipt records it.
   */
  async startSource({ url, file, name, size, sha256 = null, quant = null }) {
    const fileName = String(file ?? "");
    if (path.basename(fileName) !== fileName || !/\.gguf$/i.test(fileName)) {
      throw new AppError("The file name is not valid", {
        code: "invalid_source_file",
        status: 400,
        why: `"${fileName}" is not a plain .gguf file name.`,
        fix: "Paste the Hugging Face file link again.",
      });
    }
    if (!Number.isFinite(size) || size <= 0) {
      throw new AppError("The source size is unknown", {
        code: "invalid_source_size",
        status: 400,
        why: "The download cannot start without the file's exact size.",
        fix: "Use the file's resolve link on Hugging Face, which reports its size.",
      });
    }
    // The host rule lives in one module (ADR-144): a direct caller can never
    // send the gated token to another first hop or download another host.
    assertHuggingFaceFileUrl(url);
    if (sha256 !== undefined && sha256 !== null && typeof sha256 !== "string") {
      throw new AppError("The SHA-256 is not valid", {
        code: "invalid_source_sha256",
        status: 400,
        why: "The pin must be 64 hex characters of text.",
        fix: "Send the SHA-256 as text, or leave it out.",
      });
    }
    const expected = typeof sha256 === "string" && sha256.trim() ? sha256.trim().toLowerCase() : null;
    if (expected && !/^[0-9a-f]{64}$/.test(expected)) {
      throw new AppError("The SHA-256 is not valid", {
        code: "invalid_source_sha256",
        status: 400,
        why: `"${sha256}" is not a 64-character hex digest.`,
        fix: "Paste the SHA-256 from the file page, or leave the fingerprint empty.",
      });
    }
    // IDEA-0995: a user-chosen file has no catalog identity, so its name is the
    // only local key. Never overwrite a file that this URL did not install, and
    // never report success for a file whose receipt names another source.
    const finalPath = path.join(this.#modelsDir, fileName);
    const existing = await fs.promises.stat(finalPath).catch(() => null);
    if (existing?.isFile()) {
      const receipt = await readInstallReceipt(this.#modelsDir, fileName);
      const sameSource = receipt?.url === url && Number(receipt?.size) === size && existing.size === size;
      if (!sameSource) {
        throw new AppError("A different file already uses this name", {
          code: "source_name_conflict",
          status: 409,
          why: `${fileName} is already in your library, and it did not come from ${url}.`,
          fix: "Rename the file on Hugging Face, or remove the existing file from your library first.",
        });
      }
      const job = this.#newJob({
        id: null,
        name: String(name ?? fileName.replace(/\.gguf$/i, "")),
        file: fileName,
        size,
        sha256: expected,
        url,
        quant: quant ?? null,
      });
      moveTo(job, DOWNLOAD_MACHINE, "complete");
      job.received = size;
      job.total = size;
      job.finishedAt = new Date().toISOString();
      this.#jobs.set(job.id, job);
      return this.#publicJob(job);
    }
    return this.#startModel({
      id: null,
      name: String(name ?? fileName.replace(/\.gguf$/i, "")),
      file: fileName,
      size,
      sha256: expected,
      url,
      quant: quant ?? null,
    });
  }

  /**
   * IDEA-0995: ask Hugging Face how large a resolved file is before a job is
   * created, so the disk and fit checks run on a real number. The token rides
   * only through the same redirect gate the download uses.
   */
  async inspectSource({ url, sha256 = null }) {
    assertHuggingFaceFileUrl(url);
    if (sha256 !== undefined && sha256 !== null && typeof sha256 !== "string") {
      throw new AppError("The SHA-256 is not valid", {
        code: "invalid_source_sha256",
        status: 400,
        why: "The pin must be 64 hex characters of text.",
        fix: "Send the SHA-256 as text, or leave it out.",
      });
    }
    const headers = { "User-Agent": "ModelDuck/0.1 (+local)", ...gatedDownloadHeaders() };
    let response;
    try {
      response = await this.#fetchFollowingRedirects(url, {
        headers,
        method: "HEAD",
        signal: AbortSignal.timeout(this.#idleTimeoutMs),
      });
    } catch (error) {
      throw new AppError("Hugging Face did not answer", {
        code: "source_unreachable",
        status: 502,
        why: error?.message || "The size check could not reach Hugging Face.",
        fix: "Check your internet connection, then try again.",
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError("Hugging Face refused the file", {
        code: "download_unauthorized",
        status: 502,
        why: `Hugging Face answered HTTP ${response.status}; the model needs access approval.`,
        fix: "Approve the model on Hugging Face, set HF_TOKEN, then retry. The token is never stored.",
      });
    }
    if (response.status === 404) {
      throw new AppError("The file was not found", {
        code: "source_not_found",
        status: 404,
        why: "Hugging Face has no file at that address.",
        fix: "Open the repository's Files tab and copy the .gguf link again.",
      });
    }
    if (!response.ok) {
      throw new AppError(`The size check failed with HTTP ${response.status}`, {
        code: "source_check_failed",
        status: 502,
        why: `Hugging Face answered HTTP ${response.status} to the size check.`,
        fix: "Check your internet connection, then try again.",
      });
    }
    const advertised = Number(response.headers?.get?.("content-length"));
    if (!Number.isFinite(advertised) || advertised <= 0) {
      throw new AppError("The file size is unknown", {
        code: "source_size_unknown",
        status: 502,
        why: "Hugging Face did not report how large the file is, so it cannot be downloaded safely.",
        fix: "Use the file's resolve link, or pick a model from ModelDuck's catalog.",
      });
    }
    if (advertised > MAX_SOURCE_BYTES) {
      throw new AppError("The file is too large", {
        code: "source_too_large",
        status: 413,
        why: `${formatBytes(advertised)} is larger than the ${formatBytes(MAX_SOURCE_BYTES)} limit for a user-chosen file.`,
        fix: "Choose a smaller quantization, or pick a model from ModelDuck's catalog.",
      });
    }
    return { url, size: advertised, sha256: typeof sha256 === "string" && sha256.trim() ? sha256.trim().toLowerCase() : null };
  }

  async #startModel(model) {
    const active = [...this.#jobs.values()].filter(
      (job) => job.status === "queued" || job.status === "downloading",
    );
    // Two jobs for one model would append to the same .part file and promote a corrupt model.
    const running = active.find((job) => (model.id ? job.catalogId === model.id : job.fileName === model.file));
    if (running) return this.#publicJob(running);
    const key = model.id ?? `file:${model.file}`;
    if (this.#starting.has(key)) {
      throw new AppError("This download is already starting", {
        code: "download_starting",
        status: 409,
        why: `${model.name} was requested twice before its job appeared.`,
        fix: "Wait a moment; the running request continues.",
      });
    }
    if (active.length + this.#starting.size >= MAX_ACTIVE) {
      throw new AppError("Two downloads are already running", {
        code: "download_limit",
        status: 429,
        why: "ModelDuck downloads at most two models at a time to keep the app responsive.",
        fix: "Wait for one download to finish, or cancel it.",
      });
    }
    this.#starting.add(key);
    try {
      return await this.#beginStart(model);
    } finally {
      this.#starting.delete(key);
    }
  }

  async #beginStart(model) {
    const finalPath = path.join(this.#modelsDir, model.file);
    let stats = null;
    try {
      stats = await fs.promises.stat(finalPath);
    } catch {
      // Not downloaded yet.
    }
    if (stats?.isFile() && stats.size === model.size) {
      const job = this.#newJob(model);
      moveTo(job, DOWNLOAD_MACHINE, "complete");
      job.received = model.size;
      job.total = model.size;
      job.finishedAt = new Date().toISOString();
      this.#jobs.set(job.id, job);
      return this.#publicJob(job);
    }

    // IDEA-1637: refuse a doomed download early. Weights + reserve alone can
    // already exceed free RAM; the header walk runs later in preflightGgufFile.
    // Best-effort: an unreadable memory figure never blocks a download.
    try {
      const free = typeof os.freemem === "function" ? os.freemem() : null;
      if (Number.isFinite(free) && free > 0) {
        checkDownloadFit({ modelBytes: model.size, contextSize: 2048, kvCache: "f16", availableBytes: free });
      }
    } catch (error) {
      if (error?.code === "download_would_not_fit") throw error;
    }

    const job = this.#newJob(model);
    this.#jobs.set(job.id, job);
    void this.#run(job).catch((error) => {
      this.#logger.error?.(`[modelduck] Download failed: ${error.message}`);
    });
    return this.#publicJob(job);
  }

  async cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) {
      throw new AppError("Download not found", {
        code: "download_not_found",
        status: 404,
        why: "That download is no longer tracked.",
        fix: "Refresh the model list.",
      });
    }
    // A terminal job keeps its outcome; canceling a finished download is a no-op.
    if (DOWNLOAD_MACHINE.terminal.includes(job.status)) return this.#publicJob(job);
    moveTo(job, DOWNLOAD_MACHINE, "canceled");
    job.finishedAt = new Date().toISOString();
    job.controller?.abort();
    return this.#publicJob(job);
  }

  #newJob(model) {
    const startedAt = new Date().toISOString();
    return {
      id: randomUUID(),
      catalogId: model.id ?? null,
      modelId: model.id ?? null,
      name: model.name,
      fileName: model.file,
      size: model.size,
      sha256: model.sha256 ?? null,
      // IDEA-0995: a user-chosen file has no catalog entry; its own source URL
      // and quantization travel with the job and into the receipt.
      url: model.url ?? null,
      quant: model.quant ?? null,
      model,
      received: 0,
      total: model.size,
      status: "queued",
      startedAt,
      finishedAt: null,
      error: null,
      controller: null,
    };
  }

  #publicJob(job) {
    return {
      id: job.id,
      catalogId: job.catalogId,
      modelId: job.modelId,
      name: job.name,
      fileName: job.fileName,
      size: job.size,
      received: job.received,
      total: job.total,
      percent: job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    };
  }

  async receiptFor(fileName) {
    return readInstallReceipt(this.#modelsDir, fileName);
  }

  /**
   * IDEA-1073: follow redirects without leaking the token. The Authorization
   * header rides only to Hugging Face hosts (the resolve host and its own
   * *.huggingface.co CDN); any other redirect target — or an https-to-http
   * downgrade — drops it before the request is sent.
   */
  async #fetchFollowingRedirects(url, { headers = {}, signal, method = "GET" } = {}) {
    const originHost = new URL(url).hostname.toLowerCase();
    let current = url;
    let outgoing = { ...headers };
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const response = await this.#fetch(current, { headers: outgoing, signal, method, redirect: "manual" });
      const location = response.headers?.get?.("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      const next = new URL(location, current);
      const nextHost = next.hostname.toLowerCase();
      const staysOnHuggingFace = nextHost === originHost || nextHost.endsWith(".huggingface.co");
      const downgraded = new URL(current).protocol === "https:" && next.protocol !== "https:";
      if (staysOnHuggingFace && !downgraded) {
        outgoing = { ...outgoing };
      } else {
        const { Authorization: _dropped, authorization: _droppedLower, ...rest } = outgoing;
        outgoing = rest;
      }
      current = next.toString();
    }
    throw new AppError("Too many redirects", {
      code: "download_redirect_loop",
      status: 502,
      why: `Hugging Face redirected ${url} more than ${MAX_REDIRECT_HOPS} times.`,
      fix: "Check your internet connection, then try the download again.",
    });
  }

  async #run(job) {
    if (job.status === "canceled") return;
    await ensureDirectory(this.#modelsDir);
    const finalPath = path.join(this.#modelsDir, job.fileName);
    const partPath = `${finalPath}.part`;
    const resumePath = resumeIdentityPath(this.#modelsDir, job.fileName);
    let partSize = 0;
    try {
      partSize = (await fs.promises.stat(partPath)).size;
    } catch {
      partSize = 0;
    }

    // IDEA-1195: when an identity receipt exists it must name this exact
    // catalog entry; another model's bytes are never appended. Parts written
    // before receipts existed have no receipt and resume once (the end-to-end
    // SHA-256 still guards them); the receipt written below covers next time.
    const model = job.model ?? this.#getModel(job.catalogId);
    const sourceUrl = job.url ?? (() => { try { return downloadUrl(model); } catch { return null; } })();
    const identity = { catalogId: job.catalogId, file: job.fileName, size: job.size, sha256: job.sha256 ?? null };
    if (partSize > 0) {
      try {
        const prior = JSON.parse(await fs.promises.readFile(resumePath, "utf8"));
        if (prior?.catalogId !== identity.catalogId || prior?.size !== identity.size || (prior?.sha256 ?? null) !== identity.sha256 || (sourceUrl && prior?.url && prior.url !== sourceUrl)) {
          await fs.promises.truncate(partPath, 0).catch(() => {});
          partSize = 0;
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          await fs.promises.truncate(partPath, 0).catch(() => {});
          partSize = 0;
        }
      }
    }
    await fs.promises.rm(resumePath, { force: true }).catch(() => {});

    if (job.status === "canceled") return;
    await assertDiskSpace(this.#modelsDir, Math.max(0, job.size - partSize));
    if (job.status === "canceled") return;
    moveTo(job, DOWNLOAD_MACHINE, "downloading");
    job.received = partSize;
    job.controller = new AbortController();
    // Record whose bytes the .part file holds before any byte is appended.
    await fs.promises.writeFile(resumePath, JSON.stringify({ ...identity, url: sourceUrl, startedAt: new Date().toISOString() })).catch(() => {});
    // A connection that stops sending data would otherwise stay "downloading" forever
    // and hold one of the two download slots; the .part file is kept for resume.
    let idleTimer = null;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        job.stalled = true;
        job.controller?.abort();
      }, this.#idleTimeoutMs);
    };
    touch();

    try {
      // IDEA-1073: gated downloads authenticate; the token never lands in a log.
      const auth = gatedDownloadHeaders();
      const headers = { "User-Agent": "ModelDuck/0.1 (+local)", ...auth };
      if (partSize > 0) headers.Range = `bytes=${partSize}-`;

      let response = await this.#fetchFollowingRedirects(sourceUrl, {
        headers,
        signal: job.controller.signal,
      });

      if (response.status === 416 && partSize > 0) {
        await fs.promises.truncate(partPath, 0).catch(() => {});
        partSize = 0;
        job.received = 0;
        response = await this.#fetchFollowingRedirects(sourceUrl, {
          headers: { "User-Agent": "ModelDuck/0.1 (+local)", ...gatedDownloadHeaders() },
          signal: job.controller.signal,
        });
      }

      if (!response.ok) {
        const gated = response.status === 401 || response.status === 403;
        throw new AppError(`Download failed with HTTP ${response.status}`, {
          code: gated ? "download_unauthorized" : "download_failed",
          status: 502,
          why: gated
            ? `Hugging Face refused ${job.name} (HTTP ${response.status}); the model needs access approval.`
            : `Hugging Face returned HTTP ${response.status} for ${job.name}.`,
          fix: gated
            ? "Approve the model on Hugging Face, set HF_TOKEN, then retry. The token is never stored."
            : "Check your internet connection, then try the download again.",
        });
      }

      if (partSize > 0 && response.status !== 206) {
        await fs.promises.truncate(partPath, 0).catch(() => {});
        partSize = 0;
        job.received = 0;
      } else {
        job.received = partSize;
      }
      // The SHA-256 covers the whole file, so a resumed download first hashes the bytes it already has.
      const hash = createHash("sha256");
      if (partSize > 0) {
        for await (const chunk of fs.createReadStream(partPath, { end: partSize - 1 })) hash.update(chunk);
      }

      const advertised = Number(response.headers.get("content-length"));
      if (Number.isFinite(advertised) && advertised > 0) {
        job.total = partSize + advertised;
      }

      const handle = await fs.promises.open(partPath, "a");
      try {
        if (!response.body) {
          throw new AppError("The download stream was empty", {
            code: "download_empty",
            status: 502,
            why: "Hugging Face sent no file data.",
            fix: "Try the download again in a moment.",
          });
        }
        for await (const chunk of response.body) {
          if (job.controller.signal.aborted) {
            const abort = new Error("Download canceled");
            abort.name = "AbortError";
            throw abort;
          }
          await handle.write(chunk);
          hash.update(chunk);
          job.received += chunk.length;
          touch();
        }
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }

      if (job.received !== job.size) {
        throw new AppError("The download is incomplete", {
          code: "download_incomplete",
          status: 502,
          why: `Received ${formatBytes(job.received)} of ${formatBytes(job.size)} for ${job.name}.`,
          fix: "Click Download again to resume where it stopped.",
        });
      }

      const digest = hash.digest("hex");
      if (job.sha256 && digest !== job.sha256) {
        await fs.promises.unlink(partPath).catch(() => {});
        await fs.promises.rm(resumePath, { force: true }).catch(() => {});
        throw new AppError("The downloaded file is corrupt", {
          code: "download_corrupt",
          status: 502,
          why: `${job.name} has the right size but its SHA-256 did not match the catalog (got ${digest.slice(0, 12)}…, expected ${job.sha256.slice(0, 12)}…).`,
          fix: "The partial file was removed. Click Download to fetch it again; if it repeats, check for a proxy or antivirus rewriting downloads.",
        });
      }

      // IDEA-1637: a corrupt header fails the download loudly instead of
      // promoting a file the library scan would only block later.
      try {
        await inspectGgufHeader(partPath);
      } catch (error) {
        await fs.promises.unlink(partPath).catch(() => {});
        await fs.promises.rm(resumePath, { force: true }).catch(() => {});
        throw new AppError("This GGUF file was blocked", {
          code: "gguf_header_rejected",
          status: 502,
          why: error?.why || error?.message || "The header could not be read.",
          fix: "Delete that file manually if it exists, then download the model again from a source you trust.",
        });
      }

      // A cancel that lands while the hash and header are verified must not
      // promote or mark complete: canceled is terminal.
      if (job.status === "canceled") return;
      // IDEA-1381: fsync the part file, atomically promote it, then fsync
      // the directory, so a crash cannot expose a half-promoted model file.
      await promoteFileAtomic(partPath, finalPath);
      await fs.promises.rm(resumePath, { force: true }).catch(() => {});
      // IDEA-1067/1194: measured artifact receipt binds digest, quant and source.
      const catalogEntry = job.model ? null : this.#getModel(job.catalogId);
      await fs.promises.writeFile(
        receiptPath(this.#modelsDir, job.fileName),
        JSON.stringify({
          catalogId: job.catalogId,
          file: job.fileName,
          size: job.size,
          sha256: job.sha256 ?? null,
          digest,
          quant: job.quant ?? catalogEntry?.quant ?? null,
          url: sourceUrl ?? (catalogEntry ? downloadUrl(catalogEntry) : null),
          downloadedAt: new Date().toISOString(),
        }),
      ).catch(() => {});
      invalidateReceiptCache(this.#modelsDir, job.fileName);
      moveTo(job, DOWNLOAD_MACHINE, "complete");
      job.finishedAt = new Date().toISOString();
      job.received = job.size;
      job.total = job.size;
    } catch (error) {
      // A terminal job keeps the outcome it reached first; a failure can never
      // overwrite a cancel, and a cancel can never overwrite a failure.
      if (DOWNLOAD_MACHINE.terminal.includes(job.status)) {
        job.finishedAt ??= new Date().toISOString();
      } else if (job.stalled) {
        if (moveTo(job, DOWNLOAD_MACHINE, "error")) {
          job.finishedAt = new Date().toISOString();
          job.error = {
            message: "The download stalled",
            why: `No data arrived for ${Math.round(this.#idleTimeoutMs / 1000)} seconds from Hugging Face for ${job.name}.`,
            fix: "Check your internet connection, then click Download again to resume where it stopped.",
          };
          this.#logger.warn?.(`[modelduck] ${job.error.message}: ${job.name}`);
        }
      } else if (error?.name === "AbortError") {
        if (moveTo(job, DOWNLOAD_MACHINE, "canceled")) job.finishedAt = new Date().toISOString();
      } else {
        if (moveTo(job, DOWNLOAD_MACHINE, "error")) {
          job.finishedAt = new Date().toISOString();
          job.error = {
            message: error?.message || "Download failed",
            why: error?.why || "The file could not be downloaded.",
            fix: error?.fix || "Check your internet connection, then retry the download.",
          };
          this.#logger.warn?.(`[modelduck] ${job.error.message}`);
        }
      }
    } finally {
      clearTimeout(idleTimer);
      job.stalled = false;
      job.controller = null;
    }
  }
}
