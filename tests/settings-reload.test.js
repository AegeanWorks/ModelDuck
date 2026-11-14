import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettings } from "../src/config.js";
import { buildGenerationManifest } from "../src/generation-manifest.js";
import { EngineRebuildLease, reloadFingerprint } from "../src/settings-reload.js";
import { FakeEngine, makeHarness } from "./helpers.js";

// IDEA-1098: the release-barriered engine rebuild lease settings contract.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A teardown that never finishes, without a timer that would hold the process open.
const hang = () => new Promise(() => {});
// Fixed sleeps flake when the machine is loaded: poll for the state instead.
async function waitFor(condition, timeoutMs = 2000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

function makeRebuildEngine({
  fingerprint = null,
  busy = false,
  loadImpl = null,
  unloadImpl = null,
} = {}) {
  const engine = {
    loadedId: "model-a",
    busy,
    currentFingerprint: fingerprint,
    reloadFingerprint() {
      return this.currentFingerprint;
    },
    loadCalls: [],
    unloadCalls: 0,
    async load(args) {
      this.loadCalls.push(args);
      if (loadImpl) await loadImpl.call(this, args);
      this.currentFingerprint = reloadFingerprint(args);
      return { status: "ready" };
    },
    async unload() {
      this.unloadCalls += 1;
      if (unloadImpl) await unloadImpl.call(this);
      this.currentFingerprint = null;
    },
  };
  return engine;
}

function reloadSettings(overrides = {}) {
  return {
    ...normalizeSettings({}),
    contextSize: 16384,
    ...overrides,
  };
}

test("reloadFingerprint covers reload-affecting settings only", () => {
  const base = reloadSettings();
  const first = reloadFingerprint(base);
  assert.equal(reloadFingerprint(reloadSettings()), first); // deterministic
  assert.equal(
    reloadFingerprint(reloadSettings({ temperature: 0.9 })), // sampling does not reload
    first,
  );
  assert.notEqual(
    reloadFingerprint(reloadSettings({ threads: 3 })), // load inputs do reload
    first,
  );
  assert.notEqual(reloadFingerprint(reloadSettings({ threads: 7 })), first);
});

test("autoReloadOnSettingsChange defaults off and is boolean-normalized", () => {
  assert.equal(normalizeSettings({}).autoReloadOnSettingsChange, false);
  assert.equal(normalizeSettings({ autoReloadOnSettingsChange: true }).autoReloadOnSettingsChange, true);
});

test("the lease reports reload-needed and never schedules while autoReload is off", async () => {
  const engine = makeRebuildEngine({ fingerprint: "pretend" });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 5 });
  const verdict = lease.update(reloadSettings({ contextSize: 16384 }));
  assert.equal(verdict.required, true); // engine fingerprint differs from settings
  assert.equal(verdict.scheduled, false); // off: the user reloads by hand
  await sleep(25);
  assert.equal(engine.loadCalls.length, 0);
  assert.equal(engine.unloadCalls, 0);
});

test("the lease reloads on a debounce when autoReload is on", async () => {
  const engine = makeRebuildEngine({ fingerprint: "stale" });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 5 });
  const verdict = lease.update(reloadSettings({ contextSize: 16384, autoReloadOnSettingsChange: true }));
  assert.equal(verdict.required, true);
  assert.equal(verdict.scheduled, true);
  assert.ok(await waitFor(() => engine.loadCalls.length === 1 && !lease.pending), "the debounced rebuild ran");
  assert.equal(engine.unloadCalls, 1);
  assert.equal(engine.loadCalls.length, 1);
  assert.equal(engine.loadCalls[0].modelId, "model-a");
  assert.equal(engine.loadCalls[0].contextSize, 16384);
  assert.equal(lease.lastError, null); // clean rebuild clears the error slot
  assert.equal(lease.pending, false);
});

test("the lease defers while the engine is busy instead of aborting a generation", async () => {
  const engine = makeRebuildEngine({ fingerprint: "stale", busy: true });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 5 });
  lease.update(reloadSettings({ autoReloadOnSettingsChange: true }));
  await sleep(25);
  assert.equal(engine.unloadCalls, 0); // defer: still busy
  engine.busy = false;
  assert.ok(await waitFor(() => engine.unloadCalls === 1 && engine.loadCalls.length === 1), "rescheduled once the slot freed");
  assert.equal(engine.unloadCalls, 1); // rescheduled once the slot freed
  assert.equal(engine.loadCalls.length, 1);
  lease.dispose();
});

test("a newer fingerprint wins: only the newest settings become visible", async () => {
  const engine = makeRebuildEngine({ fingerprint: "stale" });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 10 });
  lease.update(reloadSettings({ contextSize: 16384, autoReloadOnSettingsChange: true }));
  lease.update(reloadSettings({ contextSize: 8192, autoReloadOnSettingsChange: true }));
  assert.ok(await waitFor(() => engine.loadCalls.length >= 1 && !lease.pending), "the rebuild ran");
  assert.equal(engine.loadCalls.length, 1);
  assert.equal(engine.loadCalls[0].contextSize, 8192); // surge coalesced to the newest ask
  lease.dispose();
});

