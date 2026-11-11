import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gateCacheFile, generationDigest, generationPathFiles, loadGateCache, mergeAnswerGroups, saveGateCache } from "../benchmarks/gate-cache.mjs";
import { measurePresets } from "../benchmarks/tune.mjs";

// IDEA-1764: the gate persists its measured answers under a strict fingerprint
// and reuses exact settings/seed/item rows on the next run. Stale fingerprints
// are discarded, never migrated.

const settingsOf = (overrides = {}) => ({ temperature: 0, maxTokens: 64, ...overrides });

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "modelduck-gate-cache-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("generationDigest digests the generation-path files and tracks edits", async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  await writeFile(path.join(root, "sampler.js"), "old", "utf8");
  const files = ["sampler.js"];
  const before = await generationDigest(root, files);
  assert.equal(before.length, 32);
  assert.equal(await generationDigest(root, files), before); // deterministic
  await writeFile(path.join(root, "sampler.js"), "edited", "utf8");
  assert.notEqual(await generationDigest(root, files), before); // an edit invalidates
});

test("generationPathFiles derives the generation path from engine.js's import closure", async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const mkdir = (await import("node:fs/promises")).mkdir;
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "engine.js"), 'import { a } from "./sampler.js";\nimport { b } from "./util.js";\n', "utf8");
  await writeFile(path.join(root, "src", "sampler.js"), 'import { b } from "./util.js";\n', "utf8");
  await writeFile(path.join(root, "src", "util.js"), "export const b = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "server.js"), "// never imported: outside the generation path\n", "utf8");
  const files = await generationPathFiles(root);
  assert.deepEqual(files, ["src/engine.js", "src/sampler.js", "src/util.js"]); // transitive closure, sorted

  const before = await generationDigest(root);
  await writeFile(path.join(root, "src", "util.js"), "export const b = 2;\n", "utf8");
  const afterTransitiveEdit = await generationDigest(root);
  assert.notEqual(afterTransitiveEdit, before); // a transitive edit invalidates

  await writeFile(path.join(root, "src", "server.js"), "// unrelated edit\n", "utf8");
  assert.equal(await generationDigest(root), afterTransitiveEdit); // non-path edits alone do not
});

test("a broken generation-path import fails loudly, never silently skips", async (t) => {
  const { root, cleanup } = await makeRoot();
  t.after(cleanup);
  const mkdir = (await import("node:fs/promises")).mkdir;
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "engine.js"), 'import { a } from "./missing.js";\n', "utf8");
  await assert.rejects(() => generationPathFiles(root), /missing\.js/);
});

test("generationDigest covers the real engine closure and the gate drivers, and nothing else", async () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = await generationPathFiles(repo);
  for (const required of ["src/engine.js", "src/sampler-chain.js", "src/checkpoint-policy.js", "src/config.js"]) {
    assert.ok(files.includes(required), `${required} must stay on the generation path`);
  }
  for (const outside of ["src/server.js", "src/downloader.js", "src/model-registry.js"]) {
    assert.ok(!files.includes(outside), `${outside} is not on the generation path`);
  }
  assert.match(await generationDigest(repo), /^[0-9a-f]{32}$/);
});

test("loadGateCache returns nothing for missing, stale or corrupt caches", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modelduck-gate-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model.json");
  assert.equal(await loadGateCache(file, "f1"), null); // missing

  await saveGateCache(file, { fingerprint: "f1", groups: [{ settings: settingsOf(), seed: 42, rows: [{ id: "a", passed: 1, total: 1 }] }] });
  const loaded = await loadGateCache(file, "f1");
  assert.equal(loaded.groups.length, 1);
  assert.equal(loaded.groups[0].rows.length, 1);

  assert.equal(await loadGateCache(file, "f2"), null); // stale fingerprint -> discard
  await writeFile(file, "{not json", "utf8");
  assert.equal(await loadGateCache(file, "f1"), null); // corrupt -> discard, never crash
});

test("mergeAnswerGroups keeps restored rows and lets fresh answers win per item", () => {
  const saved = [{ settings: settingsOf(), seed: 42, rows: [{ id: "a", passed: 0 }, { id: "b", passed: 1 }] }];
  const fresh = [{ settings: settingsOf(), seed: 42, rows: [{ id: "a", passed: 1, total: 1 }] }];
  const merged = mergeAnswerGroups(saved, fresh);
  assert.equal(merged.length, 1);
  const rows = new Map(merged[0].rows.map((row) => [row.id, row]));
  assert.equal(rows.get("a").passed, 1); // fresh answer replaces the cached one
  assert.equal(rows.get("b").passed, 1); // untouched cached rows survive
});

