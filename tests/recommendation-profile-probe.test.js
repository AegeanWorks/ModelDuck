import assert from "node:assert/strict";
import test from "node:test";

import { recommendationProfileReadsCount, resetRecommendationProfileReads } from "../src/server.js";
import { makeHarness } from "./helpers.js";

test("an unprofiled library does not open a profile file per model", async (t) => {
  const cleanups = [];
  const harness = await makeHarness({ addCleanup: (fn) => cleanups.push(fn), after: (fn) => cleanups.push(fn) }, { models: 60 });
  t.after(() => cleanups.reverse().forEach((fn) => fn()));
  resetRecommendationProfileReads();
  const response = await fetch(harness.base + "/api/recommendations?task=code");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.task, "code");
  assert.ok(Array.isArray(body.installed));
  assert.ok(body.installed.length > 0, "the installed models are still recommended");
  const models = await (await fetch(harness.base + "/api/models")).json();
  assert.equal(models.models.length, 60);
  assert.equal(recommendationProfileReadsCount(), 0, "no profile files exist, so none should be read");
});
