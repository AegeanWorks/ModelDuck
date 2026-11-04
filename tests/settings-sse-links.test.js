import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry } from "../src/model-registry.js";
import { fenceSettingsPatch, mergeSettingsDeep } from "../src/settings.js";
import { sseNeedsDrain, sseSend, sseSendBatched, sseWaitForDrain } from "../src/http.js";

const SILENT = { warn() {}, error() {}, info() {} };
const FAKE_INFO = {
  metadata: { general: { architecture: "llama" }, tokenizer: {} },
  architectureMetadata: { context_length: 4096 },
  tensorInfo: [{ dimensions: [8, 8] }],
};

// IDEA-1097: unknown keys never widen the store; nested objects merge.
test("settings fence drops unknown keys and merges nested objects", () => {
  assert.deepEqual(fenceSettingsPatch({ temperature: 0.5, evil: 1 }), { temperature: 0.5 });
  assert.deepEqual(fenceSettingsPatch("nope"), {});
  const merged = mergeSettingsDeep({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3 } });
  assert.deepEqual(merged.nested, { x: 1, y: 3 });
});

// IDEA-1197: the SSE writer reports backpressure and batches bursts.
test("sse writer returns write outcomes and batches frames", async () => {
  const writes = [];
  const res = {
    writableLength: 0,
    write(chunk) { writes.push(chunk); return true; },
    once() {},
  };
  assert.equal(sseSend(res, "tune", { n: 1 }), true);
  assert.equal(sseSendBatched(res, ["a", "b"]), true);
  assert.equal(sseSendBatched(res, []), true);
  assert.equal(sseNeedsDrain({ writableLength: 10 }), false);
  assert.equal(sseNeedsDrain({ writableLength: 70000 }), true);
  let drained = false;
  await Promise.race([
    sseWaitForDrain({ once(event, fn) { if (event === "drain") setTimeout(fn, 1); } }).then(() => { drained = true; }),
    new Promise((resolve) => setTimeout(resolve, 100)),
  ]);
  assert.equal(drained, true);
});

// IDEA-1070: a symlinked GGUF inside the library is listed.
test("symlinked models resolve inside the library", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-links-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const real = path.join(directory, "real.gguf");
  await writeFile(real, Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64, 7)]));
  try {
    await symlink(real, path.join(directory, "linked.gguf"));
  } catch {
    return; // Windows without developer mode: symlink creation needs privilege.
  }
  const registry = createModelRegistry({
    modelsDir: directory,
    readMetadata: async () => FAKE_INFO,
    logger: SILENT,
  });
  const found = await registry.scan();
  assert.ok(found.some((entry) => entry.fileName === "linked.gguf"));
});
