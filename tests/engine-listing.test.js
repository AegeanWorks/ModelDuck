import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEngineCatalog } from "../src/engine-catalog.js";
import { createEngineListing } from "../src/engine-listing.js";
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

async function listing(t, { measured = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-engines-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const entry = { id: "m1", fileName: "tiny-model.gguf" };
  if (measured) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${profileIdFor(entry.fileName)}.engines.json`), JSON.stringify(measured));
  }
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
