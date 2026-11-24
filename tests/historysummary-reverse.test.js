import assert from "node:assert/strict";
import test from "node:test";

import { historySummary } from "../src/benchmark-report.js";

function makeRuns(count) {
  return Array.from({ length: count }, (_, i) => ({
    uid: `u${i}`,
    result: { phase: i % 7 === 0 ? "chat" : "model", finishedAt: "2026-01-01", overall: { score: i / 100 }, testHash: "t", runtimeMs: i },
    recordedAt: "2026-01-02",
    baseline: i % 11 === 0,
    git: { hash: `${i}`.repeat(8), subject: `commit ${i}` },
  }));
}

test("historySummary keeps only the newest phased runs in order", () => {
  const runs = makeRuns(400);
  const rows = historySummary(runs, new Map(), 5);
  assert.equal(rows.length, 5);
  const newest = runs.slice(-5).reverse();
  assert.deepEqual(rows.map((r) => r.phase), newest.map((r) => r.result.phase));
  assert.deepEqual(rows.map((r) => r.commit.hash), newest.map((r) => r.git.hash.slice(0, 7)));
});

test("historySummary stops scanning once the limit is reached", () => {
  const runs = makeRuns(5000);
  let filterCalls = 0;
  const counted = new Proxy(runs, {
    get(target, prop, receiver) {
      if (prop === "filter") filterCalls += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const rows = historySummary(counted, new Map(), 8);
  assert.equal(rows.length, 8);
  assert.equal(filterCalls, 0, "a long history must not be filtered end to end");
});
