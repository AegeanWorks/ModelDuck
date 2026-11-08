import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import test from "node:test";

import { isLoopbackConnection, requiresApiAuth } from "../src/http.js";
import { ServerSettingsStore, restartRequiredFor } from "../src/server-settings.js";
import { makeHarness } from "./helpers.js";

function lanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal)?.address ?? null;
}

test("a restart is required only when the saved listener differs from the running one", () => {
  const running = { host: "127.0.0.1", port: 4141 };
  assert.equal(restartRequiredFor(running, { port: 4141, serveOnLocalNetwork: false }), false);
  assert.equal(restartRequiredFor(running, { port: 4142, serveOnLocalNetwork: false }), true);
  assert.equal(restartRequiredFor(running, { port: 4141, serveOnLocalNetwork: true }), true);
  assert.equal(restartRequiredFor({ host: "0.0.0.0", port: 4141 }, { port: 4141, serveOnLocalNetwork: true }), false);
  assert.equal(restartRequiredFor(null, { port: 4141 }), true, "without running info the safe answer is yes");
});

test("LAN auth covers /v1 and non-loopback /api routes", () => {
  const lan = { socket: { remoteAddress: "192.168.1.40" } };
  const local = { socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(isLoopbackConnection(local), true);
  assert.equal(isLoopbackConnection({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopbackConnection(lan), false);

  assert.equal(requiresApiAuth(local, { requireAuth: true, pathname: "/v1/models" }), true);
  assert.equal(requiresApiAuth(local, { requireAuth: true, pathname: "/api/state" }), false);
  assert.equal(requiresApiAuth(lan, { requireAuth: true, pathname: "/v1/models" }), true);
  assert.equal(requiresApiAuth(lan, { requireAuth: true, pathname: "/api/state" }), true);
  assert.equal(requiresApiAuth(lan, { requireAuth: false, pathname: "/api/state" }), false);
});

test("server settings clamp values and API keys verify once, then revoke", async (t) => {
  const harness = await makeHarness(t);
  const updated = await harness.serverSettings.update({
    port: 70000,
    maxIdleTtlMinutes: 0,
    requireAuth: true,
    enableCors: true,
  });
  assert.equal(updated.port, 65535);
  assert.equal(updated.maxIdleTtlMinutes, 1);
  assert.equal(updated.enableCors, true);

  const created = await harness.serverSettings.createKey("test client");
  assert.match(created.key, /^mdk_/);
  assert.equal(harness.serverSettings.verifyKey(created.key), true);
  assert.equal(harness.serverSettings.verifyKey("mdk_wrong"), false);
  assert.equal(harness.serverSettings.listKeys().length, 1);

  assert.equal(await harness.serverSettings.revokeKey(created.record.id), true);
  assert.equal(harness.serverSettings.verifyKey(created.key), false);
  assert.equal(harness.serverSettings.listKeys().length, 0);
});

test("server settings endpoints expose keys without hashes", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/server-settings`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(typeof data.settings.port, "number");
  assert.deepEqual(data.apiKeys, []);

  const created = await fetch(`${harness.base}/api/server-settings/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "laptop" }),
  }).then((item) => item.json());
  assert.match(created.key, /^mdk_/);
  assert.equal(created.record.label, "laptop");
  assert.equal(created.record.hash, undefined);

  const list = await fetch(`${harness.base}/api/server-settings`).then((item) => item.json());
  assert.equal(list.activeKeys, 1);
  assert.equal(list.apiKeys[0].hash, undefined);
});

