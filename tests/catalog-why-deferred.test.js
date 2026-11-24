import assert from "node:assert/strict";
import test from "node:test";

import { recommendCatalog } from "../src/recommend.js";

const catalog = Array.from({ length: 120 }, (_, i) => ({
  id: `c${i}`, name: `Catalog ${i}`, size: 4e9, params: "7B", quant: "Q4_K_M", recommended: i % 5 === 0,
}));

test("recommendCatalog keeps ranking and explanation text for the top rows", () => {
  const measured = Object.fromEntries(catalog.map((c, i) => [c.id, { rate: 70 + i / 10, items: 100 + i, measuredOn: "cpu" }]));
  const rows = recommendCatalog({ catalog, memory: { free: 32e9 }, measured });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.id), ["c119", "c118", "c117", "c116", "c115"]);
  assert.equal(rows[0].why, "81.9% on 219 items, measured on cpu with the shipped preset; tune it to measure this PC.");
  assert.deepEqual(Object.keys(rows[0]), ["measuredRate", "measuredItems", "measuredOn", "why", "id", "name", "params", "quant", "sizeBytes", "totalBytes", "recommended", "fit"]);
  const unmeasured = recommendCatalog({ catalog, memory: { free: 32e9 }, measured: {} });
  assert.equal(unmeasured[0].why, "Not measured yet; download and tune it to measure this PC.");
});

test("recommendCatalog only builds explanation strings for shown rows", () => {
  let interpolations = 0;
  const countedItems = () => ({ toString() { interpolations += 1; return "X"; } });
  const measured = Object.fromEntries(catalog.map((c, i) => [c.id, { rate: 70 + i / 10, items: countedItems(), measuredOn: "cpu" }]));
  const rows = recommendCatalog({ catalog, memory: { free: 32e9 }, measured });
  assert.equal(rows.length, 5);
  assert.equal(interpolations, 5, "one explanation string per shown row");
});
