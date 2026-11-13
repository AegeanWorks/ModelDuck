import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluator } from "../benchmarks/tune-evaluate.mjs";
import { createPhaseTimer, formatTiming } from "../benchmarks/tune-timing.mjs";

/** A clock the test advances by hand, so no test sleeps. */
function fakeClock() {
  let now = 0;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  return clock;
}

test("the timer sums each phase and keeps the remainder as other", async () => {
  const clock = fakeClock();
  const timer = createPhaseTimer({ clock });
  await timer.measure("load", async () => clock.advance(1000));
  await timer.measure("generate", async () => clock.advance(6000));
  await timer.measure("judge", async () => clock.advance(500));
  clock.advance(500);
  timer.count("answers", 12);
  const summary = timer.summary();
  assert.equal(summary.wallMs, 8000);
  assert.deepEqual(summary.phases, { load: 1000, generate: 6000, judge: 500, other: 500 });
  assert.equal(summary.counts.answers, 12);
  assert.equal(summary.overlapped, false);
});

test("a phase that throws is still recorded, and the error is not swallowed", async () => {
  const clock = fakeClock();
  const timer = createPhaseTimer({ clock });
  await assert.rejects(() => timer.measure("generate", async () => { clock.advance(300); throw new Error("boom"); }), /boom/);
  assert.equal(timer.summary().phases.generate, 300);
});

test("concurrent phases add up past wall time and are flagged as overlapped", async () => {
  const clock = fakeClock();
  const timer = createPhaseTimer({ clock });
  // Two answers start together and end together: 1 s of wall time, 2 s of summed work.
  let releaseFirst;
  let releaseSecond;
  const first = timer.measure("generate", () => new Promise((resolve) => { releaseFirst = resolve; }));
  const second = timer.measure("generate", () => new Promise((resolve) => { releaseSecond = resolve; }));
  clock.advance(1000);
  releaseFirst();
  releaseSecond();
  await Promise.all([first, second]);
  const summary = timer.summary();
  assert.equal(summary.wallMs, 1000);
  assert.equal(summary.phases.generate, 2000);
  assert.equal(summary.overlapped, true);
  assert.equal(summary.phases.other, 0, "other never goes negative");
});

test("an unknown phase is refused so a typo cannot hide time", () => {
  const timer = createPhaseTimer({ clock: fakeClock() });
  assert.throws(() => timer.measure("genarate", async () => {}), (error) => error.code === "timing_phase_unknown");
});

test("the one-line report names the share of every phase and the model loads", async () => {
  const clock = fakeClock();
  const timer = createPhaseTimer({ clock });
  await timer.measure("load", async () => clock.advance(2000));
  await timer.measure("generate", async () => clock.advance(7000));
  await timer.measure("judge", async () => clock.advance(1000));
  timer.count("loads", 3);
  timer.count("answers", 40);
  const text = formatTiming(timer.summary());
  assert.match(text, /^Time 10s/);
  assert.match(text, /generate 70%/);
  assert.match(text, /load 20%/);
  assert.match(text, /judge 10%/);
  assert.match(text, /3 model loads/);
  assert.match(text, /40 answers/);
});

test("the report flags overlapped phases instead of printing shares above 100%", () => {
  const text = formatTiming({ wallMs: 1000, phases: { load: 0, generate: 2000, judge: 0, other: 0 }, counts: { answers: 4, loads: 1 }, overlapped: true });
  assert.match(text, /overlapped/);
  assert.doesNotMatch(text, /generate 200%/);
});

test("the evaluator times load, generate and judge, counts answers and loads", async () => {
  const clock = fakeClock();
  const timer = createPhaseTimer({ clock });
  const engine = {
    async load() { clock.advance(900); },
    async reconfigure() { clock.advance(70); },
    async status() { return { memory: { cpuRam: 1, gpuVram: 0 } }; },
    async chat() { clock.advance(400); return { text: "0", stats: { ms: 400 } }; },
    dropSession() {},
  };
  const evaluate = createEvaluator({ engine, modelId: "m1", timer });
  const settings = { contextSize: 4096, threads: 4, batchSize: 512, kvCache: "f16", temperature: 0, maxTokens: 8 };
  await evaluate(settings, ["read-sumTo-1", "read-sumTo-2"], 42);
  await evaluate({ ...settings, threads: 8 }, ["read-sumTo-1"], 42);
  const summary = timer.summary();
  assert.equal(summary.counts.answers, 3);
  assert.equal(summary.counts.loads, 1, "one full load");
  assert.equal(summary.counts.reconfigures, 1, "one in-place reconfigure");
  assert.ok(summary.phases.generate >= 1200, "three 400 ms chats");
  assert.ok(summary.phases.load >= 970, "load plus reconfigure");
  assert.ok(summary.phases.judge >= 0);
});

test("an evaluator without a timer behaves as before", async () => {
  const engine = {
    async load() {}, async reconfigure() {}, async status() { return { memory: null }; },
    async chat() { return { text: "0", stats: { ms: 5 } }; }, dropSession() {},
  };
  const evaluate = createEvaluator({ engine, modelId: "m1" });
  const out = await evaluate({ contextSize: 4096, threads: 4, batchSize: 512, kvCache: "f16", temperature: 0, maxTokens: 8 }, ["read-sumTo-1"], 1);
  assert.equal(out.prompts.length, 1);
});