test("measurePresets restores cached rows and only asks for missing items", async () => {
  let asked = 0;
  const evaluate = async (settings, itemIds) => {
    asked += itemIds.length;
    return {
      prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 5, outputTokens: 2 })),
      memoryBytes: 1,
      gpuVram: 0,
    };
  };
  const freshAnswers = [];
  const load = { contextSize: 16384 };
  const presets = { code: settingsOf({ maxTokens: 32 }) };
  const rungs = { code: [["a", "b"], ["a", "b", "c", "d"]] };

  await measurePresets({ evaluate, load, presets, rungs }); // first pass asks everything
  assert.equal(asked, 4);

  asked = 0;
  const restored = await measurePresets({
    evaluate,
    load,
    presets,
    rungs,
    restore: [{ settings: { ...load, ...presets.code }, seed: 42, rows: [
      { id: "a", passed: 1, total: 1, ms: 5, outputTokens: 2 },
      { id: "b", passed: 1, total: 1, ms: 5, outputTokens: 2 },
    ] }],
    onAnswers: (settings, seed, rows) => freshAnswers.push({ settings, seed, rows }),
  });
  assert.equal(asked, 2); // only c and d are missing from the cache
  assert.equal(freshAnswers.length, 1);
  assert.deepEqual(freshAnswers[0].rows.map((row) => row.id), ["c", "d"]);
  assert.equal(restored.code.rate, 100);
});

test("gateCacheFile lives under the gitignored results directory", () => {
  const file = gateCacheFile(path.join("c:", "repo", "modelduck"), "qwen-0.5b");
  assert.equal(path.basename(file), "qwen-0.5b.json");
  assert.ok(file.includes(path.join("benchmarks", "results", "gate-cache")));
});

// IDEA-1765: the gate asks a rotating tripwire window first; only a drift
// signal spends the rest of the rung. The answer cache makes the escalation
// free for items the probe already measured.
import { probeDisagrees, tripwireWindow } from "../benchmarks/gate-cache.mjs";
import { compareToBaseline } from "../benchmarks/tune-baseline.mjs";

test("tripwireWindow rotates a fixed-size window over the rung", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(tripwireWindow(ids, 0, 2), ["a", "b"]);
  assert.deepEqual(tripwireWindow(ids, 1, 2), ["c", "d"]);
  assert.deepEqual(tripwireWindow(ids, 3, 2), ["a", "b"]); // wraps
  assert.equal(tripwireWindow(ids, 0, 6), null); // a full-rung task needs no probe
});

test("probeDisagrees escalates on any flip or missing baseline outcome", () => {
  const saved = { "a": 1, "b": 0 };
  assert.equal(probeDisagrees(saved, { "a": 1, "b": 0 }), false); // clean
  assert.equal(probeDisagrees(saved, { "a": 0, "b": 0 }), true); // a pass became a fail
  assert.equal(probeDisagrees(saved, { "a": 1 }), false); // a smaller clean window is fine
  assert.equal(probeDisagrees({ "a": 1 }, { "a": 1, "z": 1 }), true); // a checked item the baseline never measured
  assert.equal(probeDisagrees(null, { "a": 1 }), true); // no baseline outcomes: full rung
});

test("measurePresets asks only the probe when no drift shows", async () => {
  const asked = [];
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 0, total: 1, ms: 1, outputTokens: 1 })),
    memoryBytes: 1,
    gpuVram: 0,
  });
  const measured = await measurePresets({
    evaluate: (settings, itemIds) => { asked.push(...itemIds); return evaluate(settings, itemIds); },
    load: {},
    presets: { code: { maxTokens: 32 } },
    rungs: { code: [["a", "b"], ["a", "b", "c", "d"]] },
    tripwire: (task, allIds) => tripwireWindow(allIds, 0, 2),
    escalate: () => false,
  });
  assert.deepEqual(asked, ["a", "b"]); // the rest of the rung is never asked
  assert.equal(measured.code.items, 2);
  assert.equal(measured.code.tripwire.checkedItems, 2);
  assert.equal(measured.code.tripwire.of, 4);
  assert.equal(measured.code.tripwire.escalated, undefined);
});

test("measurePresets escalates to the full rung on a drift signal", async () => {
  const asked = [];
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 0, total: 1, ms: 1, outputTokens: 1 })),
    memoryBytes: 1,
    gpuVram: 0,
  });
  const measured = await measurePresets({
    evaluate: (settings, itemIds) => { asked.push(...itemIds); return evaluate(settings, itemIds); },
    load: {},
    presets: { code: { maxTokens: 32 } },
    rungs: { code: [["a", "b"], ["a", "b", "c", "d"]] },
    tripwire: (task, allIds) => tripwireWindow(allIds, 0, 2),
    escalate: () => true,
  });
  assert.deepEqual(asked, ["a", "b", "c", "d"]); // probe first, then the rest of the rung
  assert.equal(measured.code.items, 4);
  assert.equal(measured.code.tripwire.escalated, true);
});

