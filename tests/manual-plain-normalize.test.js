import assert from "node:assert/strict";
import test from "node:test";

import { NORMALIZE_PLAIN_MODE, normalizePlain } from "../benchmarks/suite.mjs";

const reference = (text) =>
  text.toLowerCase().replace(/^["'`]+|["'`]+$/g, "").replace(/[.!]+$/g, "").trim();

test("plain normalization uses the manual implementation", () => {
  assert.equal(NORMALIZE_PLAIN_MODE, "manual");
});

test("manual normalization is byte-identical to the regex chain", () => {
  const cases = [
    "The answer is 42", '"quoted"', "'single'", '`tick`', "end.", "end!!!", 'end."',
    '"end."', "  SPACED  ", "a.b.c", "", '..."quoted"...', '"foo"!!"', '  "foo"  ', '"foo".  ',
    "MiXeD CaSe!", "!!ends!!", "'''", "...", "  ", "a\"b", "a'b",
  ];
  for (const value of cases) {
    assert.equal(normalizePlain(value), reference(value), `mismatch for ${JSON.stringify(value)}`);
  }
});
