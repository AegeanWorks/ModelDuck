import os from "node:os";

import { APP_NAME, VERSION } from "./config.js";

export function systemInfo() {
  const cpus = os.cpus();
  return {
    app: APP_NAME,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus[0]?.model?.trim() || "unknown CPU",
    cores: cpus.length,
    parallelism:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : cpus.length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    uptime: process.uptime(),
  };
}

/**
 * IDEA-1198: host-side health without process-wide tricks. One event-loop
 * round trip in milliseconds; a busy loop shows up here before it shows up
 * anywhere else. No monitorEventLoopDelay, no priority games.
 */
export function measureLoopLag() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setTimeout(() => {
      resolve(Number(process.hrtime.bigint() - start) / 1e6);
    }, 0);
  });
}
