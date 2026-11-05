import assert from "node:assert/strict";
import test from "node:test";

import { sseWaitForDrain } from "../src/http.js";
import { ladderRank, recordLoadSample, resetCalibration } from "../src/memory-fit.js";

// normalizeStop is not exported; verify via openai options behavior is covered
// by existing contract tests. Here we pin the underlying helpers.
test("grammar signature distinguishes object schemas", async () => {
  const { grammarSignatureFor: sig } = await import("../src/engine.js");
  const a = sig("m1", { structuredOutput: "json_schema", jsonSchema: { type: "object", properties: { a: { type: "string" } } } });
  const b = sig("m1", { structuredOutput: "json_schema", jsonSchema: { type: "object", properties: { b: { type: "string" } } } });
  assert.notEqual(a, b);
  const s = sig("m1", { structuredOutput: "json_schema", jsonSchema: '{"type":"object"}' });
  assert.ok(s.includes('{"type":"object"}'));
});

test("sseWaitForDrain removes listeners on resolve", async () => {
  const { EventEmitter } = await import("node:events");
  const res = new EventEmitter();
  const p = sseWaitForDrain(res);
  res.emit("drain");
  await p;
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("error"), 0);
  assert.equal(res.listenerCount("close"), 0);
});

test("quant ladder ranks full precision above quantized", () => {
  assert.ok(ladderRank("f16") > ladderRank("q8_0"));
  assert.ok(ladderRank("q8_0") > ladderRank("q4_0"));
  assert.ok(ladderRank("q4_0") > ladderRank("q3_k_m"));
});

test("load samples require positive weights and growth", async () => {
  resetCalibration();
  const { calibratedReserveBytes } = await import("../src/memory-fit.js");
  const base = calibratedReserveBytes();
  assert.ok(Number.isFinite(base));
  // Zero weights and equal rss add nothing.
  recordLoadSample({ rssBytes: 1000, modelBytes: 0 });
  recordLoadSample({ rssBytes: 1000, modelBytes: 1000 });
  assert.equal(calibratedReserveBytes(), base);
});

test("sampler chain module exposes canonical order", async () => {
  const mod = await import("../src/sampler-chain.js");
  assert.ok(Array.isArray(mod.SAMPLER_ORDER));
  assert.ok(mod.SAMPLER_ORDER.includes("temperature"));
});
