import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeEngine, makeHarness } from "./helpers.js";
import { AppError } from "../src/errors.js";
import { currentFingerprint, profileFromTune, profileIdFor, saveProfile } from "../src/model-profiles.js";
import { startRun } from "../src/tune-runs.js";

function parseSse(text) {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      return { event, data: data ? JSON.parse(data) : null };
    });
}

function rawStatus(port, path, headers, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("state exposes models, settings and the local app info", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/state`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.app.app, "ModelDuck");
  assert.equal(data.models.length, 1);
  assert.equal(data.modelsDir, harness.paths.models);
  assert.equal(data.loaded.status, "ready");
  assert.equal(data.settings.contextSize, 16384);
});

test("benchmark report exposes both phases and per-test percentages", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-bench-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const phase = (name, hash) => ({
    phase: name,
    suiteVersion: 4,
    testHash: hash,
    createdAt: "2026-10-30T00:00:00.000Z",
    runtimeMs: 1000,
    overall: {
      score: 80,
      tokensPerSecond: 50,
      firstTokenMs: 100,
      checksPassed: 4,
      checksTotal: 5,
    },
    tests: [
      { id: "exact-word", label: "Exact word", category: "instruction", passed: 4, total: 5, percent: 80 },
    ],
  });
  await writeFile(path.join(directory, "baseline-model.json"), JSON.stringify(phase("model", "a".repeat(16))));
  await writeFile(path.join(directory, "baseline-chat.json"), JSON.stringify(phase("chat", "b".repeat(16))));
  await writeFile(
    path.join(directory, "history.jsonl"),
    `${JSON.stringify({
      type: "run",
      uid: "run-model",
      recordedAt: "2026-10-30T00:00:00.000Z",
      baseline: true,
      git: {},
      result: phase("model", "a".repeat(16)),
    })}\n` +
      `${JSON.stringify({
        type: "link",
        runUid: "run-model",
        commit: { hash: "abcdef1234", subject: "fixture commit" },
      })}\n`,
  );

  const harness = await makeHarness(t, { benchmarkDir: directory });
  const response = await fetch(`${harness.base}/api/benchmarks`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.available, true);
  assert.equal(data.phases.length, 2);
  const model = data.phases.find((item) => item.phase === "model");
  assert.equal(model.testHash, "a".repeat(16));
  assert.equal(model.tests[0].percent, 80);
  assert.equal(model.runtimeMs, 1000);
  assert.equal(model.commit.hash, "abcdef1");
  assert.equal(data.history[0].commit.subject, "fixture commit");
});

test("benchmark routes start, report and cancel one local run", async (t) => {
  let job = null;
  const starts = [];
  const benchmarks = {
    start(options) {
      if (job?.status === "running") {
        throw new AppError("A benchmark is already running", {
          code: "benchmark_in_progress",
          status: 409,
        });
      }
      starts.push(options);
      job = { id: "job-1", phase: options.phase, status: "running", progress: null };
      return job;
    },
    get() {
      return job;
    },
    cancel() {
      if (job?.status !== "running") {
        throw new AppError("No benchmark is running", { code: "benchmark_not_running", status: 409 });
      }
      job = { ...job, status: "cancelled" };
      return job;
    },
  };
  const harness = await makeHarness(t, { benchmarks });
  const post = (route, body) =>
    fetch(`${harness.base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });

  const empty = await fetch(`${harness.base}/api/benchmarks/status`);
  assert.deepEqual(await empty.json(), { job: null });

  const started = await post("/api/benchmarks/run", { phase: "chat", updateBaseline: true });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).job.phase, "chat");
  assert.deepEqual(starts[0], { phase: "chat", updateBaseline: true, download: false, fullMatrix: false, model: null, tasks: null, force: false, stages: null, settings: null });

  const second = await post("/api/benchmarks/run", { phase: "model" });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, "benchmark_in_progress");

  const status = await fetch(`${harness.base}/api/benchmarks/status`);
  assert.equal((await status.json()).job.status, "running");

  const cancelled = await post("/api/benchmarks/cancel");
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).job.status, "cancelled");

  const scoped = await post("/api/benchmarks/run", { phase: "model", stages: ["quality"] });
  assert.equal(scoped.status, 400);
  assert.equal((await scoped.json()).error.code, "invalid_benchmark_selection");
  const emptyScope = await post("/api/benchmarks/run", { phase: "model", tasks: [] });
  assert.equal(emptyScope.status, 202);
  assert.equal(starts.at(-1).tasks, null, "an empty task list means the whole matrix");
  assert.equal((await (await post("/api/benchmarks/cancel")).json()).job.status, "cancelled");

  harness.engine.activeIds.add("busy-conversation");
  const busy = await post("/api/benchmarks/run", { phase: "model" });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, "generation_in_progress");
  harness.engine.activeIds.delete("busy-conversation");
});

