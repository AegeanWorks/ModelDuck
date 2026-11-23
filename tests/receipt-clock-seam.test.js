import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";

import { readInstallReceipt, resetReceiptCounters } from "../src/downloader.js";

test("the receipt negative cache honours an injected clock", async (t) => {
  const dir = await mkdtemp(os.tmpdir() + "/md-receipt-clock-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  resetReceiptCounters();
  let now = 1000;
  const clock = () => now;
  assert.equal(await readInstallReceipt(dir, "model.gguf", { clock }), null);
  await writeFile(dir + "/model.gguf.receipt.json", JSON.stringify({ digest: "abc", sha256: "def" }));
  // Still inside the TTL: the cached miss is served without touching the file.
  now = 1001;
  assert.equal(await readInstallReceipt(dir, "model.gguf", { clock }), null, "the negative result is still cached");
  // Once the TTL has elapsed the same external write is visible.
  now = 1600;
  assert.deepEqual(await readInstallReceipt(dir, "model.gguf", { clock }), { digest: "abc", sha256: "def" });
});