test("measurePresets reports reused and fresh answer counts", async () => {
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 5, outputTokens: 2 })),
    memoryBytes: 1,
    gpuVram: 0,
  });
  const first = await measurePresets({
    evaluate, load: {}, presets: { code: { maxTokens: 32 } }, rungs: { code: [["a", "b", "c", "d"]] },
  });
  assert.equal(first.freshAnswers, 4);
  const second = await measurePresets({
    evaluate, load: {}, presets: { code: { maxTokens: 32 } }, rungs: { code: [["a", "b", "c", "d"]] },
    restore: [{ settings: { maxTokens: 32 }, seed: 42, rows: [
      { id: "a", passed: 1, total: 1, ms: 5, outputTokens: 2 },
      { id: "b", passed: 1, total: 1, ms: 5, outputTokens: 2 },
    ] }],
  });
  assert.equal(second.reusedAnswers, 2); // the two restored rows served the rung
  assert.equal(second.freshAnswers, 2); // the two missing rows went to the model
});

test("a clean tripwire row passes on the checked subset with full tolerance honesty", () => {
  const baselineEntryTask = {
    settings: {},
    rate: 50,
    items: 4,
    latencyMs: 100,
    outcomes: { "a": 1, "b": 1, "c": 0, "d": 0 },
  };
  const baseline = { models: { m: { tasks: { code: baselineEntryTask } } } };
  const current = { m: { code: {
    rate: 100, items: 2, latencyMs: 90, outcomes: { "a": 1, "b": 1 },
    tripwire: { checkedItems: 2, of: 4 },
  } } };
  const comparison = compareToBaseline(baseline, current, { toleranceItems: 1 });
  const row = comparison.rows[0];
  assert.equal(comparison.passed, true);
  assert.equal(row.regression, false);
  assert.equal(row.baselineRate, 100); // the baseline rate on the checked subset
  assert.equal(row.rate, 100);
  assert.equal(row.delta, 0);
  assert.equal(row.tolerance, 50); // one item out of the two checked
  assert.equal(row.tripwire.checked, 2);
  assert.equal(row.tripwire.of, 4);
});

test("a clean tripwire row never invents a delta from a seed-fractional probe rate", () => {
  // Same per-item majorities, but the probe's fractional rate (seed-averaged
  // partial credit) differs from the baseline's majority-based rate: the row
  // must compare majorities on both sides, so a clean check shows delta 0.
  const baselineEntryTask = { settings: {}, rate: 50, items: 2, latencyMs: 100, outcomes: { "a": 1, "b": 0 } };
  const baseline = { models: { m: { tasks: { code: baselineEntryTask } } } };
  const current = { m: { code: {
    rate: 33.3, items: 2, latencyMs: 90, outcomes: { "a": 1, "b": 0 },
    tripwire: { checkedItems: 2, of: 2 },
  } } };
  const row = compareToBaseline(baseline, current, { toleranceItems: 1 }).rows[0];
  assert.equal(row.regression, false);
  assert.equal(row.delta, 0); // majority basis on both sides: no fake delta
  assert.equal(row.baselineRate, 50);
  assert.equal(row.rate, 50);
});

test("an escalated tripwire row compares exactly like an old full-run row", () => {
  const baselineEntryTask = { settings: {}, rate: 100, items: 4, latencyMs: 100, outcomes: { "a": 1, "b": 1, "c": 1, "d": 1 } };
  const baseline = { models: { m: { tasks: { code: baselineEntryTask } } } };
  const full = { m: { code: { rate: 50, items: 4, latencyMs: 90, outcomes: { "a": 1, "b": 1, "c": 0, "d": 0 } } } };
  const escalated = { m: { code: { rate: 50, items: 4, latencyMs: 90, outcomes: { "a": 1, "b": 1, "c": 0, "d": 0 }, tripwire: { checkedItems: 2, of: 4, escalated: true } } } };
  const asBefore = compareToBaseline(baseline, full, { toleranceItems: 1 }).rows[0];
  const row = compareToBaseline(baseline, escalated, { toleranceItems: 1 }).rows[0];
  // The escalation adds only its own annotation; every verdict field is the
  // full-run comparison the gate always made.
  const { tripwire, ...verdict } = row;
  assert.deepEqual(verdict, asBefore);
  assert.equal(tripwire.escalated, true);
  assert.equal(tripwire.checked, 2);
  assert.equal(tripwire.of, 4);
  assert.equal(row.baselineRate, 100);
});
