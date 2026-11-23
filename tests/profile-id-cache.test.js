import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_CATALOG } from "../src/model-catalog.js";
import { profileIdComputations, profileIdFor, resetProfileIdCache } from "../src/model-profiles.js";

test("a profile id is computed once per filename", () => {
  resetProfileIdCache();
  const before = profileIdComputations();
  const first = profileIdFor("my-model-v2.gguf");
  assert.equal(profileIdFor("my-model-v2.gguf"), first);
  assert.equal(profileIdComputations(), before + 1);
  assert.equal(profileIdFor("another.gguf"), profileIdFor("another.gguf"));
  assert.equal(profileIdComputations(), before + 2);
});

test("catalog models and hand-imported names keep their ids", () => {
  resetProfileIdCache();
  const known = MODEL_CATALOG[0];
  assert.equal(profileIdFor(known.file), known.id);
  assert.equal(profileIdFor("My Model v2.GGUF"), "my-model-v2");
  assert.equal(profileIdFor("123 leading.gguf"), "123-leading");
});
