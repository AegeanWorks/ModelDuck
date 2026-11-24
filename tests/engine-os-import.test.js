import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("LlamaEngine.totalMemory uses the module-level os import", async () => {
  const src = await readFile(new URL("../src/engine.js", import.meta.url), "utf8");
  assert.ok(!src.includes('await import("node:os")'), "no per-call dynamic import of node:os");
  assert.match(src, /^import os from "node:os";/m, "node:os is imported at module scope");
});
