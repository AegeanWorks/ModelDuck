import test from "node:test";

// A benchmark CLI is an entry point, not a library: importing it from a test
// (or any tool) must never run its main. report.mjs and merge-shards.mjs
// shipped this guard first; these tests pin it for all seven CLIs. Without
// the guard these imports start real work — importing tune-gate.mjs once ran
// a full gate from a one-line eval during development.
//
// The pre-fix state is execution-proven, not unit-proven: importing the
// ungated scripts had real side effects (real gates, real history links),
// so the failing state was demonstrated live instead of inside the suite.

test("benchmark CLIs import without running their main", async (t) => {
  for (const name of ["tune-gate", "tune-run", "run", "link", "report", "merge-shards", "verify-manifest"]) {
    await t.test(name, async () => {
      await import(`../benchmarks/${name}.mjs`); // a run here is the failure
    });
  }
});
