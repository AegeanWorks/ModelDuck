import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { FakeEngine, makeHarness } from "./helpers.js";

function lanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal)?.address ?? null;
}

test("from another machine with a key, state-changing routes are refused while reads and chat still work", async (t) => {
  const lan = lanAddress();
  if (!lan) {
    t.skip("no non-internal IPv4 address");
    return;
  }
  const harness = await makeHarness(t, { host: "0.0.0.0", baseHost: lan });
  await harness.serverSettings.update({ requireAuth: true, serveOnLocalNetwork: true });
  const { key } = await harness.serverSettings.createKey("lan client");
  const call = (method, route, body) =>
    fetch(`${harness.base}${route}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let read;
  try {
    read = await call("GET", "/api/settings");
  } catch {
    t.skip("LAN socket is unavailable (firewall or interface changed)");
    return;
  }
  assert.equal(read.status, 200, "reading settings stays available");
  const before = await read.json();

  const mutations = [
    ["PUT", "/api/settings", { settings: { temperature: 1.5 } }],
    ["POST", "/api/models/import", { path: "anything.gguf" }],
    ["POST", "/api/models/open-folder", {}],
    ["POST", "/api/models/unload", {}],
    ["POST", `/api/models/${harness.modelId}/load`, {}],
    ["DELETE", `/api/models/${harness.modelId}`, undefined],
    ["POST", "/api/downloads", { catalogId: "anything" }],
    ["DELETE", "/api/downloads/missing", undefined],
  ];
  for (const [method, route, body] of mutations) {
    const response = await call(method, route, body);
    assert.equal(response.status, 403, `${method} ${route}`);
    const data = await response.json();
    assert.match(data.error.code, /_local_only$/, `${method} ${route} names the local-only rule`);
  }

  const after = await fetch(`http://127.0.0.1:${harness.port}/api/settings`).then((item) => item.json());
  assert.equal(after.settings.temperature, before.settings.temperature, "a remote PUT changed nothing");
});

test("unload refuses while a model is loading or answering, then succeeds", async (t) => {
  const engine = new FakeEngine();
  engine.status = async () => ({ ...engine.state, status: "loading", memory: { cpuRam: 1, gpuVram: 0 } });
  const harness = await makeHarness(t, { engine });

  let response = await fetch(`${harness.base}/api/models/unload`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "model_busy");

  engine.status = async () => ({ ...engine.state, memory: { cpuRam: 1, gpuVram: 0 } });
  engine.activeIds.add("streaming-reply");
  response = await fetch(`${harness.base}/api/models/unload`, { method: "POST" });
  assert.equal(response.status, 409, "a reply in flight also blocks unload");

  engine.activeIds.clear();
  response = await fetch(`${harness.base}/api/models/unload`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).loaded.status, "idle");
});

test("a benchmark tune run forwards settings and refuses unknown work before starting", async (t) => {
  const calls = [];
  const benchmarks = {
    get: () => null,
    start: (options) => {
      calls.push(options);
      return { id: "job", status: "running", ...options };
    },
  };
  const harness = await makeHarness(t, { benchmarks });
  const post = (body) =>
    fetch(`${harness.base}/api/benchmarks/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  let response = await post({ phase: "tune", model: harness.modelId, settings: ["threads"], stages: ["speed"] });
  assert.equal(response.status, 202);
  assert.deepEqual(calls.at(-1).settings, ["threads"]);
  assert.equal(calls.at(-1).model, harness.modelId);

  response = await post({ phase: "tune", model: harness.modelId, settings: ["warpDrive"] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "unknown_setting");

  response = await post({ phase: "tune", model: "not-installed" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "model_not_found");

  response = await post({ phase: "model", settings: ["threads"] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_benchmark_selection");
  assert.equal(calls.length, 1, "only the valid run started");
});

test("tune start accepts one model id as a string", async (t) => {
  const calls = [];
  const tunes = {
    get: () => null,
    start: (options) => {
      calls.push(options);
      return { status: "running", order: [] };
    },
  };
  const harness = await makeHarness(t, { tunes });
  const response = await fetch(`${harness.base}/api/tune/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ models: harness.modelId }),
  });
  assert.equal(response.status, 202);
  assert.equal(calls.at(-1).models.length, 1);
  assert.equal(calls.at(-1).models[0].id, harness.modelId);
});
