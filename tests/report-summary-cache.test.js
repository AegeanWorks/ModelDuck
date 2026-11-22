import assert from "node:assert/strict";
import test from "node:test";

import { loadBenchmarkReport, resetBenchmarkReportCache, summarizeComputations } from "../src/benchmark-report.js";

const OPTS = { benchmarkDir: "C:/Users/Yunus-Emre/Desktop/portable_agent_kit/projects/modelduck/benchmarks" };

test("a cached report is summarized once per limit", async () => {
  resetBenchmarkReportCache();
  const first = await loadBenchmarkReport(OPTS);
  const afterFirst = summarizeComputations();
  const second = await loadBenchmarkReport(OPTS);
  assert.deepEqual(second, first);
  assert.equal(summarizeComputations(), afterFirst, "same limit must reuse the summary");
  const other = await loadBenchmarkReport({ ...OPTS, limit: 3 });
  assert.equal(summarizeComputations(), afterFirst + 1, "a different limit is computed once");
});
