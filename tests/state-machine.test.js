import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_MACHINE,
  DOWNLOAD_MACHINE,
  ENGINE_MACHINE,
  MACHINES,
  machineCatalog,
  moveTo,
} from "../src/state-machine.js";

test("the machine catalog is JSON for people and agents", () => {
  const catalog = machineCatalog();
  assert.deepEqual(Object.keys(catalog), ["engine", "download", "benchmark"]);
  assert.equal(catalog.engine.initial, "idle");
  assert.deepEqual(catalog.download.states, ["queued", "downloading", "complete", "canceled", "error"]);
  assert.deepEqual(catalog.download.terminal, ["complete", "canceled", "error"]);
  assert.deepEqual(catalog.benchmark.transitions.running, ["complete", "cancelled", "failed"]);
  // The promise is plain JSON: an agent can persist or diff it.
  assert.equal(JSON.parse(JSON.stringify(catalog)).engine.states.length, 5);
});

test("terminal states never move again", () => {
  for (const machine of [DOWNLOAD_MACHINE, BENCHMARK_MACHINE]) {
    for (const terminal of machine.terminal) {
      assert.equal(machine.can(terminal, machine.initial), false, `${machine.name} left ${terminal}`);
      for (const state of machine.states) {
        assert.equal(machine.can(terminal, state), false, `${machine.name}: ${terminal} -> ${state}`);
      }
    }
  }
});

test("a download cannot complete after it was canceled", () => {
  assert.equal(DOWNLOAD_MACHINE.can("canceled", "complete"), false);
  assert.equal(DOWNLOAD_MACHINE.can("downloading", "complete"), true);
  const job = { status: "canceled" };
  assert.equal(moveTo(job, DOWNLOAD_MACHINE, "complete"), false);
  assert.equal(job.status, "canceled");
  assert.equal(moveTo(job, DOWNLOAD_MACHINE, "error"), false);
  assert.equal(job.status, "canceled");
});

test("an illegal transition throws with an actionable error", () => {
  assert.throws(
    () => ENGINE_MACHINE.assert("ready", "queued"),
    (error) => error.code === "invalid_state_transition" && /ready -> queued/.test(error.message),
  );
});

test("every documented engine phase can reach a resting state", () => {
  for (const state of ENGINE_MACHINE.states) {
    assert.ok(
      state === "idle" || ["idle", "unloading", "error"].some((next) => ENGINE_MACHINE.can(state, next)),
      `${state} has no way back to idle or error`,
    );
  }
  assert.equal(ENGINE_MACHINE.can("loading", "ready"), true);
  assert.equal(ENGINE_MACHINE.can("ready", "unloading"), true);
  assert.equal(ENGINE_MACHINE.can("unloading", "idle"), true);
  assert.deepEqual(Object.keys(MACHINES), ["engine", "download", "benchmark"]);
});
