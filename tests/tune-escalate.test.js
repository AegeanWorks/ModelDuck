import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TUNE_OPTIONS, tune } from "../benchmarks/tune.mjs";
import { profileFromTune } from "../src/model-profiles.js";

const ids = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
const BASE = { contextSize: 4096, kvCache: "f16", threads: 8, temperature: 0, maxTokens: 256, level: "base" };

/**
 * The search rung has 8 items: "good" solves 2 more than "base" there, which is
 * not significant (exact p = 0.5). On the fresh pool items the search never used,
 * "good" solves `freshGain` more (and never fewer).
 */
function scenario({ freshGain, fresh = 20 }) {
  const rung = ids("rung", 8);
  const unused = ids("unused", fresh);
  const asked = [];
  const evaluate = async (settings, itemIds) => {
    asked.push(...itemIds.map((id) => `${settings.level}:${id}`));
    return {
      prompts: itemIds.map((id) => {
        const index = Number(id.split("-")[1]);
        const good = settings.level === "good";
        const solved = id.startsWith("rung") ? (index < 3 || (good && index < 5)) : (index < 5 || (good && index < 5 + freshGain));
        return { id, passed: solved ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: `${settings.level}-${id}` };
      }),
    };
  };
  const run = (options = {}) => tune({
    evaluate,
    base: BASE,
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { math: [rung], final: { math: [...rung, ...unused] } },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [{ name: "level", patches: ["base", "good"].map((value) => ({ level: value })) }],
    options: { seeds: [42], passes: 1, changeAlpha: 0.2, ...options },
  });
  return { run, asked };
}

test("escalation is off by default, so the default search is unchanged", async () => {
  assert.equal(DEFAULT_TUNE_OPTIONS.escalate, false);
  const { run } = scenario({ freshGain: 8 });
  const done = await run();
  const sweep = done.sweeps.find((item) => item.axis === "level");
  assert.equal(done.tasks.math.settings.level, "base", "an unproven leader is kept out, as before");
  assert.match(sweep.kept, /short of the p/);
  assert.equal(sweep.escalation, undefined);
});

test("with escalation an unproven leader that clearly wins on fresh items stands", async () => {
  const { run } = scenario({ freshGain: 8 });
  const done = await run({ escalate: true });
  const sweep = done.sweeps.find((item) => item.axis === "level");
  assert.equal(done.tasks.math.settings.level, "good");
  assert.equal(sweep.changed, true);
  assert.equal(sweep.escalation.items, 20, "every unused pool item is asked");
  assert.equal(sweep.escalation.confirmed, true);
  assert.deepEqual({ b: sweep.escalation.b, c: sweep.escalation.c }, { b: 0, c: 8 }, "decided on the fresh items alone");
  assert.ok(sweep.escalation.pValue <= 0.2);
  assert.equal(sweep.kept, undefined, "nothing was kept back");
});

test("a saved profile names the settings that won only through escalation", async () => {
  const { run } = scenario({ freshGain: 8 });
  const escalated = profileFromTune(await run({ escalate: true }), { catalogId: "m", fingerprint: {} });
  assert.deepEqual(escalated.tasks.math.escalated, ["level"], "a later reader can tell this setting passed on fresh items, not the rung gate");
  const plain = profileFromTune(await scenario({ freshGain: 8 }).run(), { catalogId: "m", fingerprint: {} });
  assert.equal("escalated" in plain.tasks.math, false, "a default tune's profile is unchanged");
  const refused = profileFromTune(await scenario({ freshGain: 0 }).run({ escalate: true }), { catalogId: "m", fingerprint: {} });
  assert.equal("escalated" in refused.tasks.math, false, "an escalation that did not stand marks nothing");
});

test("an escalated leader that does not win on fresh items is kept out, and says why", async () => {
  const { run } = scenario({ freshGain: 0 });
  const done = await run({ escalate: true });
  const sweep = done.sweeps.find((item) => item.axis === "level");
  assert.equal(done.tasks.math.settings.level, "base");
  assert.equal(sweep.escalation.confirmed, false);
  assert.match(sweep.kept, /fresh items/);
});

test("a small edge on fresh items is not enough: one fresh win out of one is not evidence", async () => {
  const { run } = scenario({ freshGain: 1 });
  const done = await run({ escalate: true });
  assert.equal(done.tasks.math.settings.level, "base", "c=1 b=0 has a one-sided p of 0.5");
});

test("without enough unused pool items there is nothing to escalate on", async () => {
  const { run } = scenario({ freshGain: 6, fresh: 6 });
  const done = await run({ escalate: true });
  const sweep = done.sweeps.find((item) => item.axis === "level");
  assert.equal(done.tasks.math.settings.level, "base");
  assert.equal(sweep.escalation, undefined);
});

// --- the label describes the final value (reforge run-1, stage 6) --------------------------

const labelFor = (sweeps, settings) => profileFromTune(
  { load: { settings: {} }, tasks: { math: { settings, stats: null } }, sweeps, runs: 0, budgetExhausted: false },
  { catalogId: "m", fingerprint: {} },
).tasks.math.escalated ?? null;
const win = (axis, winner, pass, escalated = false) => ({ task: "math", stage: "sampling", axis, pass, changed: true, winner, ...(escalated && { escalation: { confirmed: true } }) });

test("an escalated win is labelled while it is the setting's final value", () => {
  assert.deepEqual(labelFor([win("level", { level: "good" }, 1, true)], { level: "good" }), ["level"]);
});

test("a later plain change to the same setting removes the label", () => {
  const sweeps = [win("level", { level: "good" }, 1, true), win("level", { level: "final" }, 2)];
  assert.equal(labelFor(sweeps, { level: "final" }), null, "the final value did not come from escalation");
});

test("another axis that overwrites the same setting removes the label too", () => {
  const sweeps = [win("level", { level: "good" }, 1, true), win("preset", { level: "preset-value" }, 2)];
  assert.equal(labelFor(sweeps, { level: "preset-value" }), null);
});

test("a pair axis keeps the label for the setting it still owns", () => {
  const sweeps = [win("pair:a+b", { a: 1, b: 2 }, 1, true), win("b", { b: 3 }, 2)];
  assert.deepEqual(labelFor(sweeps, { a: 1, b: 3 }), ["pair:a+b"], "the pair still decided a, though not b");
});

test("a value that was changed back outside the sweeps is not labelled", () => {
  // A shared-stage revert can put a setting back after the sweep that chose it.
  assert.equal(labelFor([win("level", { level: "good" }, 1, true)], { level: "base" }), null);
});

test("an axis is listed once, however many keys it owns or sweeps it won", () => {
  const sweeps = [win("pair:a+b", { a: 1, b: 2 }, 1, true), win("pair:a+b", { a: 1, b: 2 }, 2, true)];
  assert.deepEqual(labelFor(sweeps, { a: 1, b: 2 }), ["pair:a+b"]);
});
