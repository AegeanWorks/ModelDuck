/** Multi-step performance tests for ModelDuck.
 *
 * These tests measure realistic workflows that exercise multiple components
 * working together, providing more meaningful performance metrics than
 * isolated function benchmarks.
 *
 * Note: I/O-bound tests include fsync for atomic writes.
 */

import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SettingsStore } from "../src/settings.js";
import { normalizeSettings, DEFAULT_SETTINGS } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";

const logger = { warn() {}, error() {} };

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatMs(ms) {
  return `${(ms * 1000).toFixed(1)} ms`;
}

function formatSec(ms) {
  return `${ms.toFixed(1)} s`;
}

async function benchmark(name, fn, iterations = 5, note = "") {
  // Warmup
  await fn();
  
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }
  
  const m = mean(times);
  const min = Math.min(...times);
  const max = Math.max(...times);
  
  const unit = m > 1 ? "s" : "ms";
  const scale = unit === "s" ? 1 : 1000;
  
  console.log(`${name}:`);
  console.log(`  Mean: ${(m * scale).toFixed(1)} ${unit}`);
  console.log(`  Min:  ${(min * scale).toFixed(1)} ${unit}`);
  console.log(`  Max:  ${(max * scale).toFixed(1)} ${unit}`);
  if (note) {
    console.log(`  Note: ${note}`);
  }
  console.log();
  
  return { name, mean: m, min, max, iterations };
}

/**
 * Multi-step workflow 1: Settings lifecycle
 * Load → Update → Update → Reload
 */
async function benchmarkSettingsLifecycle(tmpDir) {
  const file = path.join(tmpDir, "settings-lifecycle.json");
  
  // Setup: create the file once
  await writeJsonAtomic(file, { version: 1, settings: { ...DEFAULT_SETTINGS } });
  
  async function run() {
    const store = new SettingsStore({ file, logger });
    await store.load();
    await store.update({ temperature: 0.7, maxTokens: 100 });
    await store.update({ temperature: 0.8, batchSize: 64 });
    const store2 = new SettingsStore({ file, logger });
    await store2.load();
    return store2.value;
  }
  
  return benchmark("Settings lifecycle (load→update→update→reload)", run, 3, "I/O-bound with fsync");
}

/**
 * Multi-step workflow 2: Normalization pipeline (CPU-bound, no I/O)
 * Raw input → fence → normalize → merge
 */
async function benchmarkNormalizationPipeline() {
  const { fenceSettingsPatch, mergeSettingsDeep } = await import("../src/settings.js");
  
  // Setup: create test data
  const rawPatch = {
    temperature: "0.5",
    maxTokens: "100",
    unknownKey1: "value1",
    unknownKey2: 123,
    nested: { deep: { value: "test" } }
  };
  
  const existing = normalizeSettings({ temperature: 0.7 });
  
  async function run() {
    const fenced = fenceSettingsPatch(rawPatch);
    const normalized = normalizeSettings(fenced);
    const merged = mergeSettingsDeep(existing, normalized);
    return merged;
  }
  
  return benchmark("Normalization pipeline (patch→fence→normalize→merge)", run, 1000, "CPU-bound");
}

/**
 * Multi-step workflow 3: Version validation
 * Tests the version fence with various file versions
 */
async function benchmarkVersionValidation(tmpDir) {
  const files = [];
  
  // Setup: create files with different versions
  for (const version of [0, 1, 2, undefined]) {
    const file = path.join(tmpDir, `version-${version ?? "none"}.json`);
    const data = { settings: { ...DEFAULT_SETTINGS } };
    if (version !== undefined) data.version = version;
    await writeJsonAtomic(file, data);
    files.push(file);
  }
  
  async function run() {
    for (const file of files) {
      const store = new SettingsStore({ file, logger });
      try {
        await store.load();
      } catch (e) {
        // Expected for newer version
      }
    }
  }
  
  return benchmark("Version validation (4 scenarios: v0/v1/v2/none)", run, 3, "I/O-bound with fsync");
}

/**
 * Multi-step workflow 4: Batch update test
 * Multiple updates to the same store
 */
async function benchmarkBatchUpdates(tmpDir) {
  const file = path.join(tmpDir, "batch-update.json");
  
  // Setup
  await writeJsonAtomic(file, { version: 1, settings: { ...DEFAULT_SETTINGS } });
  
  async function run() {
    const store = new SettingsStore({ file, logger });
    await store.load();
    
    // Apply 5 updates
    await store.update({ temperature: 0.5 });
    await store.update({ maxTokens: 100 });
    await store.update({ batchSize: 32 });
    await store.update({ threads: 4 });
    await store.update({ contextSize: 8192 });
    
    await store.load();
  }
  
  return benchmark("Batch updates (5 sequential updates + reload)", run, 2, "I/O-bound with fsync");
}

/**
 * Multi-step workflow 5: Parallel file operations
 * Load from multiple files simultaneously
 */
async function benchmarkParallelLoads(tmpDir) {
  const files = [];
  
  // Setup: create 3 files
  for (let i = 0; i < 3; i++) {
    const file = path.join(tmpDir, `parallel-${i}.json`);
    await writeJsonAtomic(file, { version: 1, settings: { ...DEFAULT_SETTINGS, temperature: 0.5 + i * 0.1 } });
    files.push(file);
  }
  
  async function run() {
    const promises = files.map(async (file) => {
      const store = new SettingsStore({ file, logger });
      await store.load();
    });
    await Promise.all(promises);
  }
  
  return benchmark("Parallel loads (3 files simultaneously)", run, 3, "I/O-bound with fsync");
}

/**
 * Multi-step workflow 6: CPU-bound deep merge test
 */
async function benchmarkDeepMerge() {
  const { mergeSettingsDeep } = await import("../src/settings.js");
  
  // Create deeply nested structures
  let current = { a: { b: { c: { d: { e: 1 } } } } };
  const patch = { a: { b: { c: { d: { e: 2, f: 3 } } } } };
  
  async function run() {
    for (let i = 0; i < 100; i++) {
      current = mergeSettingsDeep(current, patch);
    }
    return current;
  }
  
  return benchmark("Deep merge (100 iterations, 5 levels deep)", run, 100, "CPU-bound");
}

async function main() {
  console.log("=".repeat(70));
  console.log("ModelDuck Multi-Step Performance Tests");
  console.log("=".repeat(70));
  console.log();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "modelduck-multistep-"));
  console.log(`Using temp directory: ${tmpDir}`);
  console.log();

  try {
    await benchmarkSettingsLifecycle(tmpDir);
    await benchmarkNormalizationPipeline();
    await benchmarkVersionValidation(tmpDir);
    await benchmarkBatchUpdates(tmpDir);
    await benchmarkParallelLoads(tmpDir);
    await benchmarkDeepMerge();

    console.log("=".repeat(70));
    console.log("Multi-step performance tests complete!");
    console.log("=".repeat(70));
    console.log();
    console.log("Summary:");
    console.log("- I/O-bound tests dominate due to fsync for atomic writes");
    console.log("- CPU-bound tests (normalization, deep merge) are much faster");
    console.log("- Parallel loads show concurrent I/O performance");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