test("the chat base route saves a measured model variant for a later run", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-chat-base-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "results"), { recursive: true });
  await writeFile(
    path.join(directory, "results", "latest-model.json"),
    `${JSON.stringify({
      phase: "model",
      models: [
        {
          key: "qwen2.5-coder-1.5b-instruct", // aikit:allow-secret model name
          variantId: "coder-f16",
          label: "Coder Q4",
          fileName: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
          catalogId: "qwen2.5-coder-1.5b-instruct-q4",
          kvCache: "f16",
          requestedContextSize: 4096,
          threads: 8,
          batchSize: 512,
          checkpoints: true,
          items: { passed: 70, total: 91, rate: 76.9 },
        },
      ],
    })}\n`,
  );
  const benchmarks = { get: () => null, start() {}, cancel() {} };
  const harness = await makeHarness(t, { benchmarkDir: directory, benchmarks });
  const response = await fetch(`${harness.base}/api/benchmarks/base`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variantId: "coder-f16" }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.chatBase.variantId, "coder-f16");
  assert.equal(data.chatBase.settings.contextSize, 4096);
  const saved = JSON.parse(await readFile(path.join(directory, "chat-base.json"), "utf8"));
  assert.equal(saved.catalogId, "qwen2.5-coder-1.5b-instruct-q4");

  const report = await (await fetch(`${harness.base}/api/benchmarks`)).json();
  assert.equal(report.chatBase.variantId, "coder-f16");

  const missing = await fetch(`${harness.base}/api/benchmarks/base`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ variantId: "missing" }),
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "chat_base_variant_missing");
});

test("the GPU endpoint reports detected backend types", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/gpu`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.backends));
  assert.equal(data.rocm, false);
  assert.match(data.note, /Vulkan/);
});

test("the app shell is served with security headers", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await response.text(), /<title>ModelDuck/);
});

test("requests with a non-loopback Host are refused", async (t) => {
  const harness = await makeHarness(t);
  assert.equal(await rawStatus(harness.port, "/api/state", { host: "attacker.example" }), 403);
  assert.equal(await rawStatus(harness.port, "/api/state", { host: "localhost" }), 200);
  const headers = { host: "attacker.example", "content-type": "application/json" };
  assert.equal(await rawStatus(harness.port, "/api/server-settings", headers, "PUT", "{}"), 403);
  assert.equal(await rawStatus(harness.port, "/api/server-settings/api-keys", headers, "POST", JSON.stringify({ label: "remote" })), 403);
  assert.equal(await rawStatus(harness.port, "/api/server-settings/api-keys/missing", headers, "DELETE"), 403);
});

test("settings updates are validated and persisted", async (t) => {
  const harness = await makeHarness(t);
  const seed = await fetch(`${harness.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { speedPreset: "quiet", systemPrompt: "keep me" } }),
  });
  assert.equal(seed.status, 200);
  const response = await fetch(`${harness.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { temperature: 9, contextSize: 1, warpDrive: 1 } }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.settings.temperature, 2);
  assert.equal(data.settings.contextSize, 16384, "the 16K floor is enforced");
  assert.equal(data.settings.warpDrive, undefined);

  const persisted = await fetch(`${harness.base}/api/settings`).then((item) => item.json());
  assert.equal(persisted.settings.temperature, 2);
  assert.equal(persisted.settings.speedPreset, "quiet");
  assert.equal(persisted.settings.systemPrompt, "keep me");
  assert.equal(persisted.settings.warpDrive, undefined);
});

test("model load and unload routes use the engine", async (t) => {
  const harness = await makeHarness(t);
  const loaded = await fetch(`${harness.base}/api/models/${harness.modelId}/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contextSize: 2048, threads: 4 }),
  }).then((response) => response.json());
  assert.equal(loaded.loaded.status, "ready");
  assert.equal(loaded.loaded.model.id, harness.modelId);

  const unloaded = await fetch(`${harness.base}/api/models/unload`, { method: "POST" }).then(
    (response) => response.json(),
  );
  assert.equal(unloaded.loaded.status, "idle");
});

test("OpenAI model list and lookup expose one model", async (t) => {
  const harness = await makeHarness(t);
  const listResponse = await fetch(`${harness.base}/v1/models`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.object, "list");
  assert.equal(list.data.length, 1);
  const listed = list.data[0];
  assert.equal(listed.object, "model");
  assert.equal(listed.name, "Test Duck 1B");
  assert.equal(typeof listed.chat_template_hash, "string");

  const one = await fetch(`${harness.base}/v1/models/${encodeURIComponent(listed.id)}`).then((response) => response.json());
  assert.equal(one.id, listed.id);
  assert.equal(one.quant, "GGUF");
  assert.equal(one.context_length, 4096);

  const byFile = await fetch(
    `${harness.base}/v1/models/${encodeURIComponent("test-model-0.gguf")}`,
  ).then((response) => response.json());
  assert.equal(byFile.id, listed.id);

  const missing = await fetch(`${harness.base}/v1/models/does-not-exist`);
  assert.equal(missing.status, 404);
});

