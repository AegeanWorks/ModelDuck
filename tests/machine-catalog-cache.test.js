import assert from "node:assert/strict";
import test from "node:test";

import { machineCatalog, machineCatalogComputations } from "../src/state-machine.js";

test("the immutable machine catalog is built once", () => {
  const first = machineCatalog();
  const before = machineCatalogComputations();
  const second = machineCatalog();
  assert.deepEqual(second, first);
  assert.equal(machineCatalogComputations(), before, "repeated reads reuse the computed catalog");
});
