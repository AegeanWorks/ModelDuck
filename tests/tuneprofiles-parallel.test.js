import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { listProfiles, saveProfile } from "../src/model-profiles.js";
import { makeHarness } from "./helpers.js";

const profile = (extra) => ({
  schema: 1,
  catalogId: extra.catalogId,
  createdAt: new Date().toISOString(),
  tasks: { code: { settings: { temperature: 0.125 }, note: extra.note } },
});

test("the tune overview reads saved profile contents concurrently", async (t) => {
  const cleanups = [];
  const proxy = { addCleanup: (f) => cleanups.push(f), after: (f) => cleanups.push(f) };
  const harness = await makeHarness(proxy, { models: 60 });
  t.after(() => cleanups.reverse().forEach((fn) => fn()));
  for (let i = 0; i < 60; i += 1) await saveProfile(harness.paths.profiles, profile({ catalogId: `test-model-${i}`, note: "first" }));

  const first = await fetch(harness.base + "/api/tune/overview").then((r) => r.json());
  assert.equal(first.models.filter((m) => m.profile).length, 60);

  // Change the file contents so loadProfile's text cache misses, then refresh
  // listProfiles itself before patching so only loadProfile issues content reads.
  for (let i = 0; i < 60; i += 1) {
    await saveProfile(harness.paths.profiles, profile({ catalogId: `test-model-${i}`, note: "second-and-longer" }));
  }
  await listProfiles(harness.paths.profiles);

  const real = fs.promises.readFile;
  let inFlight = 0;
  let maxInFlight = 0;
  fs.promises.readFile = async (...args) => {
    if (String(args[0]).includes("profiles")) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    }
    try {
      return await real(...args);
    } finally {
      if (String(args[0]).includes("profiles")) inFlight -= 1;
    }
  };
  t.after(() => { fs.promises.readFile = real; });

  const second = await fetch(harness.base + "/api/tune/overview").then((r) => r.json());
  assert.equal(second.models.filter((m) => m.profile).length, 60, "all profiles still reported");
  assert.ok(maxInFlight > 1, `profile content reads overlapped (max ${maxInFlight})`);
});