test("OpenAI chat completions works in normal and streaming modes", async (t) => {
  const harness = await makeHarness(t);
  const normalResponse = await fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fake-model",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 8,
    }),
  });
  assert.equal(normalResponse.status, 200);
  const normal = await normalResponse.json();
  assert.equal(normal.choices[0].message.content, "Quack!");
  assert.equal(normal.usage.total_tokens, 5);
  assert.equal(normal.system_fingerprint, "a".repeat(16));

  const streamResponse = await fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fake-model",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /"content":"Quack"/);
  assert.match(streamText, new RegExp(`"system_fingerprint":"${"a".repeat(16)}"`));
  assert.match(streamText, /data: \[DONE\]/);
});

test("OpenAI text completions work in normal and streaming modes", async (t) => {
  const harness = await makeHarness(t);
  const normalResponse = await fetch(`${harness.base}/v1/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", prompt: "Say quack", max_tokens: 8 }),
  });
  assert.equal(normalResponse.status, 200);
  const normal = await normalResponse.json();
  assert.equal(normal.object, "text_completion");
  assert.equal(normal.choices[0].text, "Quack!");
  assert.equal(normal.choices[0].finish_reason, "stop");
  assert.equal(normal.usage.total_tokens, 5);
  assert.equal(normal.system_fingerprint, "a".repeat(16));

  const streamResponse = await fetch(`${harness.base}/v1/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", prompt: "Say quack", stream: true }),
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /"object":"text_completion"/);
  assert.match(streamText, /"text":"Quack"/);
  assert.match(streamText, /data: \[DONE\]/);

  const missing = await fetch(`${harness.base}/v1/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model" }),
  });
  assert.equal(missing.status, 400);
});

test("missing routes return an actionable 404", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/nope`);
  assert.equal(response.status, 404);
  const data = await response.json();
  assert.equal(data.error.code, "not_found");
  assert.ok(data.error.fix);
});

test("tuned profiles are listed and read with what changed since they were measured", async (t) => {
  const harness = await makeHarness(t);
  const empty = await fetch(`${harness.base}/api/profiles`);
  assert.deepEqual(await empty.json(), { profiles: [] });

  const [installed] = harness.registry.listPublic();
  const id = profileIdFor(installed.fileName);
  const fingerprint = { ...(await currentFingerprint(installed, { nodeLlamaCpp: "test" })), suiteVersion: 7 };
  await saveProfile(harness.paths.profiles, profileFromTune(
    { load: { settings: { threads: 8 } }, tasks: { code: { settings: { temperature: 0.2 }, stats: { rate: 80, byType: { bugfix: { items: 12, right: 4, defaultRight: 9, p: 0.03 }, code: { items: 10, right: 10, defaultRight: 10, p: 1 } } } } }, sweeps: [], runs: 10, budgetExhausted: false },
    { catalogId: id, fingerprint },
  ));

  const list = await (await fetch(`${harness.base}/api/profiles`)).json();
  assert.deepEqual(list.profiles.map((item) => item.catalogId), [id]);

  const read = await fetch(`${harness.base}/api/profiles/${encodeURIComponent(id)}`);
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.profile.tasks.code.settings.temperature, 0.2);
  assert.deepEqual(body.stale, ["suiteVersion"]);
  assert.match(body.warnings[0], /test suite changed \(v7 → v\d+\)/i);
  assert.deepEqual(body.typeWarnings.code.map((entry) => entry.type), ["bugfix"], "only the clearly worse type");

  const missing = await fetch(`${harness.base}/api/profiles/not-tuned`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "profile_missing");
});

test("a malformed route escape is a 400, never a 500", async (t) => {
  const harness = await makeHarness(t);
  const body = await new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port: harness.port, path: "/api/profiles/%E0%A4%A", method: "GET" },
      (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(body.status, 400);
  assert.equal(JSON.parse(body.text).error.code, "route_id_invalid");
});

test("recommendations rank installed models and list fitting catalog models", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/recommendations?task=recall`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.task, "recall");
  assert.ok(data.memory.free > 0);
  assert.ok(Array.isArray(data.installed) && Array.isArray(data.catalog));
  assert.ok(data.installed.every((row) => row.fit !== "will_not_fit"));
  const fallback = await (await fetch(`${harness.base}/api/recommendations?task=poetry`)).json();
  assert.equal(fallback.task, "code", "an unknown task falls back to code");
  const defaultTask = await (await fetch(`${harness.base}/api/recommendations`)).json();
  assert.equal(defaultTask.task, "code", "the recommendation default is code");
});

test("a profile recipe exports as a file and imports for an installed model", async (t) => {
  const harness = await makeHarness(t);
  const [installed] = harness.registry.listPublic();
  const id = profileIdFor(installed.fileName);
  const fingerprint = await currentFingerprint(installed, { nodeLlamaCpp: "test" });
  await saveProfile(harness.paths.profiles, profileFromTune(
    { load: { settings: { threads: 8 } }, tasks: { code: { settings: { temperature: 0.2 }, stats: { rate: 80 } } }, sweeps: [], runs: 10, budgetExhausted: false },
    { catalogId: id, fingerprint },
  ));

  const exported = await fetch(`${harness.base}/api/profiles/${encodeURIComponent(id)}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /attachment; filename="/);
  const recipe = await exported.json();
  assert.equal(recipe.kind, "modelduck-profile");
  assert.equal("sweeps" in recipe, false, "the sweep log stays local");

  const imported = await fetch(`${harness.base}/api/profiles/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...recipe, tasks: { code: { settings: { temperature: 0.1 }, stats: { rate: 70 } } } }),
  });
  assert.equal(imported.status, 201);
  const body = await imported.json();
  assert.equal(body.catalogId, id);
  assert.equal(body.imported, true);
  const read = await (await fetch(`${harness.base}/api/profiles/${encodeURIComponent(id)}`)).json();
  assert.equal(read.profile.tasks.code.settings.temperature, 0.1, "the imported settings replace the old ones");

  const missing = await fetch(`${harness.base}/api/profiles/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...recipe, catalogId: "not-installed" }),
  });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).error.code, "profile_model_missing");
});