test("require-auth protects /v1 while the local UI stays reachable", async (t) => {
  const harness = await makeHarness(t);
  await harness.serverSettings.update({ requireAuth: true });
  const created = await harness.serverSettings.createKey("client");

  const denied = await fetch(`${harness.base}/v1/models`);
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${harness.base}/v1/models`, {
    headers: { authorization: `Bearer ${created.key}` },
  });
  assert.equal(allowed.status, 200);

  const ui = await fetch(`${harness.base}/api/state`);
  assert.equal(ui.status, 200);

  const xKey = await fetch(`${harness.base}/v1/models`, {
    headers: { "x-api-key": created.key },
  });
  assert.equal(xKey.status, 200);
});

test("LAN auth blocks /api over a real non-loopback socket", async (t) => {
  const lan = lanAddress();
  if (!lan) {
    t.skip("no non-internal IPv4 address");
    return;
  }
  const harness = await makeHarness(t, { host: "0.0.0.0", baseHost: lan });
  await harness.serverSettings.update({ requireAuth: true, serveOnLocalNetwork: true });
  const created = await harness.serverSettings.createKey("lan client");

  let denied;
  try {
    denied = await fetch(`${harness.base}/api/state`);
  } catch {
    t.skip("LAN socket is unavailable (firewall or interface changed)");
    return;
  }
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${harness.base}/api/state`, {
    headers: { "x-api-key": created.key },
  });
  assert.equal(allowed.status, 200);

  const loopback = await fetch(`http://127.0.0.1:${harness.port}/api/state`);
  assert.equal(loopback.status, 200);

  const api = await fetch(`http://127.0.0.1:${harness.port}/v1/models`);
  assert.equal(api.status, 401);
  const keyedApi = await fetch(`http://127.0.0.1:${harness.port}/v1/models`, {
    headers: { authorization: `Bearer ${created.key}` },
  });
  assert.equal(keyedApi.status, 200);
});

test("CORS preflight is answered only when enabled", async (t) => {
  const harness = await makeHarness(t);
  const before = await fetch(`${harness.base}/v1/models`, {
    method: "OPTIONS",
  });
  assert.equal(before.status, 405);

  await harness.serverSettings.update({ requireAuth: true, enableCors: true });
  const after = await fetch(`${harness.base}/v1/models`, {
    method: "OPTIONS",
    // hygiene: allow inert external origin fixture for the CORS preflight test
    headers: { origin: "https://example.com" },
  });
  assert.equal(after.status, 204);
  assert.equal(after.headers.get("access-control-allow-origin"), "*");
});

// hygiene: allow inert hostile origin fixture for the cross-site request tests
const FOREIGN_ORIGIN = "https://evil.example";

test("a foreign web page cannot read settings or mint keys even with CORS and auth on", async (t) => {
  const harness = await makeHarness(t);
  await harness.serverSettings.update({ requireAuth: true, enableCors: true });

  const read = await fetch(`${harness.base}/api/server-settings`, { headers: { origin: FOREIGN_ORIGIN } });
  assert.equal(read.status, 403);
  assert.equal(read.headers.get("access-control-allow-origin"), null);

  const mint = await fetch(`${harness.base}/api/server-settings/api-keys`, {
    method: "POST",
    headers: { origin: FOREIGN_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ label: "stolen" }),
  });
  assert.equal(mint.status, 403);
  assert.equal(harness.serverSettings.activeKeys, 0);

  const preflight = await fetch(`${harness.base}/api/state`, {
    method: "OPTIONS",
    headers: { origin: FOREIGN_ORIGIN },
  });
  assert.equal(preflight.status, 403);
});

test("LAN mode refuses cross-site simple requests but keeps the same-origin UI", async (t) => {
  const harness = await makeHarness(t);
  await harness.serverSettings.update({ requireAuth: true, serveOnLocalNetwork: true });

  const planted = await fetch(`${harness.base}/api/state`, { headers: { origin: FOREIGN_ORIGIN } });
  assert.equal(planted.status, 403);

  const sameOrigin = await fetch(`${harness.base}/api/state`, { headers: { origin: harness.base } });
  assert.equal(sameOrigin.status, 200);

  const v1 = await fetch(`${harness.base}/v1/models`, { headers: { origin: FOREIGN_ORIGIN } });
  assert.equal(v1.status, 403, "without CORS a foreign page cannot reach /v1 either");
});

