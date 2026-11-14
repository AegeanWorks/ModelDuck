import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { isMainModule, runBenchmark, summarizeStats } from "../benchmarks/stats-util.mjs";

// The perf scripts and their advisor work in seconds (stats-util's unit). They
// used to record performance.now() milliseconds, so every printed time was
// 1000x too large and the advisor's second-based thresholds misjudged them.

test("throughput is one over the mean time, in operations per second", () => {
  assert.equal(summarizeStats([0.002, 0.002, 0.002]).throughput, 500);
  assert.equal(summarizeStats([0.5, 1.5]).throughput, 1);
});

test("a benchmark records seconds, whatever clock it is given", async () => {
  let now = 0;
  const clock = () => now; // performance.now() semantics: milliseconds
  const result = await runBenchmark("two ms", async () => { now += 2; }, { iterations: 3, warmup: 1, clock, log: () => {} });
  assert.deepEqual(result.rawTimes, [0.002, 0.002, 0.002]);
  assert.equal(result.stats.mean, 0.002);
  assert.equal(result.stats.throughput, 500);
});

test("importing a perf script runs nothing; its workflows are exports", async () => {
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(" "));
  try {
    const settings = await import("../benchmarks/settings-perf.mjs");
    const multistep = await import("../benchmarks/multi-step-perf.mjs");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof settings.main, "function");
    for (const name of ["benchmarkSettingsLifecycle", "benchmarkNormalizationPipeline", "benchmarkVersionValidation", "benchmarkBatchUpdates", "benchmarkParallelLoads", "benchmarkDeepMerge", "main"]) {
      assert.equal(typeof multistep[name], "function", `multi-step-perf exports ${name}`);
    }
  } finally {
    console.log = original;
  }
  assert.deepEqual(logged, [], "no benchmark ran on import");
});

test("the advisor imports, and judges times in seconds", async () => {
  const { BenchmarkAdvisor } = await import("../benchmarks/benchmark-advisor.mjs");
  const advisor = new BenchmarkAdvisor();
  const result = (name, mean) => ({ name, stats: summarizeStats([mean, mean, mean], name), rawTimes: [mean, mean, mean] });
  assert.equal(advisor.analyzeBenchmark(result("fast", 0.0002)).tags.includes("high-latency"), false, "0.2 ms is not slow");
  assert.equal(advisor.analyzeBenchmark(result("slow", 0.2)).tags.includes("high-latency"), true, "200 ms is");
});

// --- reforge run-1 findings -------------------------------------------------------------------

test("a benchmark with fewer than one iteration is refused with a clear error", async () => {
  await assert.rejects(() => runBenchmark("none", async () => {}, { iterations: 0, log: () => {} }), /iterations/i);
  await assert.rejects(() => runBenchmark("none", async () => {}, { iterations: -3, log: () => {} }), /iterations/i);
});

test("a script counts as the main module when started through a symlink or junction", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelduck-main-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  const file = path.join(real, "script.mjs");
  fs.writeFileSync(file, "");
  const link = path.join(dir, "link");
  try {
    fs.symlinkSync(real, link, "junction");
  } catch {
    t.skip("this machine cannot create a symlink or junction");
    return;
  }
  const url = pathToFileURL(fs.realpathSync(file)).href; // import.meta.url is the resolved path
  assert.equal(isMainModule(url, path.join(real, "script.mjs")), true, "started by its real path");
  assert.equal(isMainModule(url, path.join(link, "script.mjs")), true, "started through the link");
  assert.equal(isMainModule(url, path.join(dir, "other.mjs")), false, "another file is not it");
  assert.equal(isMainModule(url, undefined), false, "no script argument (an import from -e)");
});

test("the advisor does not call a slow result I/O bound from its timing alone", async () => {
  const { BenchmarkAdvisor } = await import("../benchmarks/benchmark-advisor.mjs");
  const advisor = new BenchmarkAdvisor();
  const result = (name, mean) => ({ name, stats: summarizeStats([mean, mean, mean], name), rawTimes: [mean, mean, mean] });
  for (const mean of [0.2, 2]) {
    const analysis = advisor.analyzeBenchmark(result("cpu-bound", mean));
    assert.equal(analysis.tags.includes("io-bound"), false, `${mean} s`);
    assert.equal([...analysis.findings, ...analysis.recommendations].some((text) => /I\/O/.test(text)), false, "no I/O guess in the text");
  }
  const all = advisor.analyzeAll([result("a", 0.2), result("b", 0.0002)]);
  assert.equal("ioBound" in all, false, "the report no longer has an ioBound list");
  assert.deepEqual(all.bottlenecks, ["a"], "slow results are still listed as bottlenecks");
});
