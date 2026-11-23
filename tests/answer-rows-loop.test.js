import assert from "node:assert/strict";
import test from "node:test";

import { ANSWER_ROWS_MODE, serializeAnswerRows } from "../src/tune-runs.js";

test("answer rows are serialized with a direct loop", () => {
  assert.equal(ANSWER_ROWS_MODE, "loop");
});

test("serialized rows are byte-identical to map+join", () => {
  const rows = [
    { item: "a", seed: 42, passed: 1, total: 1, text: "ok" },
    { item: "b", seed: 7, passed: 0, total: 2, error: "boom", text: null },
  ];
  const reference = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  assert.equal(serializeAnswerRows(rows), reference);
  assert.equal(serializeAnswerRows([]), "");
});
