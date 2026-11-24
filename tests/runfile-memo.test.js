import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { answersFile, resetRunFileCache, runFileComputations } from "../src/tune-runs.js";

const dir = path.join("some", "tune", "dir");
const id = "2026-11-24T00-00-00-0000";

test("run file paths are derived once per directory and id", () => {
  resetRunFileCache();
  const before = runFileComputations();
  const first = answersFile(dir, id);
  assert.equal(first, path.join(dir, `${id}.answers.jsonl`));
  assert.equal(runFileComputations(), before + 1, "first lookup builds the path");

  const after = runFileComputations();
  assert.equal(answersFile(dir, id), first, "same id reuses the path");
  assert.equal(runFileComputations(), after, "no rebuild");
  assert.notEqual(answersFile(dir, `${id}1`), first, "a different id builds its own path");
  assert.equal(runFileComputations(), after + 1);

  assert.throws(() => answersFile(dir, "../escape"), /Unknown tune run/);
  assert.equal(runFileComputations(), after + 1, "invalid ids are still refused without caching");
});
