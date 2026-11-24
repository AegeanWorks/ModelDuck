import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { invalidateReceiptCache, readInstallReceipt, receiptCacheStats, resetReceiptCounters } from "../src/downloader.js";

// hygiene: allow inert receipt fixture URL; this test never performs a network request.
const receipt = { digest: "sha256:abc", sha256: "abc", url: "https://example.com", quant: "Q4_K_M", downloadedAt: "2026-01-01" };

test("a present receipt is parsed once and reused until it changes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-receipt-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model.gguf.receipt.json");
  await writeFile(file, JSON.stringify(receipt));
  resetReceiptCounters();

  const first = await readInstallReceipt(dir, "model.gguf");
  assert.deepEqual(first, receipt);
  assert.equal(receiptCacheStats().computes >= 1, true, "first read parses the file");
  const stats = receiptCacheStats();
  const second = await readInstallReceipt(dir, "model.gguf");
  assert.deepEqual(second, receipt);
  assert.equal(receiptCacheStats().hits, stats.hits + 1, "a later poll reuses the parsed receipt");

  await writeFile(file, JSON.stringify({ ...receipt, digest: "sha256:changed" }));
  const changed = await readInstallReceipt(dir, "model.gguf");
  assert.equal(changed.digest, "sha256:changed", "an edited receipt is reread");
  assert.equal(await readInstallReceipt(dir, "missing.gguf"), null, "absent receipts still return null");
});

test("explicit invalidation clears a positive entry even when its file stamp is unchanged", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-receipt-invalidate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model.gguf.receipt.json");
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  await writeFile(file, JSON.stringify({ digest: "abc" }));
  await utimes(file, fixedTime, fixedTime);
  resetReceiptCounters();
  assert.deepEqual(await readInstallReceipt(dir, "model.gguf"), { digest: "abc" });

  await writeFile(file, JSON.stringify({ digest: "xyz" }));
  await utimes(file, fixedTime, fixedTime);
  invalidateReceiptCache(dir, "model.gguf");
  assert.deepEqual(await readInstallReceipt(dir, "model.gguf"), { digest: "xyz" });
});
