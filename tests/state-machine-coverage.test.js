import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { machineCatalog } from "../src/state-machine.js";

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
const inventory = JSON.parse(read("docs/state-machines.json"));
const markdown = read("docs/state-machines.md");
const catalog = machineCatalog();

const EXPLICIT = {
  "Engine phase": "engine",
  "Download job": "download",
  "Benchmark job": "benchmark",
};

test("the inventory lists 25 machines with unique ids, states and evidence", () => {
  assert.equal(inventory.machines.length, 25);
  assert.deepEqual(
    inventory.machines.map((machine) => machine.id),
    Array.from({ length: 25 }, (_value, index) => index + 1),
  );
  for (const machine of inventory.machines) {
    assert.ok(machine.name, `machine ${machine.id} has no name`);
    assert.ok(machine.where?.file && machine.where?.anchor, `${machine.name} has no evidence anchor`);
    assert.ok(Array.isArray(machine.states) && machine.states.length >= 2, `${machine.name} has too few states`);
    assert.equal(new Set(machine.states).size, machine.states.length, `${machine.name} repeats a state`);
    assert.ok(["explicit", "implicit"].includes(machine.kind), `${machine.name} has no kind`);
    assert.ok(machine.defect, `${machine.name} records no verified defect`);
  }
});

test("every machine's claimed file and anchor exist", () => {
  for (const machine of inventory.machines) {
    const source = read(machine.where.file);
    assert.ok(source.includes(machine.where.anchor), `${machine.name}: ${machine.where.anchor} not found in ${machine.where.file}`);
  }
});

test("the explicit machines match the runtime catalog exactly", () => {
  for (const [name, key] of Object.entries(EXPLICIT)) {
    const machine = inventory.machines.find((item) => item.name === name);
    assert.ok(machine, `${name} is missing from the inventory`);
    assert.deepEqual([...machine.states].sort(), [...catalog[key].states].sort(), `${name} states drift from the catalog`);
    // A lifecycle phase (engine) has no terminal state; a job does.
    if (key === "engine") assert.deepEqual(catalog.engine.terminal, []);
    else assert.ok(catalog[key].terminal.length > 0, `${key} has no terminal state`);
  }
});

test("the markdown table has one row per inventory machine", () => {
  const rows = markdown.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, inventory.machines.length);
  for (const machine of inventory.machines) {
    assert.ok(markdown.includes(machine.name), `${machine.name} is missing from the markdown list`);
  }
});

test("every write site in the adopted modules uses a machine state", () => {
  const engine = read("src/engine.js");
  assert.match(engine, /ENGINE_MACHINE/);
  const engineStates = new Set(catalog.engine.states);
  for (const match of engine.matchAll(/#setStatus\("([^"]+)"\)/g)) {
    assert.ok(engineStates.has(match[1]), `engine wrote unknown status ${match[1]}`);
  }
  for (const match of engine.matchAll(/status: "([^"]+)"/g)) {
    assert.ok(engineStates.has(match[1]), `engine state object wrote unknown status ${match[1]}`);
  }

  const downloader = read("src/downloader.js");
  assert.match(downloader, /DOWNLOAD_MACHINE/);
  const downloadStates = new Set(catalog.download.states);
  for (const match of downloader.matchAll(/moveTo\(job, DOWNLOAD_MACHINE, "([^"]+)"\)/g)) {
    assert.ok(downloadStates.has(match[1]), `download wrote unknown status ${match[1]}`);
  }
  for (const match of downloader.matchAll(/status: "([^"]+)"/g)) {
    assert.ok(downloadStates.has(match[1]), `download state object wrote unknown status ${match[1]}`);
  }

  const benchmark = read("src/benchmark-runner.js");
  assert.match(benchmark, /BENCHMARK_MACHINE/);
  const benchmarkStates = new Set(catalog.benchmark.states);
  for (const match of benchmark.matchAll(/#finish\(job, "([^"]+)"/g)) {
    assert.ok(benchmarkStates.has(match[1]), `benchmark wrote unknown status ${match[1]}`);
  }
  assert.ok(benchmarkStates.has("running"));
});
