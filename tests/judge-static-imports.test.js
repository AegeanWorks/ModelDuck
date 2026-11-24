import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the judge imports its built-ins at module scope", async () => {
  const src = await readFile(new URL("../benchmarks/suite.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes('await import("node:child_process")'), "no per-call child_process import");
  assert.ok(!src.includes('await import("node:crypto")'), "no per-call crypto import");
  assert.match(src, /^import \{ execFile \} from "node:child_process";/m);
  assert.match(src, /^import \{ randomBytes \} from "node:crypto";/m);
});