test("a shipped preset for an installed model is listed with its fit and applied on request", async (t) => {
  const presetsDir = await mkdtemp(path.join(os.tmpdir(), "modelduck-presets-"));
  t.after(() => rm(presetsDir, { recursive: true, force: true }));
  const harness = await makeHarness(t, { presetsDir });
  const [installed] = harness.registry.listPublic();
  const id = profileIdFor(installed.fileName);
  const here = await currentFingerprint(installed, { nodeLlamaCpp: "test" });
  const recipe = (fingerprint) => ({
    schema: 1, kind: "modelduck-profile", catalogId: id, createdAt: "2026-11-08T00:00:00.000Z", fingerprint,
    load: { settings: { threads: 12, gpuBackend: "vulkan", gpuLayers: "max" }, stats: null }, speed: null,
    tasks: { code: { settings: { temperature: 0.4 }, stats: { rate: 58.8, items: 136 } } },
  });
  // Measured on another computer: only the task presets apply.
  await writeFile(path.join(presetsDir, `${id}.modelduck-profile.json`), JSON.stringify(recipe({ ...here, cpu: "Some Other CPU" })));
  await writeFile(path.join(presetsDir, "absent.modelduck-profile.json"), JSON.stringify({ ...recipe(here), catalogId: "absent-model" }));

  const list = await (await fetch(`${harness.base}/api/presets`)).json();
  const row = list.presets.find((preset) => preset.catalogId === id);
  assert.equal(row.status, "portable");
  assert.equal(row.modelId, installed.id);
  assert.equal(row.rates.code.rate, 58.8, "the measured receipt is shown before applying");
  assert.equal(list.presets.find((preset) => preset.catalogId === "absent-model").status, "not_installed");

  const applied = await fetch(`${harness.base}/api/presets/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ catalogId: id }) });
  assert.equal(applied.status, 201);
  const body = await applied.json();
  assert.equal(body.status, "portable");
  assert.match(body.next, /device/i);
  const read = await (await fetch(`${harness.base}/api/profiles/${encodeURIComponent(id)}`)).json();
  assert.equal(read.profile.tasks.code.settings.temperature, 0.4);
  assert.deepEqual(read.profile.load.settings, {}, "the other computer's GPU settings are not applied");
  assert.deepEqual(read.profile.search.preset, { status: "portable", source: "shipped" });

  const absent = await fetch(`${harness.base}/api/presets/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ catalogId: "absent-model" }) });
  assert.equal(absent.status, 422);
  assert.equal((await absent.json()).error.code, "profile_model_missing");
});

