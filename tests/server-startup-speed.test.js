import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("the server no longer loads the benchmark suite at startup", () => {
  assert.doesNotMatch(source, /from "\.\.\/benchmarks\/tasks\.mjs"/);
  assert.doesNotMatch(source, /from "\.\.\/benchmarks\/multistep-items\.mjs"/);
});

test("the server's task vocabulary stays the suite's own frozen array", async () => {
  const idModule = await import("../benchmarks/task-ids.mjs");
  const suiteModule = await import("../benchmarks/tasks.mjs");
  assert.equal(idModule.TASKS, suiteModule.TASKS);
  assert.deepEqual(idModule.TASKS.map((task) => task.id), ["code", "comprehension", "recall"]);
});
