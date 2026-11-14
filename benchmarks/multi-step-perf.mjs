/** Multi-step performance tests for ModelDuck with proper statistical analysis.
 *
 * These tests measure realistic workflows that exercise multiple components
 * working together, providing more meaningful performance metrics than
 * isolated function benchmarks.
 *
 * Note: I/O-bound tests include fsync for atomic writes.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SettingsStore } from "../src/settings.js";
import { normalizeSettings, DEFAULT_SETTINGS } from "../src/config.js";
import { writeJsonAtomic } from "../src/fs-atomic.js";
import { formatValue, formatWithAutoUnit, isMainModule, runBenchmark } from "./stats-util.mjs";

const logger = { warn() {}, error() {} };

const DEFAULT_WARMUP = 2;
const DEFAULT_ITERATIONS = 5;

/** Time one workflow: `warmup` untimed runs, then `iterations` timed ones, in seconds. */
function benchmark(name, fn, iterations = DEFAULT_ITERATIONS, warmup = DEFAULT_WARMUP, filterOutliersFlag = false) {
  return runBenchmark(name, fn, { iterations, warmup, filterOutliers: filterOutliersFlag });
}
/**
 * Multi-step workflow 1: Settings lifecycle
 * Load → Update → Update → Reload
 */
export async function benchmarkSettingsLifecycle(tmpDir) {
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
  
  return benchmark("1. Settings lifecycle (load→update→update→reload)", run, 3, 2, false);
}

/**
 * Multi-step workflow 2: Normalization pipeline (CPU-bound, no I/O)
 * Raw input → fence → normalize → merge
 */
export async function benchmarkNormalizationPipeline() {
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
  
  return benchmark("2. Normalization pipeline (patch→fence→normalize→merge)", run, 100, 2, true);
}

/**
 * Multi-step workflow 3: Version validation
 * Tests the version fence with various file versions
 */
export async function benchmarkVersionValidation(tmpDir) {
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
  
  return benchmark("3. Version validation (4 scenarios: v0/v1/v2/none)", run, 5, 2, false);
}

/**
 * Multi-step workflow 4: Batch update test
 * Multiple updates to the same store
 */
export async function benchmarkBatchUpdates(tmpDir) {
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
  
  return benchmark("4. Batch updates (5 sequential updates + reload)", run, 2, 2, false);
}

/**
 * Multi-step workflow 5: Parallel file operations
 * Load from multiple files simultaneously
 */
export async function benchmarkParallelLoads(tmpDir) {
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
  
  return benchmark("5. Parallel loads (3 files simultaneously)", run, 5, 2, false);
}

/**
 * Multi-step workflow 6: CPU-bound deep merge test
 */
export async function benchmarkDeepMerge() {
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
  
  return benchmark("6. Deep merge (100 iterations, 5 levels deep)", run, 100, 2, true);
}

/** Generate a markdown table of all results */
function generateResultsTable(results) {
  const headers = ["Test", "Mean", "Median", "Std Dev", "95% CI", "p50", "p95", "Throughput"];
  const rows = results.map(r => {
    const s = r.stats;
    return [
      r.name.replace(/^\d+\. /, ""),
      formatWithAutoUnit(s.mean),
      formatWithAutoUnit(s.median),
      formatWithAutoUnit(s.stdDev),
      `[${formatWithAutoUnit(s.confidenceInterval.lower)}, ${formatWithAutoUnit(s.confidenceInterval.upper)}]`,
      formatWithAutoUnit(s.percentiles.p50),
      formatWithAutoUnit(s.percentiles.p95),
      formatValue(s.throughput, "ops/sec")
    ];
  });
  
  // Format as markdown table
  let md = "\n\n## Statistical Summary\n\n";
  md += "| " + headers.join(" | ") + " |\n";
  md += "| " + headers.map(() => "---").join(" | ") + " |\n";
  for (const row of rows) {
    md += "| " + row.join(" | ") + " |\n";
  }
  
  return md;
}

export async function main() {
  console.log("=".repeat(70));
  console.log("ModelDuck Multi-Step Performance Tests - Proper Statistical Analysis");
  console.log("=".repeat(70));
  console.log();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "modelduck-multistep-"));
  console.log(`Using temp directory: ${tmpDir}`);
  console.log();

  const results = [];
  
  try {
    results.push(await benchmarkSettingsLifecycle(tmpDir));
    results.push(await benchmarkNormalizationPipeline());
    results.push(await benchmarkVersionValidation(tmpDir));
    results.push(await benchmarkBatchUpdates(tmpDir));
    results.push(await benchmarkParallelLoads(tmpDir));
    results.push(await benchmarkDeepMerge());

    console.log("=".repeat(70));
    console.log("All tests completed!");
    console.log("=".repeat(70));
    
    // Generate markdown table
    console.log(generateResultsTable(results));
    
    console.log();
    console.log("Key Statistical Values:");
    console.log("- Mean: Arithmetic average");
    console.log("- Median: Middle value (50th percentile)");
    console.log("- Std Dev: Measure of variability");
    console.log("- CV: Coefficient of variation (stdDev/mean)");
    console.log("- 95% CI: 95% confidence interval for the mean");
    console.log("- Percentiles: Distribution points");
    console.log("- Throughput: Operations per second");
    console.log();
    console.log("Note: I/O-bound tests include fsync for atomic writes.");
    console.log("      Outliers filtered using 1.5*IQR rule where noted.");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Run only when started as a script (npm run perf:multistep), never on import.
if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exitCode = 1;
  });
}
