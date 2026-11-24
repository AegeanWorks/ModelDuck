import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry, hashIdComputations, resetHashIdCache } from "../src/model-registry.js";

const reference = (p) => createHash("sha1").update(p.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 12);
const INFO = { metadata: { general: { architecture: "llama", name: "M" } }, architectureMetadata: { context_length: 8192 }, tensorInfo: [] };

test("model ids stay stable and are hashed once per path", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-hashid-memo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "sub"), { recursive: true });
  for (const name of ["a.gguf", "sub/b.gguf", "sub/c.gguf"]) {
    await writeFile(path.join(dir, name), Buffer.from("GGUF12345678"));
  }
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });
  resetHashIdCache();
  const first = await registry.scan({ force: true });
  const before = hashIdComputations();
  const second = await registry.scan({ force: true });
  assert.deepEqual(second, first, "repeat scans return the same models");
  assert.equal(hashIdComputations(), before, "unchanged paths are not re-hashed");
  const byName = new Map(first.map((model) => [model.fileName, model.id]));
  assert.equal(byName.get("a.gguf"), reference("a.gguf"));
  assert.equal(byName.get("b.gguf"), reference("sub/b.gguf"));
  assert.equal(byName.get("c.gguf"), reference("sub/c.gguf"));
});
