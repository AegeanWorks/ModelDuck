import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_CATALOG, modelHomepage, publicCatalog, publicCatalogComputations } from "../src/model-catalog.js";

test("the public catalog is built once", () => {
  const before = publicCatalogComputations();
  const first = publicCatalog();
  const second = publicCatalog();
  assert.deepEqual(second, first);
  assert.equal(publicCatalogComputations(), before + 1);
  assert.notEqual(second, first, "a fresh array is returned to callers");
});

test("cached catalog rows keep their values and cannot be mutated", () => {
  const catalog = publicCatalog();
  assert.equal(catalog.length, MODEL_CATALOG.length);
  assert.equal(catalog[0].homepage, modelHomepage(MODEL_CATALOG[0]));
  catalog.pop();
  const after = publicCatalog();
  assert.equal(after.length, MODEL_CATALOG.length);
  assert.equal(after[0].homepage, modelHomepage(MODEL_CATALOG[0]));
});
