import assert from "node:assert/strict";
import test from "node:test";

import { saveProfile } from "../src/model-profiles.js";
import { overviewProfileReadCount, resetOverviewProfileReads } from "../src/server.js";
import { makeHarness } from "./helpers.js";

async function withHarness(t, fn) {
  const cleanups = [];
  const proxy = { addCleanup: (f) => cleanups.push(f), after: (f) => cleanups.push(f) };
  const harness = await makeHarness(proxy, { models: 60 });
  t.after(() => cleanups.reverse().forEach((fn) => fn()));
  return fn(harness);
}

test("overview probes saved profiles before loading them", async (t) => {
  await withHarness(t, async (harness) => {
    resetOverviewProfileReads();
    const response = await fetch(harness.base + "/api/tune/overview");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.models.length, 60);
    assert.ok(body.models.every((model) => model.profile === null));
    assert.equal(overviewProfileReadCount(), 0, "no profile files exist, so none should be loaded");
  });
});

test("a saved profile is still loaded and reported identically", async (t) => {
  await withHarness(t, async (harness) => {
    await saveProfile(harness.paths.profiles, {
      schema: 1,
      catalogId: "test-model-0",
      createdAt: new Date().toISOString(),
      tasks: {},
    });
    resetOverviewProfileReads();
    const body = await fetch(harness.base + "/api/tune/overview").then((r) => r.json());
    assert.equal(overviewProfileReadCount(), 1, "only the one saved profile is loaded");
    const model = body.models.find((item) => item.profileId === "test-model-0");
    assert.ok(model?.profile, "the saved profile is still reported");
    assert.equal(model.profile.catalogId, "test-model-0");
    assert.equal(body.models.filter((item) => item.profile).length, 1);
  });
});
