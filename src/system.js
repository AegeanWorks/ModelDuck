import os from "node:os";

import { APP_NAME, VERSION } from "./config.js";

/**
 * CPU model, core count and parallelism do not change while the process runs,
 * but `os.cpus()` costs ~347 us per call on this host and systemInfo() is used
 * by /api/health, /api/metrics and every fingerprint resolution. Read it once.
 * Free memory and uptime stay live in systemInfo() below.
 */
let cpuTopologyCache = null;

export function resetSystemInfoCache() {
  cpuTopologyCache = null;
}

export function cpuTopology() {
  if (cpuTopologyCache === null) {
    const cpus = os.cpus();
    cpuTopologyCache = Object.freeze({
      model: cpus[0]?.model?.trim() || "unknown CPU",
      cores: cpus.length,
      parallelism:
        typeof os.availableParallelism === "function" ? os.availableParallelism() : cpus.length,
    });
  }
  return cpuTopologyCache;
}

export function systemInfo() {
  const cpu = cpuTopology();
  return {
    app: APP_NAME,
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpu.model,
    cores: cpu.cores,
    parallelism: cpu.parallelism,
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
