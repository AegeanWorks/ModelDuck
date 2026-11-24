import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelRegistry } from "../src/model-registry.js";

const INFO = {
  metadata: { general: { architecture: "llama", name: "Meta Duck" } },
  architectureMetadata: { context_length: 8192 },
  tensorInfo: [],
};

test("model discovery reads sibling directories concurrently", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "md-walkpar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 6; i += 1) {
    const sub = path.join(dir, `d${i}`);
    await mkdir(sub);
    await writeFile(path.join(sub, `m${i}.gguf`), Buffer.from("GGUF12345678"));
  }
  const registry = createModelRegistry({ modelsDir: dir, readMetadata: async () => INFO, logger: { warn() {} } });

  const real = fs.promises.readdir;
  let inFlight = 0;
  let maxInFlight = 0;
  fs.promises.readdir = async (...args) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await real(...args);
    } finally {
      inFlight -= 1;
    }
  };
  t.after(() => { fs.promises.readdir = real; });

  const models = await registry.scan({ force: true });
  assert.equal(models.length, 6, "every nested model is found");
  assert.ok(maxInFlight > 1, `sibling directories were read concurrently (max ${maxInFlight})`);
});
