import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { LlamaServerBackend } from "../src/external-engines.js";

const ENTRY = { id: "m1", name: "Tiny", fileName: "tiny.gguf", path: "C:\\models\\tiny.gguf" };
const LOAD = { contextSize: 4096, threads: 4, batchSize: 256, sequences: 1, gpuBackend: "cpu" };

/** A child that fails to spawn and whose kill() never produces an exit event. */
function missingBinary() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  setImmediate(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
  return child;
}

test("a failed spawn refuses immediately instead of waiting for the exit timeout", async () => {
  const backend = new LlamaServerBackend({ binary: "missing.exe", spawnImpl: missingBinary, startTimeoutMs: 5000 });
  const started = performance.now();
  await assert.rejects(() => backend.start({ entry: ENTRY, load: LOAD }),
    (error) => error.code === "engine_start_failed" && /ENOENT/.test(error.why));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `${elapsed.toFixed(0)} ms; a missing binary should refuse at once, not after the 5 s exit wait`);
});