test("a shipped preset never replaces a profile tuned on this computer unless asked", async (t) => {
  const presetsDir = await mkdtemp(path.join(os.tmpdir(), "modelduck-presets-"));
  t.after(() => rm(presetsDir, { recursive: true, force: true }));
  const harness = await makeHarness(t, { presetsDir });
  const [installed] = harness.registry.listPublic();
  const id = profileIdFor(installed.fileName);
  const here = await currentFingerprint(installed, { nodeLlamaCpp: "test" });
  await writeFile(path.join(presetsDir, `${id}.modelduck-profile.json`), JSON.stringify({
    schema: 1, kind: "modelduck-profile", catalogId: id, fingerprint: here,
    load: { settings: { threads: 4 }, stats: null }, tasks: { code: { settings: { temperature: 0.4 }, stats: { rate: 50 } } },
  }));
  await saveProfile(harness.paths.profiles, profileFromTune(
    { load: { settings: { threads: 8 } }, tasks: { code: { settings: { temperature: 0.2 }, stats: { rate: 80 } } }, sweeps: [], runs: 10, budgetExhausted: false, stages: { device: { status: "done" } } },
    { catalogId: id, fingerprint: here },
  ));
  const post = (body) => fetch(`${harness.base}/api/presets/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const refused = await post({ catalogId: id });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "preset_would_replace_tune");
  const forced = await post({ catalogId: id, force: true });
  assert.equal(forced.status, 201);
  assert.equal((await forced.json()).status, "exact", "same model and machine");
});

test("verified code retries until an answer passes the caller's tests, in the sandbox", async (t) => {
  class CodeEngine extends FakeEngine {
    constructor() {
      super();
      this.calls = [];
    }

    async chat(request) {
      this.calls.push(request.settings);
      const good = this.calls.length >= 2;
      return { text: `\`\`\`js\nfunction double(n) { return n ${good ? "*" : "+"} 2; }\n\`\`\``, stats: { outputTokens: 10, ms: 3 }, manifest: this.manifest };
    }
  }
  const engine = new CodeEngine();
  const harness = await makeHarness(t, { engine });
  const post = (body) => fetch(`${harness.base}/api/code/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const tests = { entry: "double", cases: [{ args: [1], expect: 2 }, { args: [5], expect: 10 }] };

  const response = await post({ prompt: "Write double(n).", tests, attempts: 3 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.passed, true);
  assert.equal(body.attempt, 2, "the first answer failed the real tests, the second passed");
  assert.equal(body.code, "function double(n) { return n * 2; }");
  assert.deepEqual(body.attempts.map((attempt) => `${attempt.passed}/${attempt.total}`), ["0/2", "2/2"]);
  assert.equal(body.model, "fake-model");
  assert.equal(engine.calls[1].temperature, 0.7, "the retry samples");

  const bad = await post({ prompt: "x", tests: { ...tests, entry: "process.exit" } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "verify_invalid");

  await engine.unload();
  const idle = await post({ prompt: "x", tests });
  assert.equal(idle.status, 409);
  assert.equal((await idle.json()).error.code, "model_not_loaded");
});

test("verified code stops generating when the client disconnects", async (t) => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let stopped;
  const aborted = new Promise((resolve) => { stopped = resolve; });
  class HangingEngine extends FakeEngine {
    constructor() {
      super();
      this.calls = 0;
    }

    async chat(request) {
      this.calls += 1;
      started();
      await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
      stopped();
      return { text: "", aborted: true, stats: { outputTokens: 0, ms: 1, stopReason: "abort" }, manifest: this.manifest };
    }
  }
  const engine = new HangingEngine();
  const harness = await makeHarness(t, { engine });
  const client = new AbortController();
  const response = fetch(`${harness.base}/api/code/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", tests: { entry: "f", cases: [{ args: [], expect: 1 }] }, attempts: 4 }),
    signal: client.signal,
  }).catch((error) => error);
  await running;
  client.abort();
  let timer;
  const never = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), 900); });
  const outcome = await Promise.race([aborted.then(() => "aborted"), never]);
  clearTimeout(timer);
  assert.equal(outcome, "aborted", "the disconnect reaches the running answer");
  assert.equal((await response).name, "AbortError");
  assert.equal(engine.calls, 1, "no new try starts once the client is gone");
});

test("verified code refuses on a Node whose sandbox cannot deny the network", async (t) => {
  const harness = await makeHarness(t, { nodeVersion: "24.11.0" });
  const response = await fetch(`${harness.base}/api/code/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", tests: { entry: "f", cases: [{ args: [], expect: 1 }] } }) });
  assert.equal(response.status, 503);
  const { error } = await response.json();
  assert.equal(error.code, "verify_sandbox_weak");
  assert.match(error.why, /24\.11\.0/);
  assert.match(error.fix, /25/);
});

test("loading applies the model's tuned profile for the chosen task", async (t) => {
  const harness = await makeHarness(t);
  const [installed] = harness.registry.listPublic();
  await saveProfile(harness.paths.profiles, profileFromTune(
    {
      load: { settings: { contextSize: 8192, threads: 6 } },
      tasks: { code: { settings: { temperature: 0.15, maxTokens: 900 } } },
      sweeps: [],
      runs: 1,
      budgetExhausted: false,
    },
    { catalogId: profileIdFor(installed.fileName), fingerprint: await currentFingerprint(installed, { nodeLlamaCpp: "test" }) },
  ));
  const loads = [];
  const { load } = harness.engine;
  harness.engine.load = (options) => (loads.push(options), load.call(harness.engine, options));

  const loaded = await fetch(`${harness.base}/api/models/${encodeURIComponent(installed.id)}/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contextSize: 2048, threads: 2 }),
  });
  const loadBody = await loaded.json();
  assert.equal(loads[0].contextSize, 8192, "the measured profile wins over the form");
  assert.equal(loads[0].threads, 6);
  assert.equal(loadBody.tuned.catalogId, profileIdFor(installed.fileName));

});

test("tune steps can be read, edited and estimated through the API", async (t) => {
  const harness = await makeHarness(t);
  const initial = await (await fetch(`${harness.base}/api/tune/steps`)).json();
  assert.equal(initial.custom, false);
  assert.equal(initial.steps.load.contextSize, undefined, "context is a fixed floor, not a step");
  assert.deepEqual(initial.defaults.load.threads, [1, 2, 4, 6, 8, 10, 12]);
  assert.ok(initial.estimate.quality.configs > 0);
  assert.ok(initial.estimate.speed.configs > 0);
  assert.equal(initial.settingNames[0], "device");
  assert.ok(!initial.settingNames.includes("contextSize"));

  const saved = await fetch(`${harness.base}/api/tune/steps`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steps: { load: { threads: [4, 100] } } }),
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.steps.load.threads, [4]);
  assert.ok(body.problems.some((problem) => problem.includes("threads 100")));
  assert.equal((await (await fetch(`${harness.base}/api/tune/steps`)).json()).custom, true);

  const estimate = await (await fetch(`${harness.base}/api/tune/estimate?tasks=code&stages=quality,sampling`)).json();
  assert.deepEqual(estimate.tasks, ["code"]);
  assert.deepEqual(estimate.stages, ["quality", "sampling"]);
  assert.ok(estimate.answersPerModel > 0);
  assert.ok(estimate.estimate.onePassSeconds > 0);
  assert.ok(estimate.quick.answersPerModel < estimate.answersPerModel);
  assert.ok(estimate.quick.estimate.onePassSeconds < estimate.estimate.onePassSeconds);
  assert.equal(estimate.models, 1);
  assert.equal(estimate.perModel.length, 1);
  const badEstimate = await fetch(`${harness.base}/api/tune/estimate?tasks=poetry`);
  assert.equal(badEstimate.status, 400);
  assert.equal((await badEstimate.json()).error.code, "unknown_task");
});

