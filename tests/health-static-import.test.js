import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("/api/health uses the already-loaded system module", async () => {
  const src = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.ok(!src.includes('await import("./system.js")'), "no per-request dynamic import");
  assert.match(src, /import \{[^}]*measureLoopLag[^}]*\} from "\.\/system\.js"/, "loaded alongside systemInfo");
});
