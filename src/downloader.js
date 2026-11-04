import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AppError } from "./errors.js";
import { assertDiskSpace, ensureDirectory, formatBytes } from "./fs-atomic.js";
import { downloadUrl, getCatalogModel } from "./model-catalog.js";

const MAX_ACTIVE = 2;
const IDLE_TIMEOUT_MS = 60_000;

function receiptPath(modelsDir, fileName) {
  return path.join(modelsDir, `${fileName}.receipt.json`);
}

function resumeIdentityPath(modelsDir, fileName) {
  return path.join(modelsDir, `${fileName}.part.resume.json`);
}

/** IDEA-1073: the token broker. A PAT comes only from HF_TOKEN (or an explicit
 * argument) and is never logged, stored, or written to a receipt; it only
 * rides the outgoing request headers. */
export function gatedDownloadHeaders({ token } = {}) {
  const pat = typeof token === "string" && token ? token : process.env.HF_TOKEN;
  if (typeof pat === "string" && pat) return { Authorization: `Bearer ${pat}` };
  return {};
}

/** IDEA-1067/1194: measured install receipt; null when no receipt was written. */
export async function readInstallReceipt(modelsDir, fileName) {
  try {
    return JSON.parse(await fs.promises.readFile(receiptPath(modelsDir, fileName), "utf8"));
  } catch {
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

    const active = [...this.#jobs.values()].filter(
      (job) => job.status === "queued" || job.status === "downloading",
    );
    // Two jobs for one model would append to the same .part file and promote a corrupt model.
    const running = active.find((job) => job.catalogId === model.id);
    if (running) return this.#publicJob(running);
    if (active.length >= MAX_ACTIVE) {
      throw new AppError("Two downloads are already running", {
        code: "download_limit",
        status: 429,
        why: "ModelDuck downloads at most two models at a time to keep the app responsive.",
        fix: "Wait for one download to finish, or cancel it.",
      });
    }

    const finalPath = path.join(this.#modelsDir, model.file);
    let stats = null;
    try {
      stats = await fs.promises.stat(finalPath);
    } catch {
      // Not downloaded yet.
    }
    if (stats?.isFile() && stats.size === model.size) {
      const job = this.#newJob(model);
      job.status = "complete";
      job.received = model.size;
      job.total = model.size;
      job.finishedAt = new Date().toISOString();
      this.#jobs.set(job.id, job);
      return this.#publicJob(job);
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
    if (job.status === "complete") return this.#publicJob(job);
    job.status = "canceled";
    job.finishedAt = new Date().toISOString();
    job.controller?.abort();
    return this.#publicJob(job);
  }

  #newJob(model) {
    const startedAt = new Date().toISOString();
    return {
      id: randomUUID(),
      catalogId: model.id,
      modelId: model.id,
      name: model.name,
      fileName: model.file,
      size: model.size,
      sha256: model.sha256 ?? null,
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
    const model = this.#getModel(job.catalogId);
    const identity = { catalogId: job.catalogId, file: job.fileName, size: job.size, sha256: job.sha256 ?? null };
    if (partSize > 0) {
      try {
        const prior = JSON.parse(await fs.promises.readFile(resumePath, "utf8"));
        if (prior?.catalogId !== identity.catalogId || prior?.size !== identity.size || (prior?.sha256 ?? null) !== identity.sha256) {
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
    job.status = "downloading";
    job.received = partSize;
    job.controller = new AbortController();
    // Record whose bytes the .part file holds before any byte is appended.
    await fs.promises.writeFile(resumePath, JSON.stringify({ ...identity, url: downloadUrl(model), startedAt: new Date().toISOString() })).catch(() => {});
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

      let response = await this.#fetch(downloadUrl(this.#getModel(job.catalogId)), {
        headers,
        signal: job.controller.signal,
        redirect: "follow",
      });

      if (response.status === 416 && partSize > 0) {
        await fs.promises.truncate(partPath, 0).catch(() => {});
        partSize = 0;
        job.received = 0;
        response = await this.#fetch(downloadUrl(this.#getModel(job.catalogId)), {
          headers: { "User-Agent": "ModelDuck/0.1 (+local)", ...gatedDownloadHeaders() },
          signal: job.controller.signal,
          redirect: "follow",
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

      await fs.promises.rename(partPath, finalPath);
      await fs.promises.rm(resumePath, { force: true }).catch(() => {});
      // IDEA-1067/1194: measured artifact receipt binds digest, quant and source.
      const catalogEntry = this.#getModel(job.catalogId);
      await fs.promises.writeFile(
        receiptPath(this.#modelsDir, job.fileName),
        JSON.stringify({
          catalogId: job.catalogId,
          file: job.fileName,
          size: job.size,
          sha256: job.sha256 ?? null,
          digest,
          quant: catalogEntry?.quant ?? null,
          url: catalogEntry ? downloadUrl(catalogEntry) : null,
          downloadedAt: new Date().toISOString(),
        }),
      ).catch(() => {});
      job.status = "complete";
      job.finishedAt = new Date().toISOString();
      job.received = job.size;
      job.total = job.size;
    } catch (error) {
      if (job.stalled && job.status !== "canceled") {
        job.status = "error";
        job.finishedAt = new Date().toISOString();
        job.error = {
          message: "The download stalled",
          why: `No data arrived for ${Math.round(this.#idleTimeoutMs / 1000)} seconds from Hugging Face for ${job.name}.`,
          fix: "Check your internet connection, then click Download again to resume where it stopped.",
        };
        this.#logger.warn?.(`[modelduck] ${job.error.message}: ${job.name}`);
      } else if (error?.name === "AbortError" || job.status === "canceled") {
        job.status = "canceled";
        job.finishedAt = new Date().toISOString();
      } else {
        job.status = "error";
        job.finishedAt = new Date().toISOString();
        job.error = {
          message: error?.message || "Download failed",
          why: error?.why || "The file could not be downloaded.",
          fix: error?.fix || "Check your internet connection, then retry the download.",
        };
        this.#logger.warn?.(`[modelduck] ${job.error.message}`);
      }
    } finally {
      clearTimeout(idleTimer);
      job.stalled = false;
      job.controller = null;
    }
  }
}