test("tunes for one model or all installed models are scheduled, watched and cancelled through the API", async (t) => {
  const starts = [];
  const moves = [];
  let job = null;
  const tunes = {
    start(request) {
      starts.push(request);
      job = { status: "running", paused: false, order: request.models.map((model) => model.profileId), items: request.models.map((model) => ({ profileId: model.profileId, status: "queued" })) };
      return job;
    },
    get: () => job,
    move(profileId, direction) {
      moves.push([profileId, direction]);
      return job;
    },
    pause() {
      job = { ...job, paused: true };
      return job;
    },
    resume() {
      job = { ...job, paused: false };
      return job;
    },
    cancel() {
      job = { ...job, status: "cancelled" };
      return job;
    },
  };
  const harness = await makeHarness(t, { models: 2, tunes });
  const post = (route, body) => fetch(`${harness.base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

  assert.deepEqual(await (await fetch(`${harness.base}/api/tune/status`)).json(), { job: null });
  const all = await post("/api/tune/start", { models: "all", stages: ["device", "quality"], settings: ["kvCache"], force: true });
  assert.equal(all.status, 202);
  assert.equal(starts[0].models.length, 2);
  assert.deepEqual(Object.keys(starts[0].models[0]).sort(), ["fileName", "id", "name", "profileId"]);
  assert.deepEqual(starts[0].stages, ["device", "quality"]);
  assert.equal(starts[0].force, true);
  assert.deepEqual(starts[0].settings, ["kvCache"]);
  const bad = await post("/api/tune/start", { models: "all", settings: ["warpDrive"] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "unknown_setting");
  const badTask = await post("/api/tune/start", { models: "all", tasks: ["poetry"] });
  assert.equal(badTask.status, 400);
  assert.equal((await badTask.json()).error.code, "unknown_task");
  const badStage = await post("/api/tune/start", { models: "all", stages: ["warp"] });
  assert.equal(badStage.status, 400);
  assert.equal((await badStage.json()).error.code, "unknown_stage");

  const [installed] = harness.registry.listPublic();
  await post("/api/tune/start", { models: [installed.id], tasks: ["code"] });
  assert.equal(starts[1].models.length, 1);
  assert.equal(starts[1].models[0].profileId, profileIdFor(installed.fileName));
  assert.deepEqual(starts[1].tasks, ["code"]);
  await post("/api/tune/start", { models: [installed.id], tasks: [] });
  assert.deepEqual(starts.at(-1).tasks, null, "an empty task list means every task");

  const quick = await post("/api/tune/start", { models: [installed.id], tasks: ["code"], quick: true, guard: true, guardQueue: true });
  assert.equal(quick.status, 202);
  assert.equal(starts.at(-1).quick, true);
  assert.equal(starts.at(-1).guard, true);
  assert.equal(starts.at(-1).guardQueue, true);
  assert.equal(starts.at(-1).budgetMinutes, null, "no budget unless one is sent");
  const budgeted = await post("/api/tune/start", { models: [installed.id], tasks: ["code"], quick: true, budgetMinutes: 5 });
  assert.equal(budgeted.status, 202);
  assert.equal(starts.at(-1).budgetMinutes, 5, "a per-model time budget reaches the scheduler");
  assert.equal((await (await post("/api/tune/pause")).json()).job.paused, true);
  assert.equal((await (await post("/api/tune/resume")).json()).job.paused, false);
  assert.equal((await post("/api/tune/priority", { profileId: profileIdFor(installed.fileName), direction: "down" })).status, 200);
  assert.deepEqual(moves, [[profileIdFor(installed.fileName), "down"]]);
  assert.equal((await post("/api/tune/priority", { direction: "sideways" })).status, 400);

  const unknown = await post("/api/tune/start", { models: ["no-such-model"] });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "model_not_found");

  assert.equal((await (await fetch(`${harness.base}/api/tune/status`)).json()).job.status, "running");
  assert.equal((await (await post("/api/tune/cancel")).json()).job.status, "cancelled");
});

test("the tune overview lists every installed model with its profile summary", async (t) => {
  const harness = await makeHarness(t, { models: 2 });
  const [first] = harness.registry.listPublic();
  const fingerprint = { ...(await currentFingerprint(first, { nodeLlamaCpp: "test" })), suiteVersion: 1 };
  await saveProfile(harness.paths.profiles, profileFromTune(
    {
      load: { settings: { gpuBackend: "vulkan", gpuLayers: "max", contextSize: 8192 } },
      device: { settings: { gpuBackend: "vulkan", gpuLayers: "max" }, probe: [], reason: "vulkan with max layers: 110 tok/s vs 20 tok/s on the CPU" },
      speed: { fastest: { threads: 4 }, light: { threads: 2 } },
      tasks: { code: { settings: { temperature: 0, systemPrompt: "Think from first principles." }, stats: { rate: 75, items: 24, ci95: { low: 55, high: 88 }, outputTokens: 120 } } },
      stages: { device: "done", quality: "done", speed: "done", sampling: { code: "done" }, prompt: { code: "partial" } },
      sweeps: [{ stage: "speed" }],
      runs: 400,
      budgetExhausted: false,
    },
    { catalogId: profileIdFor(first.fileName), fingerprint },
  ));
  const { models } = await (await fetch(`${harness.base}/api/tune/overview`)).json();
  assert.equal(models.length, 2);
  const tuned = models.find((model) => model.id === first.id);
  assert.equal(tuned.profileId, profileIdFor(first.fileName));
  assert.equal(tuned.profile.device.reason, "vulkan with max layers: 110 tok/s vs 20 tok/s on the CPU");
  assert.equal(tuned.profile.stages.prompt.code, "partial");
  assert.equal(tuned.profile.tasks.code.stats.rate, 75);
  assert.equal(tuned.profile.speed.light.threads, 2);
  assert.equal("sweeps" in tuned.profile, false, "the sweep log stays out of the overview");
  assert.equal("progress" in tuned.profile, false);
  assert.match(tuned.warnings[0], /test suite changed/i);
  const untuned = models.find((model) => model.id !== first.id);
  assert.equal(untuned.profile, null);
});

test("OpenAI chat completions use the tuned preset as defaults, and the client's values still win", async (t) => {
  const harness = await makeHarness(t);
  const [installed] = harness.registry.listPublic();
  await saveProfile(harness.paths.profiles, profileFromTune(
    {
      load: { settings: { threads: 6 } },
      tasks: {
        code: { settings: { temperature: 0, maxTokens: 900, systemPrompt: "Think from first principles.", reasoning: "off" } },
        recall: { settings: { temperature: 0.4, maxTokens: 321, systemPrompt: "Recall the document carefully.", reasoning: "auto" } },
      },
      sweeps: [],
      runs: 1,
      budgetExhausted: false,
    },
    { catalogId: profileIdFor(installed.fileName), fingerprint: await currentFingerprint(installed, { nodeLlamaCpp: "test" }) },
  ));
  await fetch(`${harness.base}/api/models/${encodeURIComponent(installed.id)}/load`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const chats = [];
  const { chat } = harness.engine;
  harness.engine.chat = (request) => (chats.push(request), chat.call(harness.engine, request));
  const ask = (body, headers = {}) => fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: installed.id, messages: [{ role: "user", content: "hi" }], ...body }),
  });

  assert.equal((await ask({})).status, 200);
  assert.equal(chats[0].settings.temperature, 0);
  assert.equal(chats[0].settings.maxTokens, 2048, "a suite-fitted 900 cap is raised to the code serving floor (M1)");
  assert.equal(chats[0].settings.reasoning, "off", "the reasoning setting reaches the engine");
  assert.equal(chats[0].systemPrompt, "Think from first principles.");

  await ask({ temperature: 0.9, max_tokens: 20, messages: [{ role: "system", content: "Be a pirate." }, { role: "user", content: "hi" }] });
  assert.equal(chats[1].settings.temperature, 0.9);
  assert.equal(chats[1].settings.maxTokens, 20);
  assert.equal(chats[1].systemPrompt, "Be a pirate.");

  await ask({}, { "x-modelduck-task": "recall" });
  assert.equal(chats[2].settings.maxTokens, 1024, "a suite-fitted 321 cap is raised to the recall serving floor (M1)");
  assert.equal(chats[2].systemPrompt, "Recall the document carefully.");
  assert.equal(chats[2].settings.reasoning, "auto");
  await ask({ modelduck_task: "recall" });
  assert.equal(chats[3].settings.maxTokens, 1024);
  assert.equal(chats[3].systemPrompt, "Recall the document carefully.");

  await ask({}, { "x-modelduck-task": "code" });
  assert.equal(chats[4].settings.maxTokens, 2048);
  assert.equal(chats[4].systemPrompt, "Think from first principles.");

  const unknown = await ask({}, { "x-modelduck-task": "poetry" });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error.message, /poetry/);
});

test("Run all can start stale profiles over while fresh ones resume", async (t) => {
  const starts = [];
  const tunes = { start: (request) => (starts.push(request), { status: "running", items: [] }), get: () => null, cancel: () => null };
  const harness = await makeHarness(t, { models: 2, tunes });
  const [stale, fresh] = harness.registry.listPublic();
  const save = async (model, fingerprintPatch) => saveProfile(harness.paths.profiles, profileFromTune(
    { load: { settings: {} }, tasks: {}, stages: { device: "done" }, sweeps: [], runs: 1, budgetExhausted: false },
    { catalogId: profileIdFor(model.fileName), fingerprint: { ...(await currentFingerprint(model, { nodeLlamaCpp: "test" })), ...fingerprintPatch } },
  ));
  await save(stale, { suiteVersion: 1 });
  await save(fresh, {});
  await fetch(`${harness.base}/api/tune/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ models: "all", forceStale: true }) });
  const byId = Object.fromEntries(starts[0].models.map((model) => [model.id, model.force]));
  assert.equal(byId[stale.id], true);
  assert.equal(byId[fresh.id], false);

  // Continuing a whole tune never starts a stale profile over (ADR-051).
  await fetch(`${harness.base}/api/tune/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ models: "all", forceStale: true, continue: true }) });
  assert.deepEqual(starts.at(-1).models.map((model) => Boolean(model.force)), [false, false]);
  assert.equal(starts.at(-1).continueRun, true);

  // A part run keeps every saved profile and re-measures only the chosen parts (ADR-040).
  for (const part of [{ stages: ["prompt"] }, { settings: ["contextSize"] }, { tasks: ["code"] }]) {
    await fetch(`${harness.base}/api/tune/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ models: "all", forceStale: true, ...part }) });
    assert.deepEqual(starts.at(-1).models.map((model) => Boolean(model.force)), [false, false], JSON.stringify(part));
  }
});