test("a hung teardown is bounded and surfaces MODEL_DISPOSE_FAILED", async () => {
  const engine = makeRebuildEngine({
    fingerprint: "stale",
    unloadImpl: hang,
  });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 2, disposeTimeoutMs: 15 });
  lease.update(reloadSettings({ autoReloadOnSettingsChange: true }));
  assert.ok(await waitFor(() => lease.lastError?.code === "MODEL_DISPOSE_FAILED"), "the bounded teardown reported its failure");
  assert.equal(engine.loadCalls.length, 0); // never loads onto an undisposed engine
  assert.equal(lease.lastError.code, "MODEL_DISPOSE_FAILED");
  assert.equal(lease.pending, false);
});

test("the settings API returns the fingerprint and the reload verdict", async (t) => {
  class ReloadAwareEngine extends FakeEngine {
    get reloadFingerprint() {
      return "0000000000000000";
    }
  }
  const harness = await makeHarness(t, { engine: new ReloadAwareEngine() });
  const read = await fetch(`${harness.base}/api/settings`);
  assert.equal(read.status, 200);
  const current = await read.json();
  assert.equal(typeof current.settingsFingerprint, "string");
  assert.equal(current.settingsFingerprint.length, 16);

  const write = await fetch(`${harness.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { contextSize: current.settings.contextSize === 16384 ? 32768 : 16384 } }),
  });
  assert.equal(write.status, 200);
  const updated = await write.json();
  assert.equal(updated.reload.required, true); // the engine's fingerprint no longer matches
  assert.equal(updated.reload.scheduled, false); // autoReload is off by default
  assert.equal(updated.reload.fingerprint.length, 16);
});

test("lease.status() snapshots the deferred rebuild without mutating it", async () => {
  const engine = makeRebuildEngine({ fingerprint: "stale" });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 5 });
  assert.deepEqual(lease.status(), {
    pending: false,
    pendingFingerprint: null,
    phase: "load",
    running: false,
    lastError: null,
  });
  const asked = reloadSettings({ contextSize: 8192, autoReloadOnSettingsChange: true });
  lease.update(asked);
  const scheduled = lease.status();
  assert.equal(scheduled.pending, true);
  assert.equal(scheduled.pendingFingerprint, reloadFingerprint(asked)); // which settings the rebuild will apply
  assert.ok(await waitFor(() => engine.loadCalls.length === 1 && !lease.status().pending && !lease.status().running), "the rebuild settled");
  const settled = lease.status();
  assert.equal(settled.pending, false);
  assert.equal(settled.running, false);
  assert.equal(settled.lastError, null);
  lease.dispose();
});

test("lease.status() keeps the failure code after a bounded teardown", async () => {
  const engine = makeRebuildEngine({ fingerprint: "stale", unloadImpl: hang });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 2, disposeTimeoutMs: 15 });
  lease.update(reloadSettings({ autoReloadOnSettingsChange: true }));
  assert.ok(await waitFor(() => Boolean(lease.status().lastError)), "the failure was recorded");
  const failed = lease.status();
  assert.equal(failed.pending, false);
  assert.equal(failed.lastError.code, "MODEL_DISPOSE_FAILED");
});

test("GET /api/settings reports the lease state and its background failures", async (t) => {
  class FingerprintedEngine extends FakeEngine {
    get reloadFingerprint() {
      return "0000000000000000";
    }
  }
  const idle = await makeHarness(t, { engine: new FingerprintedEngine() });
  const before = await (await fetch(`${idle.base}/api/settings`)).json();
  assert.equal(before.reload.pending, false);
  assert.equal(before.reload.pendingFingerprint, null);
  assert.equal(before.reload.lastError, null);

  class HungDisposeEngine extends FingerprintedEngine {
    async unload() {
      return hang();
    }
  }
  const hung = new HungDisposeEngine();
  const lease = new EngineRebuildLease({ engine: hung, logger: null, delayMs: 2, disposeTimeoutMs: 15 });
  const failing = await makeHarness(t, { engine: hung, reloadLease: lease });
  const write = await fetch(`${failing.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { autoReloadOnSettingsChange: true } }),
  });
  assert.equal(write.status, 200);
  let after = null;
  const reported = await waitFor(async () => {
    after = await (await fetch(`${failing.base}/api/settings`)).json();
    return Boolean(after.reload.lastError);
  });
  assert.ok(reported, "the background failure reached the API");
  assert.equal(after.reload.pending, false);
  assert.equal(after.reload.lastError.code, "MODEL_DISPOSE_FAILED");
  lease.dispose();
});

test("generation manifests attest the reload fingerprint", () => {
  const manifest = buildGenerationManifest({
    model: { id: "m" },
    originalSystemPrompt: "",
    effectiveSystemPrompt: "",
    messages: [],
    history: [],
    promptText: "hello",
    settings: {},
    runtimeVersion: "test",
    allocation: {
      allocatedContext: 16384,
      requestedContext: 16384,
      backend: "cpu",
      gpuLayers: 0,
      fallback: null,
      reloadFingerprint: "0123456789abcdef",
    },
  });
  assert.equal(manifest.allocation.reloadFingerprint, "0123456789abcdef");
});
