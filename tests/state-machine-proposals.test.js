import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const read = (relative) => readFileSync(root(relative), "utf8");
const proposals = JSON.parse(read("docs/state-machine-proposals.json"));
const markdown = read("docs/state-machine-proposals.md");
const inventory = JSON.parse(read("docs/state-machines.json"));

test("every passing proposal has code markers and a named test that exists", () => {
  assert.deepEqual(
    proposals.implemented.map((item) => item.id),
    ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"],
  );
  for (const proposal of proposals.implemented) {
    assert.ok(markdown.includes(proposal.id), `${proposal.id} is missing from the proposal list`);
    assert.ok(markdown.includes(proposal.title), `${proposal.id} title drifted from the document`);
    assert.ok(proposal.markers.length >= 1, `${proposal.id} has no code evidence`);
    for (const marker of proposal.markers) {
      assert.ok(existsSync(root(marker.file)), `${proposal.id}: missing ${marker.file}`);
      assert.ok(read(marker.file).includes(marker.contains), `${proposal.id}: ${marker.file} no longer contains ${marker.contains}`);
    }
    assert.ok(proposal.tests.length >= 1, `${proposal.id} has no verification test`);
    for (const evidence of proposal.tests) {
      assert.ok(existsSync(root(evidence.file)), `${proposal.id}: missing ${evidence.file}`);
      const source = read(evidence.file);
      if (evidence.name) {
        assert.ok(source.includes(`test("${evidence.name}"`), `${proposal.id}: ${evidence.file} no longer tests "${evidence.name}"`);
      }
      if (evidence.contains) {
        assert.ok(source.includes(evidence.contains), `${proposal.id}: ${evidence.file} no longer contains "${evidence.contains}"`);
      }
    }
  }
});

test("deferred proposals stay documented with a reason", () => {
  assert.deepEqual(
    proposals.deferred.map((item) => item.id),
    ["D1", "D2", "D3", "D4", "D5"],
  );
  for (const item of proposals.deferred) {
    assert.ok(item.reason.length > 20, `${item.id} has no substantive reason`);
    assert.ok(markdown.includes(item.title), `${item.id} is missing from the deferred list`);
  }
});

test("the proposal list names the machines it changed", () => {
  const names = new Set(inventory.machines.map((machine) => machine.name));
  for (const name of ["Engine phase", "Download job", "Benchmark job", "Settings form", "Restart required", "API-key lifecycle"]) {
    assert.ok(names.has(name), `${name} is missing from the inventory`);
  }
});

test("the verified fixes exist in the runtime", async () => {
  const { DOWNLOAD_MACHINE, moveTo, machineCatalog } = await import("../src/state-machine.js");
  assert.equal(moveTo({ status: "canceled" }, DOWNLOAD_MACHINE, "complete"), false);
  assert.equal(machineCatalog().engine.initial, "idle");
  const { restartRequiredFor } = await import("../src/server-settings.js");
  assert.equal(restartRequiredFor({ host: "127.0.0.1", port: 4141 }, { port: 4141, serveOnLocalNetwork: false }), false);
  assert.equal(restartRequiredFor({ host: "127.0.0.1", port: 4141 }, { port: 4142, serveOnLocalNetwork: false }), true);
});