test("tune runs are listed, opened with an answer summary, and their answers downloaded", async (t) => {
  const harness = await makeHarness(t);
  const run = await startRun(harness.paths.tuneRuns, { profileId: "qwen", model: "qwen.gguf", request: { stages: ["prompt"] } });
  await run.answers([{ settings: {}, seed: 42, item: "code-1", passed: 1, total: 1, ms: 120 }, { settings: {}, seed: 42, item: "code-2", passed: 0, total: 1, ms: 180 }]);
  await run.finish({ outcome: "done", sweeps: [{ axis: "systemPrompt" }] });

  const list = await (await fetch(`${harness.base}/api/tune/runs`)).json();
  assert.deepEqual(list.runs.map((entry) => [entry.id, entry.outcome]), [[run.id, "done"]]);
  const detail = await (await fetch(`${harness.base}/api/tune/runs/${run.id}`)).json();
  assert.deepEqual(detail.run.sweeps, [{ axis: "systemPrompt" }]);
  assert.equal(detail.answers.answers, 2);
  assert.equal(detail.answers.right, 50);
  const download = await fetch(`${harness.base}/api/tune/runs/${run.id}/answers`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment; filename="tune-run-.+\.jsonl"/);
  assert.equal((await download.text()).trim().split("\n").length, 2);

  assert.equal((await fetch(`${harness.base}/api/tune/runs/..%2Fprofiles`)).status, 400);
  assert.equal((await fetch(`${harness.base}/api/tune/runs/2026-01-01T00-00-00-000Z-1`)).status, 404);
});

