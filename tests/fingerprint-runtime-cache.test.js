import assert from "node:assert/strict";
import test from "node:test";

import { currentFingerprint, fingerprintComputations, resetFingerprintCache } from "../src/model-profiles.js";

const ENTRY = { fileName: "model.gguf", size: 1000 };

test("an explicit runtime is part of the fingerprint cache key", async () => {
  resetFingerprintCache();
  const first = await currentFingerprint(ENTRY, { nodeLlamaCpp: "3.22.2" });
  assert.equal(fingerprintComputations(), 1);
  const second = await currentFingerprint(ENTRY, { nodeLlamaCpp: "3.22.2" });
  assert.equal(fingerprintComputations(), 1, "same model and runtime reuse the cached fingerprint");
  assert.deepEqual(second, first);
  const other = await currentFingerprint(ENTRY, { nodeLlamaCpp: "9.9.9" });
  assert.equal(fingerprintComputations(), 2);
  assert.equal(other.nodeLlamaCpp, "9.9.9");
  assert.notDeepEqual(other, first);
});

test("a different model size still computes a new fingerprint", async () => {
  resetFingerprintCache();
  await currentFingerprint(ENTRY, { nodeLlamaCpp: "3.22.2" });
  await currentFingerprint({ fileName: "model.gguf", size: 2000 }, { nodeLlamaCpp: "3.22.2" });
  assert.equal(fingerprintComputations(), 2);
});
