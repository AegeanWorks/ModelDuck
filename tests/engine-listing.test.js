import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEngineCatalog, engineContext } from "../src/engine-catalog.js";
import { createEngineListing, fastestPerTask } from "../src/engine-listing.js";
import { resetInstalledEngineCache } from "../src/engine-install.js";
import { profileIdFor } from "../src/model-profiles.js";
import { makeHarness } from "./helpers.js";

const kindOwns = (kind) => (id) => id === kind || id.startsWith(`${kind}:`);
const adapter = (id, label) => ({ id, label });
const CATALOG = createEngineCatalog({
  descriptors: [
    { kind: "inproc", servable: false, owns: kindOwns("inproc"), adapters: () => [adapter("inproc", "In process")] },
    {
      kind: "srv",
      servable: true,
      owns: kindOwns("srv"),
      adapters: () => [adapter("srv:fast", "Fast build"), adapter("srv:gone", "Missing build")],
      resolve: (id) => (id === "srv:fast" ? { id } : null),
      version: (id) => (id === "srv:fast" ? "b1" : null),
    },
  ],
});

async function listing(t, { measured = null, profile = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const entry = { id: "m1", fileName: "tiny-model.gguf" };
  if (measured) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${profileIdFor(entry.fileName)}.engines.json`), JSON.stringify(measured));
  }
  if (profile) await writeFile(path.join(dir, `${profileIdFor(entry.fileName)}.json`), JSON.stringify(profile));
  return createEngineListing({ catalog: CATALOG, registry: { findById: (id) => (id === "m1" ? entry : null) }, profilesDir: dir, context: () => ({}) });
}

test("the listing names every engine, whether it can serve, its build and what it measured", async (t) => {
  const engines = await listing(t, { measured: { assessedAt: "2026-11-19T00:00:00Z", results: [{ id: "srv:fast", ok: true, genTps: 50, promptTps: 400 }, { id: "inproc", ok: true, genTps: 80 }] } });
  const result = await engines.list("m1");
  assert.deepEqual(result.engines.map((engine) => [engine.id, engine.servable, engine.version]), [["inproc", false, null], ["srv:fast", true, "b1"], ["srv:gone", false, null]]);
  assert.equal(result.engines[1].measured.genTps, 50);
  assert.equal(result.fastest, "srv:fast", "a measure-only engine is never named as the one to serve with");
});

test("with nothing measured the listing still answers, with no fastest", async (t) => {
  const result = await (await listing(t)).list("m1");
  assert.equal(result.fastest, null);
  assert.ok(result.engines.every((engine) => engine.measured === null));
  assert.equal((await (await listing(t)).list("unknown-model")).fastest, null);
});

test("an engine that is unknown, missing or measure-only is refused with a Why and the choices", async (t) => {
  const engines = await listing(t);
  engines.assertServable("srv:fast");
  for (const id of ["nope", "srv:gone", "inproc"]) {
    assert.throws(() => engines.assertServable(id), (error) => error.code === "engine_unknown" && error.status === 400 && /srv:fast/.test(error.fix) && Boolean(error.why));
  }
});

test("GET /api/engines answers, and a load names an engine only when it can be served", async (t) => {
  const engines = await listing(t);
  const harness = await makeHarness(t, { engines });
  const body = await fetch(`${harness.base}/api/engines`).then((response) => response.json());
  assert.equal(body.engines.length, 3);
  const load = (engine) => fetch(`${harness.base}/api/models/${harness.modelId}/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine }) });
  const refused = await load("srv:gone");
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, "engine_unknown");
  assert.equal((await load("srv:fast")).status, 200);
});

test("a machine with no prebuilt llama.cpp is told so in one sentence, one with a build is not", async () => {
  const { prebuiltNotice } = await import("../src/engine-listing.js");
  const manifestFile = new URL("../engines/manifest.json", import.meta.url);
  const note = await prebuiltNotice({ platform: "linux", arch: "riscv64", manifestFile });
  assert.match(note, /linux-riscv64/);
  assert.match(note, /engines:add/);
  assert.equal(await prebuiltNotice({ platform: "win32", arch: "x64", manifestFile }), null);
  assert.equal(await prebuiltNotice({ platform: "linux", arch: "riscv64", manifestFile: new URL("../engines/missing.json", import.meta.url) }), null, "an unreadable manifest is silence, not a false notice");
});