test("CORS opens only /v1 to foreign pages, and still needs the key there", async (t) => {
  const harness = await makeHarness(t);
  await harness.serverSettings.update({ requireAuth: true, enableCors: true });
  const created = await harness.serverSettings.createKey("web client");

  const denied = await fetch(`${harness.base}/v1/models`, { headers: { origin: FOREIGN_ORIGIN } });
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${harness.base}/v1/models`, {
    headers: { origin: FOREIGN_ORIGIN, authorization: `Bearer ${created.key}` },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "*");

  const ui = await fetch(`${harness.base}/api/state`);
  assert.equal(ui.status, 200);
  assert.equal(ui.headers.get("access-control-allow-origin"), null);
});

test("a DNS-rebound page on this computer is refused with LAN or CORS on", async (t) => {
  const harness = await makeHarness(t);
  for (const exposure of [{ serveOnLocalNetwork: true }, { enableCors: true }]) {
    await harness.serverSettings.update({ requireAuth: true, ...exposure });
    const rebound = await new Promise((resolve, reject) => {
      // hygiene: allow inert rebinding host fixture; the socket itself is loopback
      const req = http.request(
        { host: "127.0.0.1", port: harness.port, path: "/api/server-settings", headers: { host: `rebind.example:${harness.port}` } },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebound, 403, JSON.stringify(exposure));
    await harness.serverSettings.update({ serveOnLocalNetwork: false, enableCors: false });
  }
});

test("LAN or CORS cannot be saved while authentication is off", async (t) => {
  const harness = await makeHarness(t);
  for (const exposure of [{ serveOnLocalNetwork: true }, { enableCors: true }]) {
    await assert.rejects(
      () => harness.serverSettings.update(exposure),
      (error) => error.code === "auth_required_for_exposure" && error.status === 400 && Boolean(error.fix),
    );
  }
  const response = await fetch(`${harness.base}/api/server-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { serveOnLocalNetwork: true, requireAuth: false } }),
  });
  assert.equal(response.status, 400);
  assert.equal(harness.serverSettings.value.serveOnLocalNetwork, false);

  const off = await harness.serverSettings.update({ requireAuth: true, enableCors: true });
  assert.equal(off.enableCors, true);
  await assert.rejects(
    () => harness.serverSettings.update({ requireAuth: false }),
    (error) => error.code === "auth_required_for_exposure",
  );
});

test("saved LAN or CORS without authentication is switched off on load", async (t) => {
  const harness = await makeHarness(t);
  await writeFile(
    harness.paths.serverSettings,
    JSON.stringify({ version: 1, settings: { serveOnLocalNetwork: true, enableCors: true, requireAuth: false }, apiKeys: [] }),
  );
  const warnings = [];
  const store = new ServerSettingsStore({
    file: harness.paths.serverSettings,
    logger: { warn: (message) => warnings.push(message), error() {}, info() {} },
  });
  const loaded = await store.load();
  assert.equal(loaded.serveOnLocalNetwork, false);
  assert.equal(loaded.enableCors, false);
  assert.equal(warnings.length, 1);
  const saved = JSON.parse(await readFile(harness.paths.serverSettings, "utf8"));
  assert.equal(saved.settings.serveOnLocalNetwork, false);
  assert.equal(saved.settings.enableCors, false);
});

test("just-in-time loading loads the requested model before answering", async (t) => {
  const harness = await makeHarness(t);
  await harness.engine.unload();
  await harness.serverSettings.update({ justInTimeModelLoading: true });

  const response = await fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "test-model-0.gguf",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].message.content, "Quack!");
  assert.equal(harness.engine.state.model.id, harness.modelId);
  harness.jit.dispose();
});

test("from another machine, even with a key, tunes cannot be cancelled and tune steps cannot be rewritten", async (t) => {
  const lan = lanAddress();
  if (!lan) {
    t.skip("no non-internal IPv4 address");
    return;
  }
  const tunes = { get: () => ({ status: "running", items: [] }), cancel: () => ({ status: "cancelled" }), start: () => ({}) };
  const harness = await makeHarness(t, { host: "0.0.0.0", baseHost: lan, tunes });
  await harness.serverSettings.update({ requireAuth: true, serveOnLocalNetwork: true });
  const { key } = await harness.serverSettings.createKey("lan client");
  const call = (method, route) => fetch(`${harness.base}${route}`, { method, headers: { "x-api-key": key, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
  let read;
  try {
    read = await call("GET", "/api/tune/steps");
  } catch {
    t.skip("LAN socket is unavailable (firewall or interface changed)");
    return;
  }
  assert.equal(read.status, 200, "reading is fine");
  const cancel = await call("POST", "/api/tune/cancel");
  assert.equal(cancel.status, 403);
  assert.equal((await cancel.json()).error.code, "tune_local_only");
  const write = await call("PUT", "/api/tune/steps");
  assert.equal(write.status, 403);
});
