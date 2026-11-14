import assert from "node:assert/strict";
import test from "node:test";

import { recommendCatalog, recommendModels } from "../src/recommend.js";

const GIB = 1024 ** 3;
const memory = { free: 4 * GIB, total: 16 * GIB };
const shape = { layers: 24, kvHeads: 2, headDim: 64 };
const model = (id, size) => ({ id, name: id, fileName: `${id}.gguf`, profileId: id, size, kvShape: shape });
const profile = (rate, tokensPerSecond) => ({
  load: { settings: { contextSize: 2048, kvCache: "f16" } },
  tasks: { code: { stats: { rate, tokensPerSecond } } },
});

test("measured models that fit come first, ranked by right answers then speed", () => {
  const rows = recommendModels({
    models: [model("small", 0.2e9), model("big", 1.5e9), model("mid", 0.6e9)],
    profiles: { small: profile(50, 30), big: profile(70, 8), mid: null },
    memory,
    task: "code",
  });
  assert.deepEqual(rows.map((row) => row.id), ["big", "small", "mid"]);
  assert.equal(rows[0].measured, true);
  assert.equal(rows[2].measured, false);
  assert.match(rows[0].why, /Measured on this PC: 70% on code, 8 tok\/s/);
});

test("a model that will not fit is left out", () => {
  const rows = recommendModels({
    models: [model("huge", 8e9), model("small", 0.2e9)],
    profiles: { small: profile(50, 30) },
    memory,
    task: "code",
  });
  assert.deepEqual(rows.map((row) => row.id), ["small"]);
});

test("without a KV shape the weights and runtime still decide the fit", () => {
  const flat = { id: "flat", name: "flat", fileName: "flat.gguf", profileId: "flat", size: 1e9 };
  const rows = recommendModels({ models: [flat], profiles: {}, memory, task: "code" });
  assert.equal(rows[0].fit, "comfortable");
  assert.equal(rows[0].measured, false);
});

test("a profile without a measured rate is not ranked as measured", () => {
  const rows = recommendModels({
    models: [model("imported", 0.2e9)],
    profiles: { imported: { load: {}, tasks: { code: { stats: { imported: true } } } } },
    memory,
    task: "code",
  });
  assert.equal(rows[0].measured, false);
  assert.match(rows[0].why, /no measured code rate/);
});

test("catalog estimates skip installed and too-large models, recommended first", () => {
  const catalog = [
    { id: "a", name: "A", size: 0.5e9, recommended: true, params: "0.5B", quant: "Q4" },
    { id: "b", name: "B", size: 0.2e9, recommended: false },
    { id: "installed", name: "I", size: 0.4e9 },
    { id: "huge", name: "H", size: 8e9 },
  ];
  const rows = recommendCatalog({ catalog, installed: ["installed"], memory });
  assert.deepEqual(rows.map((row) => row.id), ["a", "b"], "recommended first, then smaller");
  assert.equal(rows[0].fit, "fits (weights and runtime only)");
});

test("a catalog model with a measured shipped preset ranks by that rate, labelled as another machine's (ADR-129)", () => {
  const catalog = [
    { id: "general", name: "General", size: 0.5e9, recommended: true },
    { id: "coder", name: "Coder", size: 1.1e9, recommended: false },
    { id: "tiny", name: "Tiny", size: 0.1e9, recommended: false },
    { id: "unmeasured", name: "Unmeasured", size: 0.3e9, recommended: false },
  ];
  const measured = {
    general: { rate: 35.4, items: 48, measuredOn: "CPU X" },
    coder: { rate: 54.2, items: 48, measuredOn: "CPU X" },
    tiny: { rate: 10.4, items: 48, measuredOn: "CPU X" },
  };
  const rows = recommendCatalog({ catalog, installed: [], memory, measured });
  assert.deepEqual(rows.map((row) => row.id), ["coder", "general", "tiny", "unmeasured"], "measured first by rate, then the old order");
  assert.equal(rows[0].measuredRate, 54.2);
  assert.equal(rows[0].measuredItems, 48);
  assert.match(rows[0].why, /54\.2% on 48 items, measured on CPU X with the shipped preset; tune it to measure this PC/);
  assert.equal(rows[3].measuredRate, null);
  assert.deepEqual(recommendCatalog({ catalog, installed: [], memory }).map((row) => row.id), ["general", "tiny", "unmeasured", "coder"], "without measurements nothing changes");
});