test("an engine whose probe fails is not offered, with its reason, and the probe is shared and cached", async (t) => {
  let probes = 0;
  const offline = { id: "srv:down", label: "Down", detect: async () => { probes += 1; return { available: false, reason: "No server answered." }; } };
  const catalog = createEngineCatalog({
    descriptors: [{ kind: "srv", servable: true, owns: kindOwns("srv"), adapters: () => [adapter("srv:fast", "Fast build"), offline], resolve: (id) => ({ id }) }],
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  let now = 0;
  const engines = createEngineListing({ catalog, registry: { findById: () => null }, profilesDir: dir, context: () => ({}), notice: async () => null, clock: () => now });
  const [first, second] = await Promise.all([engines.list(), engines.list()]);
  const down = first.engines.find((engine) => engine.id === "srv:down");
  assert.equal(down.servable, false);
  assert.equal(down.reason, "No server answered.");
  assert.equal(first.engines.find((engine) => engine.id === "srv:fast").servable, true, "an adapter with no detect is not held back");
  assert.deepEqual(second.engines.map((engine) => engine.servable), first.engines.map((engine) => engine.servable));
  assert.equal(probes, 1, "two lists at once share one probe");
  now = 30_000;
  await engines.list();
  assert.equal(probes, 1, "within a minute the probe is reused");
  now = 61_000;
  await engines.list();
  assert.equal(probes, 2, "after a minute it is asked again");
});

test("engines are ranked per task by expected seconds per answer, not by generation speed alone (F5, ADR-181)", () => {
  const engines = [
    { id: "gen", servable: true, measured: { ok: true, genTps: 200, promptTps: 4000 } },
    { id: "prefill", servable: true, measured: { ok: true, genTps: 160, promptTps: 6000 } },
    { id: "gone", servable: false, measured: { ok: true, genTps: 999, promptTps: 99999 } },
    { id: "unmeasured", servable: true, measured: null },
  ];
  const tasks = {
    code: { promptTokens: 100, outputTokens: 150 },
    recall: { promptTokens: 8000, outputTokens: 20 },
    empty: { promptTokens: 0, outputTokens: 0 },
    missing: null,
  };
  const ranked = fastestPerTask(engines, tasks);
  assert.equal(ranked.code.fastest, "gen", "a long answer favours generation speed");
  assert.equal(ranked.recall.fastest, "prefill", "a long prompt favours prompt speed: 8000/6000+20/160 beats 8000/4000+20/200");
  assert.ok(Math.abs(ranked.recall.seconds.prefill - (8000 / 6000 + 20 / 160)) < 1e-9);
  assert.deepEqual(Object.keys(ranked.recall.seconds).sort(), ["gen", "prefill"], "only servable, measured engines are ranked");
  assert.equal(ranked.empty, undefined, "a task with no recorded tokens says nothing");
  assert.equal(ranked.missing, undefined);
  assert.deepEqual(fastestPerTask([], tasks), {});
});

test("the listing ranks engines per task from the model's profile and its engine measurements (F5, ADR-181)", async (t) => {
  const results = [{ id: "srv:fast", ok: true, genTps: 200, promptTps: 4000 }, { id: "inproc", ok: true, genTps: 100, promptTps: 9000 }];
  const profile = { tasks: { code: { stats: { promptTokens: 100, outputTokens: 150 } }, recall: { stats: { promptTokens: 8000, outputTokens: 5 } } } };
  const both = await (await listing(t, { measured: { results }, profile })).list("m1");
  assert.equal(both.byTask.code.fastest, "srv:fast");
  assert.deepEqual(Object.keys(both.byTask.code.seconds), ["srv:fast"], "inproc is measure-only in this catalog, so only srv:fast is ranked");
  assert.equal(both.byTask.recall.fastest, "srv:fast");
  assert.deepEqual((await (await listing(t, { measured: { results } })).list("m1")).byTask, {}, "no profile, no per-task ranking");
});

test("repeated engine listings share one exact-stamped installed snapshot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "md-engine-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variant of ["cpu", "vulkan"]) {
    const dir = path.join(root, "bin", `llama.cpp-${variant}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "llama-server.exe"), "");
    await writeFile(path.join(dir, "llama-bench.exe"), "");
    await writeFile(path.join(dir, "install.json"), JSON.stringify({ engine: "llama.cpp", variant, release: "b1" }));
  }
  resetInstalledEngineCache();
  const listing = createEngineListing({
    catalog: createEngineCatalog(),
    registry: null,
    profilesDir: null,
    context: () => engineContext({ roots: [root], platform: "win32" }),
    notice: async () => null,
  });
  const expected = await listing.list();
  const realRead = fs.readFileSync;
  const realReaddir = fs.readdirSync;
  let installReads = 0;
  let scans = 0;
  fs.readFileSync = (...args) => {
    if (String(args[0]).endsWith("install.json")) installReads += 1;
    return realRead(...args);
  };
  fs.readdirSync = (...args) => {
    scans += 1;
    return realReaddir(...args);
  };
  try {
    const outputs = await Promise.all(Array.from({ length: 20 }, () => listing.list()));
    assert.ok(outputs.every((out) => JSON.stringify(out) === JSON.stringify(expected)), "every listing is identical");
    assert.equal(installReads, 0, "unchanged install records are not reread");
    assert.ok(scans <= 40, `one bin scan per listing, not repeated descriptor discovery (${scans})`);
  } finally {
    fs.readFileSync = realRead;
    fs.readdirSync = realReaddir;
  }

  await writeFile(path.join(root, "bin", "llama.cpp-cpu", "install.json"), JSON.stringify({ engine: "llama.cpp", variant: "cpu", release: "b2" }));
  const changed = await listing.list();
  assert.equal(changed.engines.find((engine) => engine.id === "llama-server:cpu").version, "b2", "an external record edit refreshes the next listing");
  resetInstalledEngineCache();
});
