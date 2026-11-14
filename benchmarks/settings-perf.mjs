/** Performance evaluation for SettingsStore (IDEA-1097).
 *
 * This script measures the performance of:
 * - SettingsStore.load() with version validation
 * - SettingsStore.update() with fencing and merging
 * - fenceSettingsPatch() for unknown key filtering
 * - mergeSettingsDeep() for nested object merging
 *
 * Uses proper statistical analysis from stats-util.mjs
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SettingsStore, fenceSettingsPatch, mergeSettingsDeep, SETTINGS_VERSION } from "../src/settings.js";
import { normalizeSettings, DEFAULT_SETTINGS } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { runBenchmark } from "./stats-util.mjs";

const ITERATIONS = {
  cpu: 1000,  // CPU-bound tests
  io: 10      // I/O-bound tests
};

const logger = { warn() {}, error() {} };

/** Time one function: two warmup calls, then `iterations` timed ones, in seconds. */
function benchmark(name, fn, iterations, filterOutliersFlag = false) {
  return runBenchmark(name, fn, { iterations, warmup: 2, filterOutliers: filterOutliersFlag });
}

export async function main() {
  console.log("=".repeat(70));
  console.log("ModelDuck SettingsStore Performance Evaluation (IDEA-1097)");
  console.log("=".repeat(70));
  console.log();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "modelduck-perf-"));
  console.log(`Using temp directory: ${tmpDir}`);
  console.log();

  const results = [];

  try {
    // Benchmark 1: fenceSettingsPatch with small object
    results.push(await benchmark(
      "1. fenceSettingsPatch (small object, 10 keys)",
      () => {
        const patch = { temperature: 0.5, maxTokens: 100, checkpoints: true, batchSize: 32, useMmap: "on", threads: 4, gpuLayers: 0, contextSize: 16384, penalizeNewLine: true, dryBase: 1.75 };
        return fenceSettingsPatch(patch);
      },
      ITERATIONS.cpu,
      true
    ));

    // Benchmark 2: fenceSettingsPatch with large object (many unknown keys)
    results.push(await benchmark(
      "2. fenceSettingsPatch (large object, 50 keys, 40 unknown)",
      () => {
        const patch = { ...DEFAULT_SETTINGS };
        for (let i = 0; i < 40; i++) {
          patch[`unknownKey${i}`] = i;
        }
        return fenceSettingsPatch(patch);
      },
      ITERATIONS.cpu,
      true
    ));

    // Benchmark 3: mergeSettingsDeep with nested objects
    results.push(await benchmark(
      "3. mergeSettingsDeep (nested objects, 5 levels)",
      () => {
        const current = normalizeSettings({});
        const patch = {
          nested: {
            level1: {
              level2: {
                level3: {
                  level4: { value: 42 }
                }
              }
            }
          }
        };
        return mergeSettingsDeep(current, patch);
      },
      ITERATIONS.cpu,
      true
    ));

    // Benchmark 4: normalizeSettings with default settings
    results.push(await benchmark(
      "4. normalizeSettings (DEFAULT_SETTINGS)",
      () => {
        return normalizeSettings({ ...DEFAULT_SETTINGS });
      },
      ITERATIONS.cpu,
      true
    ));

    // Benchmark 5: SettingsStore.load() with valid file
    const validFile = path.join(tmpDir, "valid-settings.json");
    await writeJsonAtomic(validFile, {
      version: SETTINGS_VERSION,
      settings: { ...DEFAULT_SETTINGS, temperature: 0.7 }
    });
    
    const storeValid = new SettingsStore({ file: validFile, logger });
    results.push(await benchmark(
      "5. SettingsStore.load() (valid file, cached)",
      async () => {
        return await storeValid.load();
      },
      ITERATIONS.io,
      false
    ));

    // Benchmark 6: SettingsStore.update()
    const updateFile = path.join(tmpDir, "update-settings.json");
    await writeJsonAtomic(updateFile, {
      version: SETTINGS_VERSION,
      settings: { ...DEFAULT_SETTINGS }
    });
    
    const storeUpdate = new SettingsStore({ file: updateFile, logger });
    await storeUpdate.load();
    
    results.push(await benchmark(
      "6. SettingsStore.update() (small patch)",
      async () => {
        return await storeUpdate.update({ temperature: 0.8, maxTokens: 200 });
      },
      ITERATIONS.io,
      false
    ));

    // Benchmark 7: SettingsStore.load() with newer version (should fail fast)
    const newerFile = path.join(tmpDir, "newer-settings.json");
    await writeJsonAtomic(newerFile, {
      version: SETTINGS_VERSION + 1,
      settings: { ...DEFAULT_SETTINGS }
    });
    
    const storeNewer = new SettingsStore({ file: newerFile, logger });
    results.push(await benchmark(
      "7. SettingsStore.load() (newer version - validation reject)",
      async () => {
        try {
          await storeNewer.load();
        } catch (e) {
          // Expected to throw
        }
      },
      ITERATIONS.io,
      false
    ));

    // Benchmark 8: SettingsStore.load() with missing version (should succeed)
    const noVersionFile = path.join(tmpDir, "no-version-settings.json");
    await writeJsonAtomic(noVersionFile, {
      settings: { ...DEFAULT_SETTINGS }
    });
    
    const storeNoVersion = new SettingsStore({ file: noVersionFile, logger });
    results.push(await benchmark(
      "8. SettingsStore.load() (missing version - backward compatible)",
      async () => {
        return await storeNoVersion.load();
      },
      ITERATIONS.io,
      false
    ));

    console.log("=".repeat(70));
    console.log("Performance evaluation complete!");
    console.log("=".repeat(70));
    console.log();
    console.log("Statistical Summary:");
    console.log("- All values include mean, median, std dev, 95% CI");
    console.log("- Percentiles (p50, p95, p99) show distribution");
    console.log("- CV (Coefficient of Variation) = stdDev / mean");
    console.log("- Throughput = operations per second");
    console.log("- Outliers filtered using 1.5*IQR rule where noted");

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Run only when started as a script (npm run perf:settings), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exitCode = 1;
  });
}
