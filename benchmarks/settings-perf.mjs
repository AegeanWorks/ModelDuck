/** Performance evaluation for SettingsStore (IDEA-1097).
 *
 * This script measures the performance of:
 * - SettingsStore.load() with version validation
 * - SettingsStore.update() with fencing and merging
 * - fenceSettingsPatch() for unknown key filtering
 * - mergeSettingsDeep() for nested object merging
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Import the functions we need to test
const { SettingsStore, fenceSettingsPatch, mergeSettingsDeep, SETTINGS_VERSION } = await import("../src/settings.js");
const { normalizeSettings, DEFAULT_SETTINGS } = await import("../src/config.js");
const { writeJsonAtomic } = await import("../src/fs-atomic.js");

const ITERATIONS = 1000;
const logger = { warn() {}, error() {} };

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values, m) {
  return Math.sqrt(values.reduce((sq, n) => sq + Math.pow(n - m, 2), 0) / values.length);
}

function formatMs(ms) {
  return `${(ms * 1000).toFixed(3)} ms`;
}

function formatOpsPerSec(ms, iterations) {
  return `${Math.round(iterations / (ms / 1000))} ops/sec`;
}

async function benchmark(name, fn, iterations = ITERATIONS) {
  // Warmup
  await fn();
  await fn();
  
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }
  
  const m = mean(times);
  const sd = stdDev(times, m);
  const min = Math.min(...times);
  const max = Math.max(...times);
  
  console.log(`${name}:`);
  console.log(`  Mean: ${formatMs(m)} (±${formatMs(sd)})`);
  console.log(`  Min:  ${formatMs(min)}`);
  console.log(`  Max:  ${formatMs(max)}`);
  console.log(`  Rate: ${formatOpsPerSec(m, iterations)}`);
  console.log();
  
  return { name, mean: m, stdDev: sd, min, max, iterations };
}

async function main() {
  console.log("=".repeat(60));
  console.log("ModelDuck SettingsStore Performance Evaluation (IDEA-1097)");
  console.log("=".repeat(60));
  console.log();

  // Create a temporary directory for test files
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "modelduck-perf-"));
  console.log(`Using temp directory: ${tmpDir}`);
  console.log();

  try {
    // Benchmark 1: fenceSettingsPatch with small object
    await benchmark(
      "fenceSettingsPatch (small object, 10 keys)",
      () => {
        const patch = { temperature: 0.5, maxTokens: 100, checkpoints: true, batchSize: 32, useMmap: "on", threads: 4, gpuLayers: 0, contextSize: 16384, penalizeNewLine: true, dryBase: 1.75 };
        return fenceSettingsPatch(patch);
      }
    );

    // Benchmark 2: fenceSettingsPatch with large object (many unknown keys)
    await benchmark(
      "fenceSettingsPatch (large object, 50 keys, 40 unknown)",
      () => {
        const patch = { ...DEFAULT_SETTINGS };
        for (let i = 0; i < 40; i++) {
          patch[`unknownKey${i}`] = i;
        }
        return fenceSettingsPatch(patch);
      }
    );

    // Benchmark 3: mergeSettingsDeep with nested objects
    await benchmark(
      "mergeSettingsDeep (nested objects, 5 levels)",
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
      }
    );

    // Benchmark 4: normalizeSettings with default settings
    await benchmark(
      "normalizeSettings (DEFAULT_SETTINGS)",
      () => {
        return normalizeSettings({ ...DEFAULT_SETTINGS });
      }
    );

    // Benchmark 5: SettingsStore.load() with valid file
    const validFile = path.join(tmpDir, "valid-settings.json");
    await writeJsonAtomic(validFile, {
      version: SETTINGS_VERSION,
      settings: { ...DEFAULT_SETTINGS, temperature: 0.7 }
    });
    
    const storeValid = new SettingsStore({ file: validFile, logger });
    await benchmark(
      "SettingsStore.load() (valid file, cached)",
      async () => {
        return await storeValid.load();
      },
      100  // Fewer iterations since this involves I/O
    );

    // Benchmark 6: SettingsStore.update()
    const updateFile = path.join(tmpDir, "update-settings.json");
    await writeJsonAtomic(updateFile, {
      version: SETTINGS_VERSION,
      settings: { ...DEFAULT_SETTINGS }
    });
    
    const storeUpdate = new SettingsStore({ file: updateFile, logger });
    await storeUpdate.load();
    
    await benchmark(
      "SettingsStore.update() (small patch)",
      async () => {
        return await storeUpdate.update({ temperature: 0.8, maxTokens: 200 });
      },
      100  // Fewer iterations due to I/O
    );

    // Benchmark 7: SettingsStore.load() with newer version (should fail fast)
    const newerFile = path.join(tmpDir, "newer-settings.json");
    await writeJsonAtomic(newerFile, {
      version: SETTINGS_VERSION + 1,
      settings: { ...DEFAULT_SETTINGS }
    });
    
    const storeNewer = new SettingsStore({ file: newerFile, logger });
    await benchmark(
      "SettingsStore.load() (newer version - validation reject)",
      async () => {
        try {
          await storeNewer.load();
        } catch (e) {
          // Expected to throw
        }
      },
      100
    );

    // Benchmark 8: SettingsStore.load() with missing version (should succeed)
    const noVersionFile = path.join(tmpDir, "no-version-settings.json");
    await writeJsonAtomic(noVersionFile, {
      settings: { ...DEFAULT_SETTINGS }
    });
    
    const storeNoVersion = new SettingsStore({ file: noVersionFile, logger });
    await benchmark(
      "SettingsStore.load() (missing version - backward compatible)",
      async () => {
        return await storeNoVersion.load();
      },
      100
    );

    console.log("=".repeat(60));
    console.log("Performance evaluation complete!");
    console.log("=".repeat(60));

  } finally {
    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
