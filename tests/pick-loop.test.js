import assert from "node:assert/strict";
import test from "node:test";

import { pick, pickComputations } from "../benchmarks/tune-evaluate.mjs";

const reference = (settings, keys) => Object.fromEntries(keys.filter((k) => k in settings).map((k) => [k, settings[k]]));

test("pick keeps the same keys and values as the reference", () => {
  const settings = { temperature: 0.1, topP: 0.9, threads: 8, reasoning: "off", extra: 1 };
  const keys = ["temperature", "topP", "topK", "threads", "reasoning", "missing"];
  assert.deepEqual(pick(settings, keys), reference(settings, keys));
  assert.deepEqual(pick({}, keys), reference({}, keys));
  assert.ok(pickComputations() >= 2);
});