test("a tune is streamed live: the job at once, then each change, until the page goes away", async (t) => {
  const listeners = new Set();
  let job = { status: "running", items: [{ profileId: "qwen", live: { answers: 0 } }] };
  const tunes = { start: () => job, cancel: () => job, get: () => job, subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)) };
  const harness = await makeHarness(t, { tunes });
  const controller = new AbortController();
  const response = await fetch(`${harness.base}/api/tune/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const nextEvent = async () => {
    while (!text.includes("\n\n")) text += decoder.decode((await reader.read()).value);
    const [event, ...rest] = text.split("\n\n");
    text = rest.join("\n\n");
    return JSON.parse(event.replace(/^data: /, ""));
  };
  assert.equal((await nextEvent()).job.items[0].live.answers, 0, "the job as it is now");
  job = { ...job, items: [{ profileId: "qwen", live: { answers: 12 } }] };
  for (const listener of listeners) listener();
  assert.equal((await nextEvent()).job.items[0].live.answers, 12, "the change, pushed");
  controller.abort();
  // The abort propagates through the request stream; poll instead of hoping
  // a fixed sleep covers a loaded machine.
  const abortedAt = Date.now();
  while (listeners.size !== 0 && Date.now() - abortedAt < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(listeners.size, 0, "a closed page stops listening");
});

test("the benchmark suite route describes every task's questions", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/api/benchmarks/suite`);
  assert.equal(response.status, 200);
  const suite = await response.json();
  assert.ok(suite.suiteVersion >= 14);
  assert.deepEqual(suite.tasks.map((task) => task.id), ["code", "comprehension", "recall"]);
  assert.ok(suite.tasks.every((task) => task.types.length && task.held > 0 && task.tunedOn > 0));
  // The opt-in multistep chains are described beside the tasks, never as a tuned task.
  assert.equal(suite.multistep.id, "multistep");
  assert.equal(suite.multistep.optIn, true);
  assert.equal(suite.multistep.chains.length, 5);
  assert.match(suite.multistep.command, /bench:multistep/);
});
