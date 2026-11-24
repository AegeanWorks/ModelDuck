import assert from "node:assert/strict";
import test from "node:test";

import { latestCommit } from "../src/benchmark-report.js";

function makeRuns(count) {
  return Array.from({ length: count }, (_, i) => ({
    uid: `u${i}`,
    result: { phase: i % 7 === 0 ? "chat" : "model", testHash: i % 2 ? "t1" : "t2" },
    git: i % 13 === 0 ? { hash: `${i}`.repeat(8), subject: `c${i}` } : null,
  }));
}

test("latestCommit returns the newest matching commit across phases and hashes", () => {
  const runs = makeRuns(5000);
  const links = new Map([["u4999", { hash: "linkedhash", subject: "from links" }]]);
  for (const phase of ["model", "chat", "other"]) {
    for (const testHash of [null, "t1", "t2", "t3"]) {
      const expected = (() => {
        for (let i = runs.length - 1; i >= 0; i -= 1) {
          const r = runs[i];
          if (r.result?.phase !== phase || (testHash && r.result?.testHash !== testHash)) continue;
          const c = links.get(r.uid) ?? r.git ?? null;
          if (c?.hash) return c;
        }
        return null;
      })();
      assert.deepEqual(latestCommit(runs, links, phase, testHash), expected, `${phase}/${testHash}`);
    }
  }
});

test("latestCommit does not filter the whole history", () => {
  const runs = makeRuns(5000);
  let filterCalls = 0;
  const counted = new Proxy(runs, {
    get(target, prop, receiver) {
      if (prop === "filter") filterCalls += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.ok(latestCommit(counted, new Map(), "model", "t1"));
  assert.equal(filterCalls, 0, "a long history must not be filtered end to end");
});
