import assert from "node:assert/strict";
import test from "node:test";

import { detectLoop } from "../src/generation-manifest.js";
import { measureLoopLag, systemInfo } from "../src/system.js";
import { makeHarness } from "./helpers.js";

// IDEA-1164: a thrice-repeated tail unit is a loop; prose is not.
test("detectLoop flags degenerate tails only", () => {
  const unit = "the quick brown fox jumps. ";
  assert.equal(detectLoop("Some honest prose with no repeats at all.").loop, false);
  assert.equal(detectLoop(`Intro. ${unit.repeat(3)}`).loop, true);
  assert.equal(detectLoop(`Intro. ${unit.repeat(2)}`).loop, false);
  assert.equal(detectLoop("abcdefghij klmnopqrst uvwxyz 0123456789 !@#$%^&*()").loop, false);
});

// IDEA-1198: the health receipt answers with host facts and a loop lag.
test("health receipt reports the host and what is loaded", async (t) => {
  const harness = await makeHarness(t);
  assert.ok(typeof systemInfo().uptime === "number");
  assert.ok((await measureLoopLag()) >= 0);
  const response = await fetch(`${harness.base}/api/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.app, "ModelDuck");
  assert.ok(typeof payload.loopLagMs === "number");
  assert.ok("loadedId" in payload);
  // AX: the state vocabulary and JIT/registry states are readable from health.
  assert.equal(payload.phase, "ready");
  assert.deepEqual(payload.jit, { trackedId: null, armed: false });
  assert.equal(payload.registry.size, 1);
  assert.ok(Number.isInteger(payload.registry.hits) && Number.isInteger(payload.registry.misses));
  assert.deepEqual(payload.machines.download.terminal, ["complete", "canceled", "error"]);
  assert.deepEqual(payload.machines.benchmark.states, ["running", "complete", "cancelled", "failed"]);
});
