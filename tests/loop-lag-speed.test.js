import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { measureLoopLag } from "../src/system.js";

test("one loop-lag probe does not wait for a full timer turn", async () => {
  const started = performance.now();
  for (let i = 0; i < 20; i += 1) await measureLoopLag();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 100, `${elapsed.toFixed(1)} ms for 20 probes; a setTimeout turn costs ~10ms each`);
});

test("the probe still reports an event loop blocked after it was scheduled", async () => {
  const probe = measureLoopLag();
  const until = Date.now() + 20;
  while (Date.now() < until) { /* deliberately block the loop */ }
  const lag = await probe;
  assert.ok(lag >= 10, `a 20 ms block should show up as lag, got ${lag.toFixed(2)} ms`);
});
