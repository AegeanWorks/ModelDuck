import fs from "node:fs";
import path from "node:path";

/**
 * Cross-process timing lock for tunes running side by side (ADR-033). A tune
 * about to time something (device or speed stage) takes `timing.lock` and
 * waits until every other running tune has paused between answers; the others
 * check `pauseIfNeeded()` before each answer and wait while the lock is held.
 * Files left by a process that died are ignored.
 */

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTimingLock({ dir, pid = process.pid, isAlive = processAlive, pollMs = 200, settleTimeoutMs = 120_000 }) {
  const lockFile = path.join(dir, "timing.lock");
  const activeFile = (owner) => path.join(dir, `active-${owner}`);
  const pausedFile = (owner) => path.join(dir, `paused-${owner}`);

  const holder = async () => {
    const text = await fs.promises.readFile(lockFile, "utf8").catch(() => null);
    const owner = Number.parseInt(text ?? "", 10);
    return Number.isFinite(owner) && owner !== pid && isAlive(owner) ? owner : null;
  };

  const others = async () => {
    const names = await fs.promises.readdir(dir).catch(() => []);
    return names
      .map((name) => /^active-(\d+)$/.exec(name)?.[1])
      .filter(Boolean)
      .map(Number)
      .filter((owner) => owner !== pid && isAlive(owner));
  };

  const markPaused = (paused) => (paused
    ? fs.promises.writeFile(pausedFile(pid), "")
    : fs.promises.rm(pausedFile(pid), { force: true }));

  return {
    async register() {
      await fs.promises.mkdir(dir, { recursive: true });
      // A tune killed outright never unregisters; clear what dead processes left behind.
      for (const name of await fs.promises.readdir(dir)) {
        const registered = /^(?:active|paused)-(\d+)$/.exec(name)?.[1];
        const owner = registered
          ? Number(registered)
          : name === "timing.lock" ? Number.parseInt(await fs.promises.readFile(path.join(dir, name), "utf8").catch(() => ""), 10) : NaN;
        if (Number.isFinite(owner) && owner !== pid && !isAlive(owner)) await fs.promises.rm(path.join(dir, name), { force: true });
      }
      await fs.promises.writeFile(activeFile(pid), "");
    },

    /** For a process "exit" handler, where nothing can be awaited. */
    unregisterSync() {
      fs.rmSync(activeFile(pid), { force: true });
      fs.rmSync(pausedFile(pid), { force: true });
      try {
        if (Number.parseInt(fs.readFileSync(lockFile, "utf8"), 10) === pid) fs.rmSync(lockFile, { force: true });
      } catch {
        // No lock file: nothing to release.
      }
    },

    async unregister() {
      await fs.promises.rm(activeFile(pid), { force: true });
      await fs.promises.rm(pausedFile(pid), { force: true });
      const text = await fs.promises.readFile(lockFile, "utf8").catch(() => null);
      if (Number.parseInt(text ?? "", 10) === pid) await fs.promises.rm(lockFile, { force: true });
    },

    /** Take the timing lock, then wait (bounded) for every other running tune to pause. */
    async acquire() {
      await fs.promises.mkdir(dir, { recursive: true });
      for (;;) {
        try {
          await fs.promises.writeFile(lockFile, String(pid), { flag: "wx" });
          break;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          if ((await holder()) === null) {
            await fs.promises.rm(lockFile, { force: true });
            continue;
          }
          // Waiting for another timing stage counts as paused, so it is not kept waiting for us.
          await markPaused(true);
          await sleep(pollMs);
        }
      }
      await markPaused(false);
      const deadline = Date.now() + settleTimeoutMs;
      for (;;) {
        const running = await others();
        const paused = await Promise.all(running.map((owner) => fs.promises.access(pausedFile(owner)).then(() => true, () => false)));
        // Settled when every other tune paused; false after the timeout (M8):
        // timed stages that proceed unsettled must say so in their record.
        if (paused.every(Boolean)) return true;
        if (Date.now() > deadline) return false;
        await sleep(pollMs);
      }
    },

    async release() {
      const text = await fs.promises.readFile(lockFile, "utf8").catch(() => null);
      if (Number.parseInt(text ?? "", 10) === pid) await fs.promises.rm(lockFile, { force: true });
    },

    /** Before an answer: wait while another tune is timing something. */
    async pauseIfNeeded() {
      if ((await holder()) === null) return;
      await markPaused(true);
      try {
        while ((await holder()) !== null) await sleep(pollMs);
      } finally {
        await markPaused(false);
      }
    },
  };
}

/**
 * Call `onGone` once when the parent process (the app that started this tune)
 * has exited; on Windows its children would otherwise keep running unseen.
 */
export function watchParent({ ppid = process.ppid, isAlive = processAlive, intervalMs = 5000, onGone }) {
  const timer = setInterval(() => {
    if (isAlive(ppid)) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
