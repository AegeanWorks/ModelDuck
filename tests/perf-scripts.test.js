import assert from "node:assert/strict";
import test from "node:test";

import { runBenchmark, summarizeStats } from "../benchmarks/stats-util.mjs";

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
