import assert from "node:assert/strict";
import test from "node:test";

import { recommendModels } from "../src/recommend.js";

const models = Array.from({ length: 100 }, (_, i) => ({
  id: `m${i}`, profileId: `p${i}`, name: `Model ${i}`, fileName: `m${i}.gguf`, size: 4e9,
}));
const profiles = Object.fromEntries(models.map((m, i) => [m.profileId, {
  tasks: { code: { stats: { rate: 80 - i / 10, tokensPerSecond: 100 - i } } },
  load: { settings: {} },
}]));

test("recommendModels keeps ranking, rates and explanation text", () => {
  const rows = recommendModels({ models, profiles, memory: { free: 32e9 }, task: "code" });
  assert.equal(rows.length, 5);
  assert.equal(rows[0].id, "m0");
  assert.equal(rows[0].why, "Measured on this PC: 80% on code, 100 tok/s; fits comfortably.");
  assert.deepEqual(Object.keys(rows[0]), ["id", "name", "fileName", "profileId", "measured", "rate", "tokensPerSecond", "contextSize", "memoryBytes", "fit", "why"]);
  assert.equal(recommendModels({ models: models.slice(0, 2), profiles: {}, memory: { free: 0 }, task: "code" })[0].why, "Not tuned yet; fit unknown (no KV shape).");
});

test("recommendModels only interpolates task for shown rows", () => {
  let calls = 0;
  const task = { toString() { calls += 1; return "code"; } };
  const rows = recommendModels({ models, profiles, memory: { free: 32e9 }, task });
  assert.equal(rows.length, 5);
  // 100 lookups of profiles.tasks[task] plus one explanation per shown row.
  assert.equal(calls, 105, "five explanation strings, not one per model");
});
