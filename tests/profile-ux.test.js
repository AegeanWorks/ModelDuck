import assert from "node:assert/strict";
import test from "node:test";

import { diffSettings } from "../src/tuned-settings.js";
import { capabilityFor, launchRecipe } from "../src/model-profiles.js";
import { makeHarness } from "./helpers.js";

// IDEA-1071: only changed keys are listed, sorted.
test("diffSettings lists what a profile would change", () => {
  const diff = diffSettings({ a: 1, b: 2, c: [1] }, { a: 1, b: 3, c: [1], d: 4 });
  assert.deepEqual(diff, [
    { key: "b", from: 2, to: 3 },
    { key: "d", from: null, to: 4 },
  ]);
});

// IDEA-1193: capabilities describe the installed file, honestly.
test("capabilityFor bounds code and long context to the file", () => {
  const small = capabilityFor({ size: 500 * 1024 ** 2, contextLength: 32768, sizeLabel: "0.5 GB", quant: "Q4_K_M" });
  assert.equal(small.code, true);
  assert.equal(small.longContext, true);
  const huge = capabilityFor({ size: 20 * 1024 ** 3, contextLength: 4096 });
  assert.equal(huge.code, false);
  assert.equal(huge.longContext, false);
});

// IDEA-1078: launch recipes bind the profile to the file.
test("launchRecipe carries file, profile and capability", () => {
  const recipe = launchRecipe(
    { fileName: "tiny.gguf", size: 8, chatTemplateHash: "abc" },
    { catalogId: "tiny", load: { settings: {} } },
    "deadbeef",
  );
  assert.equal(recipe.kind, "modelduck-launch");
  assert.equal(recipe.digest, "deadbeef");
  assert.equal(recipe.capability.chat, true);
});

// IDEA-1071 route: unknown profiles 404 with a typed error.
test("profile diff for an unknown model is a 404", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/profiles/no-such-model/diff`);
  assert.equal(response.status, 404);
});

// IDEA-1077 route: the instance endpoint answers even before startup fills it.
test("instance endpoint reports the server identity shape", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/instance`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok("port" in payload.instance);
});
