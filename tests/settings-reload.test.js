import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettings } from "../src/config.js";
import { buildGenerationManifest } from "../src/generation-manifest.js";
import { EngineRebuildLease, reloadFingerprint } from "../src/settings-reload.js";
import { FakeEngine, makeHarness } from "./helpers.js";

// IDEA-1098: the release-barriered engine rebuild lease settings contract.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  await sleep(40);
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
  await sleep(25);
  assert.equal(engine.unloadCalls, 1); // rescheduled once the slot freed
  assert.equal(engine.loadCalls.length, 1);
  lease.dispose();
});

test("a newer fingerprint wins: only the newest settings become visible", async () => {
  const engine = makeRebuildEngine({ fingerprint: "stale" });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 10 });
  lease.update(reloadSettings({ contextSize: 16384, autoReloadOnSettingsChange: true }));
  lease.update(reloadSettings({ contextSize: 8192, autoReloadOnSettingsChange: true }));
  await sleep(60);
  assert.equal(engine.loadCalls.length, 1);
  assert.equal(engine.loadCalls[0].contextSize, 8192); // surge coalesced to the newest ask
  lease.dispose();
});

test("a hung teardown is bounded and surfaces MODEL_DISPOSE_FAILED", async () => {
  const engine = makeRebuildEngine({
    fingerprint: "stale",
    unloadImpl: () => sleep(5000),
  });
  const lease = new EngineRebuildLease({ engine, logger: null, delayMs: 2, disposeTimeoutMs: 15 });
  lease.update(reloadSettings({ autoReloadOnSettingsChange: true }));
  await sleep(60);
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
