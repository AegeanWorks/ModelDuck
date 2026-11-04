import fs from "node:fs";
import path from "node:path";

import { AppError } from "./errors.js";

const MIN_FREE_BYTES = 10 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureDirectory(directory) {
  await fs.promises.mkdir(directory, { recursive: true });
}

/** Write text through a synced temporary file, then replace the destination. */
// Windows briefly locks a file that antivirus or another process is reading; renaming over it then fails.
const TRANSIENT_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Replace `to` with `from`, retrying transient lock errors up to five tries in all (PRINCIPLE-013). */
export async function replaceWithRetry(from, to, { tries = 5, delayMs = 50, renameImpl = fs.promises.rename } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME.has(error?.code) || attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * IDEA-1381: durable file fsync before promotion. Opens the file read-only
 * and flushes it, so the bytes are on stable storage before the directory
 * entry moves. Best-effort: a missing file or a platform that refuses the
 * sync still resolves, because the caller already synced its write handle.
 */
export async function fsyncFile(file) {
  let handle = null;
  try {
    handle = await fs.promises.open(file, "r");
    await handle.sync();
  } catch {
    // Best-effort: the writer already synced its own handle.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * IDEA-1381: durable directory fsync after promotion. Flushes the directory
 * entry so a power loss cannot lose the rename. Best-effort: Windows does
 * not allow opening a directory this way.
 */
export async function fsyncDirectory(directory) {
  let handle = null;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch {
    // Not supported on every platform.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * IDEA-1381: durable promotion for downloads. The part file is fsynced,
 * atomically renamed (with Windows lock retries), then the directory is
 * fsynced, so a crash cannot expose a half-promoted model file.
 */
export async function promoteFileAtomic(partPath, finalPath, { renameImpl = fs.promises.rename } = {}) {
  await fsyncFile(partPath);
  await replaceWithRetry(partPath, finalPath, { renameImpl });
  await fsyncDirectory(path.dirname(finalPath));
}

export async function writeFileAtomic(file, text, { mode = 0o600 } = {}) {
  const directory = path.dirname(file);
  await ensureDirectory(directory);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  let handle;
  try {
    await fs.promises.copyFile(file, `${file}.bak`).catch(() => {});
    handle = await fs.promises.open(temporary, "w", mode);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceWithRetry(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }

  // A directory fsync is best effort: Windows does not allow opening a
  // directory this way, and the file itself is already safely replaced.
  let directoryHandle = null;
  try {
    directoryHandle = await fs.promises.open(directory, "r");
    await directoryHandle.sync();
  } catch {
    // Not supported on every platform.
  } finally {
    await directoryHandle?.close().catch(() => {});
  }
}

export async function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFileAtomic(file, text);
  } catch (error) {
    if (error?.code === "ENOSPC") {
      throw new AppError("The disk is full", {
        code: "disk_full",
        status: 507,
        why: "ModelDuck could not save its state because the disk has no free space.",
        fix: "Free some disk space, then try again.",
      });
    }
    throw error;
  }
}

/**
 * Read JSON without letting a damaged file stop the app. A broken file is
 * moved aside so it can be inspected, never silently overwritten in place.
 */
export async function readJsonWithQuarantine(file, fallback, { logger = console } = {}) {
  let text;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch {
    const quarantine = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.promises.rename(file, quarantine).catch(() => {});
    logger.warn?.(`[modelduck] Ignored a damaged state file; moved it to ${quarantine}`);
    try {
      const backup = await fs.promises.readFile(`${file}.bak`, "utf8");
      const parsed = JSON.parse(backup);
      logger.warn?.(`[modelduck] Restored state from ${file}.bak`);
      return parsed;
    } catch {
      return fallback;
    }
  }
}

export async function assertDiskSpace(directory, neededBytes) {
  try {
    const stats = await fs.promises.statfs(directory);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < neededBytes + MIN_FREE_BYTES) {
      throw new AppError("Not enough free disk space", {
        code: "disk_full",
        status: 507,
        why: `ModelDuck needs ${formatBytes(neededBytes)} but only ${formatBytes(
          free,
        )} is free on this drive.`,
        fix: "Free some disk space, choose another models folder, or pick a smaller model.",
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // statfs is unavailable on some unusual filesystems; do not block there.
  }
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = "B";
  for (const next of units) {
    if (size < 1024) break;
    size /= 1024;
    unit = next;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${unit}`;
}

/**
 * One ModelDuck process owns a home folder at a time. The lock is advisory
 * and stale after 30 seconds, so a crashed process never bricks the app.
 */
export async function acquireHomeLock(file, { timeoutMs = 3000, staleMs = 30000 } = {}) {
  await ensureDirectory(path.dirname(file));
  const started = Date.now();

  while (true) {
    try {
      const handle = await fs.promises.open(file, "wx");
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.close();
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.promises.utimes(file, now, now).catch(() => {});
      }, 10_000);
      heartbeat.unref?.();
      return {
        file,
        async release() {
          clearInterval(heartbeat);
          await fs.promises.unlink(file).catch(() => {});
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let stale = false;
      try {
        const stats = await fs.promises.stat(file);
        stale = Date.now() - stats.mtimeMs > staleMs;
      } catch {
        // The owner removed it between our open and stat; retry immediately.
        continue;
      }

      if (stale) {
        await fs.promises.unlink(file).catch(() => {});
        continue;
      }

      if (Date.now() - started >= timeoutMs) {
        throw new AppError("ModelDuck is already running", {
          code: "already_running",
          status: 409,
          why: "Another ModelDuck process is using this data folder.",
          fix: "Close the other ModelDuck window, or start this one with a different --home folder.",
        });
      }

      await sleep(100);
    }
  }
}
