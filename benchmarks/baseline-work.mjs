import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../src/errors.js";

/**
 * The folder a `tune:gate --update-baseline` tunes in. A random temp home lost
 * every answer when the process was killed, because its clean-up never ran and
 * a restart could not find it. A fixed folder survives a kill: the next update
 * moves the runs it finds aside and replays them, while the tune itself starts
 * in an empty home so the saturation filter sees no earlier run (ADR-124).
 *
 *   <root>/home       the tune home of the current update (profiles, tune-runs)
 *   <root>/saved      runs left by killed updates, read only for answer reuse
 *   <root>/owner.json the pid of the update that holds the folder
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readOwner(file) {
  try {
    const owner = JSON.parse(await readFile(file, "utf8"));
    return Number.isInteger(owner?.pid) ? owner.pid : null;
  } catch {
    return null;
  }
}

/** Claim the work folder, move a killed update's runs into `saved`, and empty the tune home. */
export async function prepareBaselineWork(root, { pid = process.pid, isAlive = processAlive } = {}) {
  const home = path.join(root, "home");
  const savedRuns = path.join(root, "saved");
  const ownerFile = path.join(root, "owner.json");
  const owner = await readOwner(ownerFile);
  if (owner !== null && owner !== pid && isAlive(owner)) {
    throw new AppError("Another baseline update is running", {
      code: "baseline_update_running",
      why: `Process ${owner} is updating the baseline in ${root}.`,
      fix: "Wait for it to finish, or stop that process and run the update again; its finished answers are replayed.",
    });
  }
  await mkdir(savedRuns, { recursive: true });
  const leftover = path.join(home, "tune-runs");
  for (const name of await readdir(leftover).catch(() => [])) {
    // Run files are named by start time and pid, so they never collide across attempts.
    await rename(path.join(leftover, name), path.join(savedRuns, name));
  }
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  await writeFile(ownerFile, `${JSON.stringify({ pid })}\n`);
  return { root, home, savedRuns };
}

/** A finished update leaves nothing behind. */
export async function finishBaselineWork(work) {
  await rm(work.root, { recursive: true, force: true });
}
