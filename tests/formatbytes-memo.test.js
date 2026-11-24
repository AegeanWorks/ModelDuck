import assert from "node:assert/strict";
import test from "node:test";

import { formatBytes, formatBytesComputations, resetFormatBytesCache } from "../src/fs-atomic.js";

test("formatBytes is derived once per normalized value", () => {
  resetFormatBytesCache();
  const before = formatBytesComputations();
  assert.equal(formatBytes(4e9), "3.73 GB");
  assert.equal(formatBytesComputations(), before + 1);
  const after = formatBytesComputations();
  assert.equal(formatBytes(4e9), "3.73 GB");
  assert.equal(formatBytesComputations(), after, "repeated size is cached");
  assert.equal(formatBytes("4000000000"), "3.73 GB", "numeric strings share the cache");
  assert.equal(formatBytesComputations(), after);
});

test("formatBytes keeps every formatting branch", () => {
  resetFormatBytesCache();
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(15360), "15.0 KB");
  assert.equal(formatBytes(1073741824), "1.00 GB");
  assert.equal(formatBytes(-5), "-5 B");
  assert.equal(formatBytes(NaN), "0 B");
});
