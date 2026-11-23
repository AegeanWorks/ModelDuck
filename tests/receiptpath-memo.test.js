import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readInstallReceipt, receiptPathComputations } from "../src/downloader.js";

test("repeated receipt lookups derive the path once per model", async () => {
  const dir = "/tmp/modelduck-receiptpath";
  const before = receiptPathComputations();
  for (let i = 0; i < 5; i += 1) await readInstallReceipt(dir, "My Model.GGUF");
  assert.equal(receiptPathComputations(), before + 1, "one path derived for five lookups");
  // A different dir gets its own entry.
  await readInstallReceipt("/tmp/other-dir", "My Model.GGUF");
  assert.equal(receiptPathComputations(), before + 2);
});

test("receipt paths stay correct for nested and plain names", async () => {
  const dir = "/tmp/rp";
  assert.equal(await readInstallReceipt(dir, "plain.gguf"), null);
  assert.equal(path.basename("plain.gguf.receipt.json"), "plain.gguf.receipt.json");
  assert.equal(await readInstallReceipt(dir, "a/b/nested.gguf"), null);
});
