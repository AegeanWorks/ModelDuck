import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";

import { readInstallReceipt, receiptMissingSkips, resetReceiptCounters } from "../src/downloader.js";

test("a missing receipt is not read after stat proves it absent", async (t) => {
  const dir = await mkdtemp(os.tmpdir() + "/md-receipt-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetReceiptCounters();
  assert.equal(await readInstallReceipt(dir, "absent.gguf"), null);
  assert.equal(await readInstallReceipt(dir, "absent.gguf"), null);
  assert.ok(receiptMissingSkips() > 0, "the second lookup must skip the failed read");
});

test("a receipt written later is still read and parsed", async (t) => {
  const dir = await mkdtemp(os.tmpdir() + "/md-receipt-test-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetReceiptCounters();
  let now = 1000;
  const clock = () => now;
  assert.equal(await readInstallReceipt(dir, "model.gguf", { clock }), null);
  await writeFile(dir + "/model.gguf.receipt.json", JSON.stringify({ digest: "abc", sha256: "def" }));
  // The negative result is cached for a short burst; an external write shows up
  // on the next read after that window (an app download invalidates immediately).
  // An injected clock proves the same expiry without a 600ms real-time wait.
  now = 1600;
  assert.deepEqual(await readInstallReceipt(dir, "model.gguf", { clock }), { digest: "abc", sha256: "def" });
});
