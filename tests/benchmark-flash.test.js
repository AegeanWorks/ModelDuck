import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_MODEL_IDS,
  buildChatMatrix,
  flashMatrix,
  modelMatrix,
  modelMatrixFor,
  resultFileName,
} from "../benchmarks/matrix.mjs";
import { SMOKE_PROMPT_IDS } from "../benchmarks/suite.mjs";

test("flash keeps one base variant per core model on the smoke set", () => {
  const flashed = flashMatrix(modelMatrix());
  assert.deepEqual(
    flashed.map((spec) => spec.catalogId).sort(),
    [...CORE_MODEL_IDS].sort(),
  );
  for (const spec of flashed) {
    assert.deepEqual(spec.promptIds, [...SMOKE_PROMPT_IDS]);
  }
});

test("flash keeps one base variant per family on the full matrix", () => {
  const flashed = flashMatrix(modelMatrix({ full: true }));
  assert.equal(flashed.length, 6);
  assert.equal(new Set(flashed.map((spec) => spec.catalogId)).size, 6);
  for (const spec of flashed) {
    assert.deepEqual(spec.promptIds, [...SMOKE_PROMPT_IDS]);
  }
});

test("flash keeps only the chat base for the chat phase", () => {
  const flashed = flashMatrix(buildChatMatrix());
  assert.equal(flashed.length, 1);
  assert.equal(flashed[0].id, "chat-base");
  assert.deepEqual(flashed[0].promptIds, [...SMOKE_PROMPT_IDS]);
});

test("flash keeps only the base entry of a single-model sweep", () => {
  const flashed = flashMatrix(modelMatrixFor("qwen2.5-0.5b-instruct-q4"));
  assert.equal(flashed.length, 1);
  assert.match(flashed[0].id, /-base$/);
  assert.deepEqual(flashed[0].promptIds, [...SMOKE_PROMPT_IDS]);
});

test("flash fails loudly when no variant looks like a base", () => {
  assert.throws(
    () => flashMatrix([{ id: "x", family: "a", catalogId: "b" }]),
    /no base variants/,
  );
});

test("flash on an empty matrix stays empty", () => {
  assert.deepEqual(flashMatrix([]), []);
});

test("result files keep flash, single-model and phase runs apart", () => {
  assert.equal(
    resultFileName({ flash: false, phase: "model", singleModelCatalogId: null }),
    "latest-model.json",
  );
  assert.equal(
    resultFileName({ flash: false, phase: "chat", singleModelCatalogId: null }),
    "latest-chat.json",
  );
  assert.equal(
    resultFileName({
      flash: false,
      phase: "model",
      singleModelCatalogId: "qwen2.5-0.5b-instruct-q4",
    }),
    "latest-single-model.json",
  );
  assert.equal(
    resultFileName({ flash: true, phase: "model", singleModelCatalogId: null }),
    "latest-flash-model.json",
  );
  assert.equal(
    resultFileName({ flash: true, phase: "chat", singleModelCatalogId: null }),
    "latest-flash-chat.json",
  );
  assert.equal(
    resultFileName({
      flash: true,
      phase: "model",
      singleModelCatalogId: "qwen2.5-0.5b-instruct-q4",
    }),
    "latest-flash-single-qwen2.5-0.5b-instruct-q4.json",
  );
});
