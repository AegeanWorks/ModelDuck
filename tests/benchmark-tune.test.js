import assert from "node:assert/strict";
import test from "node:test";

import { promptAxes } from "../benchmarks/tune-grid.mjs";
import { Measurements } from "../benchmarks/tune-measure.mjs";
import { predictWeightedMs, speedStage, taskProfiles } from "../benchmarks/tune-speed.mjs";
import { measurePresets, tune } from "../benchmarks/tune.mjs";

const ids = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
const RUNGS = {
  load: [ids("mix", 4), ids("mix", 8)],
  speed: [ids("speed", 6)],
  math: [ids("math", 4), ids("math", 8)],
  recall: [ids("recall", 4), ids("recall", 6)],
};
const BASE = {
  contextSize: 4096, kvCache: "f16", flashAttention: "auto", threads: 16,
  temperature: 0.7, maxTokens: 256, minP: 0.05, systemPrompt: "Be precise.", reasoning: "off", promptRepeat: 1,
};
const AXES = {
  qualityAxes: [
    { name: "contextSize", patches: [2048, 4096, 8192].map((contextSize) => ({ contextSize })) },
    { name: "kvCache", patches: ["f16", "q8_0", "q4_0"].map((kvCache) => ({ kvCache })) },
  ],
  speedAxes: [
    { name: "flashAttention", patches: ["on", "off"].map((flashAttention) => ({ flashAttention })) },
    { name: "threads", patches: [1, 2, 4, 8].map((threads) => ({ threads })) },
  ],
  samplingAxes: () => [
    { name: "temperature", patches: [0, 0.2, 0.6].map((temperature) => ({ temperature })) },
    { name: "maxTokens", patches: [64, 128, 256, 512].map((maxTokens) => ({ maxTokens })) },
    { name: "minP", patches: [0, 0.1].map((minP) => ({ minP })), greedyNoop: true },
  ],
  promptAxes: [
    { name: "systemPrompt", patches: ["Be precise.", "Think from first principles.", "Embrace ambiguity."].map((systemPrompt) => ({ systemPrompt })), full: true },
    { name: "reasoning", patches: ["off", "auto"].map((reasoning) => ({ reasoning })) },
    { name: "promptRepeat", patches: [1, 2].map((promptRepeat) => ({ promptRepeat })) },
  ],
};

/** A model whose best settings at every stage are known. */
function syntheticModel() {
  const calls = [];
  const evaluate = async (settings, itemIds, seed) => {
    calls.push({ settings, itemIds, seed });
    const threads = Math.min(settings.threads, 8);
    const slowCores = settings.threads > 8 ? 200 : 0;
    return {
      memoryBytes: settings.contextSize * 1000,
      prompts: itemIds.map((id) => {
        let passed = true;
        if (id.startsWith("recall") || id === "mix-3") passed = settings.contextSize >= 8192;
        if (id === "mix-1" && settings.kvCache === "q4_0") passed = false;
        if (id.startsWith("math")) {
          const budget = settings.maxTokens ?? 512;
          passed = settings.temperature <= 0.2 && budget >= 128 && !(settings.temperature === 0.2 && seed === 7 && id === "math-0");
          if (id === "math-7") passed = passed && settings.systemPrompt === "Think from first principles.";
        }
        const extra = (settings.reasoning === "auto" ? 20 : 0) + (settings.promptRepeat === 2 ? 10 : 0);
        return {
          id,
          passed: passed ? 1 : 0,
          total: 1,
          ms: (settings.flashAttention === "off" ? 400 : 1000) / threads + slowCores + id.length,
          tokensPerSecond: threads * 5,
          outputTokens: (settings.maxTokens ?? 200) / 2 + extra,
          digest: `${id}:${settings.flashAttention === "off" ? "rounded" : "same"}`,
        };
      }),
    };
  };
  return { evaluate, calls };
}

function run(overrides = {}) {
  const model = syntheticModel();
  const result = tune({
    evaluate: model.evaluate,
    base: BASE,
    tasks: ["math", "recall"],
    rungs: RUNGS,
    hardware: { logicalCores: 12 },
    ...AXES,
    // These tests check selection mechanics on 4-8 items, so the significance rule is off (any gain counts); it has its own tests.
    options: { seeds: [42, 7, 1234], passes: 2, changeAlpha: Infinity },
    ...overrides,
  });
  return { model, result };
}

test("stage 1 picks the smallest context recall needs and keeps the KV cache that loses nothing", async () => {
  const { load, stages } = await run().result;
  assert.equal(load.settings.contextSize, 8192);
  assert.equal(load.settings.kvCache, "f16", "q8_0 was no faster and q4_0 lost an item");
  assert.equal(stages.quality, "done");
});

test("stage 2 picks the fastest threads, excludes only pass/fail flips, and offers a Light preset", async () => {
  const { load, speed, sweeps } = await run().result;
  assert.equal(load.settings.threads, 8);
  // Flash off is faster and only changes rounding text, not pass/fail (M3), so it wins now.
  assert.equal(load.settings.flashAttention, "off", "text-only rounding no longer excludes a faster setting");
  const flash = sweeps.find((sweep) => sweep.stage === "speed" && sweep.axis === "flashAttention");
  const off = flash.rungs[0].candidates.find((candidate) => candidate.patch.flashAttention === "off");
  assert.ok(off.changedItems.length > 0, "the text change is still recorded");
  assert.deepEqual(off.flippedItems, [], "but no item flipped pass/fail");
  assert.equal(speed.fastest.threads, 8);
  assert.equal(speed.light.threads, 4, "the fastest at no more than half of 12 threads");
  assert.equal(speed.quiet.threads, 2, "the fastest at no more than a quarter of 12 threads");
});

test("the tune never starts above three quarters of the logical threads", async () => {
  const { model, result } = run();
  await result;
  assert.ok(model.calls.every((call) => call.settings.threads <= 9));
});

test("code sampling starts with the newline penalty off", async () => {
  const model = syntheticModel();
  const rungs = { ...RUNGS, code: [ids("c", 4), ids("c", 8)] };
  await tune({
    evaluate: model.evaluate, base: BASE, tasks: ["code"], rungs,
    hardware: { logicalCores: 12 }, ...AXES,
    options: { seeds: [42, 7, 1234], passes: 1, changeAlpha: Infinity },
  });
  const codeCalls = model.calls.filter((call) => call.itemIds.some((id) => id.startsWith("c-")));
  assert.ok(codeCalls.length > 0, "code items were measured");
  assert.ok(
    codeCalls.some((call) => call.settings.penalizeNewLine === false),
    "code answers are measured with the newline penalty off (lit review §2)",
  );
});

test("stage 3 tunes sampling per task by quality, then answer length, and skips no-op axes when greedy", async () => {
  const { tasks, sweeps } = await run().result;
  assert.equal(tasks.math.settings.temperature, 0, "0.2 lost an item on one seed");
  assert.equal(tasks.math.settings.maxTokens, 128, "the shortest budget that keeps every item");
  const minP = sweeps.find((sweep) => sweep.task === "math" && sweep.axis === "minP");
  assert.match(minP.skippedReason, /temperature 0/);
  assert.equal(tasks.recall.settings.maxTokens, 64);
});

test("stage 4 scores every system prompt on the task's full set, then tunes reasoning and repetition", async () => {
  const { tasks, sweeps } = await run().result;
  assert.equal(tasks.math.settings.systemPrompt, "Think from first principles.");
  assert.equal(tasks.math.settings.reasoning, "off", "reasoning added tokens without quality");
  assert.equal(tasks.math.settings.promptRepeat, 1);
  assert.equal(tasks.math.stats.rate, 100);
  const prompts = sweeps.find((sweep) => sweep.task === "math" && sweep.axis === "systemPrompt");
  assert.equal(prompts.full, true);
  assert.equal(prompts.rungs.length, 1);
  assert.equal(prompts.rungs[0].size, 8);
  assert.equal(prompts.rungs[0].candidates.length, 3, "no prompt is eliminated early");
});

test("a guardrail stops the remaining tasks below the saved baseline", async () => {
  const { result } = run({ guard: true, baseline: { math: 101 } });
  const done = await result;
  assert.equal(done.guard?.task, "math");
  assert.equal(done.guard?.baselineRate, 101);
  assert.equal(done.guard?.rate, 100);
});

test("only the chosen stages run, and only tuned keys are stored, so the rest stay default", async () => {
  const { model, result } = run({ stages: ["quality"] });
  const done = await result;
  assert.deepEqual(done.load.settings, { contextSize: 8192, kvCache: "f16" });
  assert.equal(done.stages.speed, "pending");
  assert.deepEqual(done.tasks, {});
  assert.ok(model.calls.every((call) => call.itemIds[0].startsWith("mix")));
});

test("a resumed tune continues after the finished stages without measuring them again", async () => {
  const first = await run({ stages: ["quality"] }).result;
  const { model, result } = run({ resume: { ...first.progress, sweeps: first.sweeps } });
  const done = await result;
  assert.equal(model.calls.filter((call) => call.itemIds[0].startsWith("mix")).length, 0);
  assert.equal(done.load.settings.contextSize, 8192);
  assert.equal(done.stages.speed, "done");
  assert.equal(done.tasks.math.settings.systemPrompt, "Think from first principles.");
  assert.ok(done.sweeps.length > first.sweeps.length, "earlier sweeps are kept");
});

test("a sampler change makes the prompt unproven and measures it again on the new sampler", async () => {
  const sampledModel = () => {
    const calls = [];
    const evaluate = async (settings, itemIds, seed) => {
      calls.push({ settings, itemIds, seed });
      return {
        memoryBytes: 1,
        prompts: itemIds.map((id) => {
          // The default prompt only answers greedy; the two tuned prompts split
          // at the temperature boundary, so the best prompt depends on the sampler.
          const pass =
            settings.systemPrompt === "Be precise." || settings.systemPrompt === "cool"
              ? settings.temperature <= 0.1
              : settings.temperature > 0.1;
          return { id, passed: pass ? 1 : 0, total: 1, ms: 1, tokensPerSecond: 1, outputTokens: 1, digest: id };
        }),
      };
    };
    return { evaluate, calls };
  };
  const axes = (temperatures) => ({
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [{ name: "temperature", patches: temperatures.map((temperature) => ({ temperature })) }],
    promptAxes: [
      {
        name: "systemPrompt",
        patches: ["Be precise.", "warm", "cool"].map((systemPrompt) => ({ systemPrompt })),
        full: true,
      },
    ],
  });
  const stageArgs = (evaluate, temperatures, extra = {}) => ({
    evaluate,
    base: BASE,
    tasks: ["math"],
    rungs: RUNGS,
    stages: ["sampling", "prompt"],
    ...axes(temperatures),
    options: { seeds: [42, 7, 1234], passes: 1, changeAlpha: Infinity },
    ...extra,
  });

  const firstModel = sampledModel();
  const first = await tune(stageArgs(firstModel.evaluate, [0.4]));
  assert.equal(first.tasks.math.settings.systemPrompt, "warm", "above T 0.1 the warm prompt wins");
  assert.equal(first.stages.prompt.math, "done");
  assert.equal(first.progress.prompt.math.sampledWith, JSON.stringify({ temperature: 0.7 }));

  // Resuming with the same sampler does not re-measure the prompt.
  const sameModel = sampledModel();
  await tune(stageArgs(sameModel.evaluate, [0.4], { resume: { ...first.progress, sweeps: first.sweeps } }));
  assert.equal(sameModel.calls.length, 0, "nothing was measured again");

  // A sampling-only re-tune changes the sampler and leaves the prompt pending.
  const secondModel = sampledModel();
  const second = await tune(
    stageArgs(secondModel.evaluate, [0], {
      stages: ["sampling"],
      only: ["temperature"],
      resume: { ...first.progress, sweeps: first.sweeps },
    }),
  );
  assert.equal(second.tasks.math.settings.temperature, 0);
  assert.equal(second.stages.prompt.math, "pending", "the old prompt choice is unproven on the new sampler");
  assert.equal(second.tasks.math.settings.systemPrompt, "warm", "the unproven prompt is still stored until re-measured");
  assert.equal(secondModel.calls.some((call) => call.settings.systemPrompt === "cool"), false);

  // The next run measures it on T 0, where the old prompt fails, and moves to
  // one that passes.
  const thirdModel = sampledModel();
  const third = await tune(stageArgs(thirdModel.evaluate, [0], { resume: { ...second.progress, sweeps: second.sweeps } }));
  assert.equal(third.stages.prompt.math, "done");
  assert.notEqual(third.tasks.math.settings.systemPrompt, "warm", "the prompt was re-measured at T 0");
  assert.ok(
    thirdModel.calls.some((call) => call.settings.temperature === 0 && call.settings.systemPrompt === "cool"),
    "the prompt candidates were measured on the new sampler",
  );
  assert.equal(third.progress.prompt.math.sampledWith, JSON.stringify({ temperature: 0 }));
});

test("progress is reported after every axis, so a stopped tune keeps what it found", async () => {
  const states = [];
  await run({ onProgress: (state) => states.push(structuredClone(state)) }).result;
  const afterContext = states.find((state) => state.quality.done.includes("1:contextSize"));
  assert.equal(afterContext.quality.status, "partial");
  assert.deepEqual(afterContext.quality.settings, { contextSize: 8192, kvCache: "f16" });
  assert.equal(states.at(-1).prompt.recall.status, "done");
});

test("a run budget stops the tune with partial progress marked", async () => {
  const done = await run({ options: { seeds: [42, 7, 1234], passes: 2, maxRuns: 12, changeAlpha: Infinity } }).result;
  assert.equal(done.budgetExhausted, true);
  assert.ok(["partial", "pending"].includes(done.stages.quality));
  assert.ok(done.runs <= 12 + 8);
});

test("a rung only runs the items the previous rung did not", async () => {
  const { model, result } = run();
  await result;
  const seen = new Set();
  for (const call of model.calls) {
    for (const id of call.itemIds) {
      const key = `${JSON.stringify(call.settings)}|${call.seed}|${id}`; // aikit:allow-secret cache key
      assert.equal(seen.has(key), false, `re-ran ${key}`);
      seen.add(key);
    }
  }
});

test("the search can use fewer items while the final result still scores the whole set", async () => {
  const calls = [];
  const evaluate = async (settings, itemIds) => {
    calls.push({ settings, itemIds });
    return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })) };
  };
  const result = await tune({
    evaluate,
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { ...RUNGS, math: [ids("math", 4)], final: { math: ids("math", 8) } },
    hardware: { logicalCores: 12 },
    samplingAxes: () => [{ name: "temperature", patches: [{ temperature: 0 }] }],
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  });
  assert.equal(result.tasks.math.stats.items, 8, "the final check scores every item");
  const later = calls.find((call) => call.itemIds.includes("math-4"));
  assert.ok(later, "the final check asked for the items the search skipped");
});

test("an opt-in full final check scores the whole task, not the last rung", async () => {
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })),
  });
  const result = await tune({
    evaluate,
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { ...RUNGS, math: [ids("math", 4)], final: { math: ids("math", 4) }, full: { math: ids("math", 12) } },
    fullFinal: true,
    hardware: { logicalCores: 12 },
    samplingAxes: () => [{ name: "temperature", patches: [{ temperature: 0 }] }],
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  });
  assert.equal(result.tasks.math.stats.items, 12, "fullFinal uses the full task set");
});

test("statistics come with every candidate and every winner", async () => {
  const { sweeps, tasks } = await run().result;
  const candidate = sweeps.find((sweep) => sweep.stage === "quality").rungs[0].candidates[0];
  for (const key of ["rate", "ci95", "latencyMs", "latencySd", "outputTokens", "tokensPerSecond", "items", "seeds"]) {
    assert.ok(key in candidate, `candidate lacks ${key}`);
  }
  const temperature = sweeps.find((sweep) => sweep.task === "math" && sweep.axis === "temperature");
  assert.equal(typeof temperature.pValue, "number");
  assert.equal(temperature.speed.cost, "tokens");
  assert.deepEqual(Object.keys(tasks.math.stats.vsDefault).sort(), ["b", "c", "pValue", "rateDelta"]);
  assert.ok(tasks.math.stats.vsDefault.rateDelta > 0, "temperature 0.7 failed every math item");
});

test("impossible combinations are skipped and listed, never measured", async () => {
  const seen = [];
  const evaluate = async (settings, itemIds) => {
    seen.push({ ...settings });
    return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 100, digest: id })) };
  };
  const { sweeps } = await tune({
    evaluate,
    base: { kvCache: "q8_0", flashAttention: "on", threads: 4 },
    tasks: [],
    rungs: { load: [ids("mix", 4)], speed: [ids("speed", 4)] },
    qualityAxes: [],
    speedAxes: [{ name: "flashAttention", patches: [{ flashAttention: "on" }, { flashAttention: "off" }] }],
  });
  assert.ok(seen.every((settings) => settings.flashAttention !== "off"));
  assert.deepEqual(sweeps[0].skipped, [{ flashAttention: "off" }]);
});

test("a candidate whose load failed never wins, even against a weak incumbent", async () => {
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id, index) => settings.kvCache === "q4_0"
      ? { id, passed: 0, total: 1, error: "load failed: unsupported KV type", ms: null }
      : { id, passed: index === 0 ? 1 : 0, total: 1, ms: 1000 }),
  });
  const { load, sweeps } = await tune({
    evaluate,
    base: { kvCache: "f16" },
    tasks: [],
    rungs: { load: [ids("mix", 8)] },
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q4_0"].map((kvCache) => ({ kvCache })) }],
    speedAxes: [],
  });
  assert.equal(load.settings.kvCache, "f16", "12.5% beats a failed load within one item");
  const failed = sweeps[0].rungs[0].candidates.find((candidate) => candidate.patch.kvCache === "q4_0");
  assert.equal(failed.failed, true);
  assert.equal(failed.error, "load failed: unsupported KV type");
});

test("the one-item quality tolerance buys speed, never memory", async () => {
  const evaluate = async (settings, itemIds) => ({
    memoryBytes: settings.kvCache === "q8_0" ? 1 : 2,
    prompts: itemIds.map((id) => ({ id, passed: settings.kvCache === "q8_0" && id === "mix-0" ? 0 : 1, total: 1, ms: settings.kvCache === "q8_0" ? 100 : 1000 })),
  });
  const { load } = await tune({
    evaluate,
    base: { kvCache: "f16" },
    tasks: [],
    rungs: { load: [ids("mix", 8)] },
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q8_0"].map((kvCache) => ({ kvCache })) }],
    speedAxes: [],
  });
  assert.equal(load.settings.kvCache, "q8_0", "10x faster for one lost item of 8");
});

test("a GPU preset's VRAM counts in the memory tie-break", async () => {
  const evaluate = async (settings, itemIds) => ({
    memoryBytes: settings.kvCache === "q8_0" ? 100 : 900,
    gpuVram: settings.kvCache === "q8_0" ? 100 : 900,
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 100 })),
  });
  const { load } = await tune({
    evaluate,
    base: { kvCache: "f16" },
    tasks: [],
    rungs: { load: [ids("mix", 8)] },
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q8_0"].map((kvCache) => ({ kvCache })) }],
    speedAxes: [],
  });
  assert.equal(load.settings.kvCache, "q8_0", "the lower total host + VRAM footprint wins a tie");
});

test("a speed gap inside the measurement noise is a tie, so the incumbent stays", async () => {
  const swing = [1.4, 0.6, 1.4, 0.6, 1.3, 0.62];
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id, index) => ({ id, passed: 1, total: 1, digest: id, ms: settings.threads === 8 ? 950 * swing[index] : 1000 })),
  });
  const { load, sweeps } = await tune({
    evaluate,
    base: { threads: 4 },
    tasks: [],
    rungs: { load: [ids("mix", 2)], speed: [ids("speed", 6)] },
    hardware: { logicalCores: 16 },
    qualityAxes: [],
    speedAxes: [{ name: "threads", patches: [4, 8].map((threads) => ({ threads })) }],
  });
  assert.equal(load.settings.threads, 4);
  assert.equal(sweeps.find((sweep) => sweep.axis === "threads").speed.significant, false);
});

test("measuring saved presets scores each task's last rung with the tune's own rules", async () => {
  const model = syntheticModel();
  const measured = await measurePresets({
    evaluate: model.evaluate,
    load: { contextSize: 8192, threads: 8 },
    presets: { math: { temperature: 0, maxTokens: 128, systemPrompt: "Think from first principles." }, recall: { temperature: 0.7, maxTokens: 64 } },
    rungs: RUNGS,
  });
  assert.deepEqual(Object.keys(measured).sort(), ["math", "recall"]);
  assert.equal(measured.math.rate, 100);
  assert.equal(measured.math.items, 8);
  assert.equal(measured.recall.seeds, 3, "a non-zero temperature uses every seed");
});

/** Stage 0 alone, with a model whose device behaviour is given per backend/layers. */
async function probe(behaviour, { layers = 28 } = {}) {
  const calls = [];
  const evaluate = async (settings, itemIds) => {
    calls.push(settings);
    const key = settings.gpuBackend === "cpu" || !settings.gpuBackend ? "cpu" : `${settings.gpuBackend}:${settings.gpuLayers}`;
    const device = behaviour[key] ?? behaviour.cpu;
    return {
      prompts: itemIds.map((id, index) => device.error
        ? { id, passed: 0, total: 1, error: device.error, ms: null }
        : { id, passed: index < device.passed ? 1 : 0, total: 1, ms: device.ms * (1 + index / 20), tokensPerSecond: 1000 / device.ms, digest: id }),
    };
  };
  const result = await tune({
    evaluate,
    base: { threads: 4 },
    tasks: [],
    stages: ["device"],
    modelLayers: layers,
    rungs: { load: [ids("mix", 2)], speed: [ids("speed", 6)] },
    qualityAxes: [],
    speedAxes: [],
  });
  return { result, calls };
}

test("stage 0 moves a model to the GPU when it is faster and answers as well", async () => {
  const { result } = await probe({ cpu: { ms: 1000, passed: 5 }, "vulkan:max": { ms: 200, passed: 5 } });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: "max" });
  assert.equal(result.stages.device, "done");
  assert.match(result.device.reason, /vulkan with max layers/);
  assert.equal(result.device.probe.find((entry) => entry.patch.gpuBackend === "vulkan").verdict, "chosen");
});

test("stage 0 keeps the CPU when the GPU answers fewer items correctly", async () => {
  const { result } = await probe({ cpu: { ms: 1000, passed: 6 }, "vulkan:max": { ms: 200, passed: 5 } });
  assert.deepEqual(result.load.settings, { gpuBackend: "cpu", gpuLayers: 0 });
  assert.match(result.device.probe[1].verdict, /answered 5 of 6 correctly vs 6 on the CPU/);
});

test("stage 0 tries smaller offloads when all layers fail to load", async () => {
  const { result, calls } = await probe({ cpu: { ms: 1000, passed: 6 }, "vulkan:max": { error: "load failed: out of VRAM" }, "vulkan:21": { error: "load failed: out of VRAM" }, "vulkan:14": { ms: 500, passed: 6 } });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: 14 });
  assert.match(result.device.probe[1].verdict, /did not run: load failed: out of VRAM/);
  assert.match(result.device.probe[2].verdict, /did not run: load failed: out of VRAM/);
  assert.ok(calls.some((settings) => settings.gpuLayers === 14));
});

test("stage 0 reaches a quarter of the layers when the larger offloads fail", async () => {
  const { result } = await probe({
    cpu: { ms: 1000, passed: 6 },
    "vulkan:max": { error: "load failed: out of VRAM" },
    "vulkan:21": { error: "load failed: out of VRAM" },
    "vulkan:14": { error: "load failed: out of VRAM" },
    "vulkan:7": { ms: 700, passed: 6 },
  });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: 7 });
});

test("stage 0 keeps the largest offload that loads and stops probing smaller ones", async () => {
  const { result, calls } = await probe({ cpu: { ms: 1000, passed: 6 }, "vulkan:max": { error: "load failed: out of VRAM" }, "vulkan:21": { ms: 400, passed: 6 } });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: 21 });
  assert.equal(calls.some((settings) => settings.gpuLayers === 14), false, "a larger offload that loads is preferred");
});

test("stage 0 keeps the CPU when the GPU is only faster within the noise", async () => {
  const { result } = await probe({ cpu: { ms: 1000, passed: 6 }, "vulkan:max": { ms: 990, passed: 6 } });
  assert.equal(result.load.settings.gpuBackend, "cpu");
  assert.equal(result.device.probe[1].verdict, "not measurably faster than the CPU");
});

test("stage 0 compares throughput, so different answer lengths on the GPU cannot hide a real speedup", async () => {
  const lengths = [1, 8, 1, 6, 1, 9];
  const evaluate = async (settings, itemIds) => {
    const gpu = settings.gpuBackend === "vulkan";
    const speed = gpu ? 110 : 20;
    return {
      prompts: itemIds.map((id, index) => {
        const tokens = (gpu ? lengths[(index + 3) % 6] : lengths[index]) * 30;
        return { id, passed: 1, total: 1, ms: (tokens / speed) * 1000, tokensPerSecond: speed + index, digest: id };
      }),
    };
  };
  const result = await tune({
    evaluate, base: { threads: 4 }, tasks: [], stages: ["device"],
    rungs: { load: [ids("mix", 2)], speed: [ids("speed", 6)] }, qualityAxes: [], speedAxes: [],
  });
  assert.equal(result.load.settings.gpuBackend, "vulkan");
});

test("stage 0 says plainly when the CPU could not run the model at all", async () => {
  const { result } = await probe({ cpu: { error: "load failed: This model will not fit in memory" }, "vulkan:max": { ms: 300, passed: 6 } });
  assert.equal(result.load.settings.gpuBackend, "vulkan");
  assert.equal(result.device.probe[0].verdict, "did not run: load failed: This model will not fit in memory");
  assert.match(result.device.reason, /the CPU could not run it \(load failed: This model will not fit in memory\)/);
});

test("stage 0 tries a partial offload when the full one loads but is not faster (G7)", async () => {
  const { result, calls } = await probe({
    cpu: { ms: 1000, passed: 6 },
    "vulkan:max": { ms: 1000, passed: 6 },
    "vulkan:21": { ms: 300, passed: 6 },
  });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: 21 });
  assert.ok(calls.some((settings) => settings.gpuLayers === 21), "the 75% offload was tried");
});

test("the speed stage picks the task-weighted latency, not the raw 6-item latency (M4)", async () => {
  // Five short recall items plus one long code item. The challenger is much
  // faster on raw medians (prefill-bound workload) but slower where code
  // lives (decode-bound), so a code-weighted choice keeps the incumbent.
  const items = ["r-1", "r-2", "r-3", "r-4", "r-5", "c-1"];
  const itemTask = (id) => (id.startsWith("c-") ? "code" : "recall");
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => {
      const code = id.startsWith("c-");
      const fast = settings.flashAttention === "off";
      const promptTokens = code ? 200 : 1400;
      const outputTokens = code ? 400 : 10;
      // Challenger: 8000 prefill tok/s, 80 decode tok/s. Incumbent: 1000 / 100.
      const firstTokenMs = promptTokens / (fast ? 8000 : 1000) * 1000;
      const decodeMs = (outputTokens - 1) / (fast ? 80 : 100) * 1000;
      return { id, passed: 1, total: 1, ms: firstTokenMs + decodeMs, firstTokenMs, promptTokens, outputTokens, digest: id };
    }),
  });
  const context = {
    measurements: new Measurements(evaluate, 100000),
    options: { seeds: [42], passes: 1, speedTie: 0.03 },
    valid: () => true,
    onEvent: () => {},
    sweeps: [],
  };
  const axes = [{ name: "flashAttention", patches: [{ flashAttention: "on" }, { flashAttention: "off" }] }];
  const start = { temperature: 0, flashAttention: "on", threads: 8 };
  const outcome = await speedStage(context, {
    axes, start, items, forced: { temperature: 0 }, logicalCores: 12,
    itemTask, taskWeights: { code: 0.9, recall: 0.1 },
  });
  const record = context.sweeps[0];
  const [on, off] = ["on", "off"].map((value) => record.rungs[0].candidates.find((candidate) => candidate.patch.flashAttention === value));
  assert.ok(off.latencyMs < on.latencyMs, "the challenger is faster on raw medians");
  assert.deepEqual(record.taskProfiles, {
    recall: { promptTokens: 1400, outputTokens: 10 },
    code: { promptTokens: 200, outputTokens: 400 },
  });
  assert.ok(off.predictedMs.ms > on.predictedMs.ms, "but slower where the weighted tasks live");
  assert.equal(outcome.current.flashAttention, "on", "task-weighted latency keeps the incumbent");
  assert.deepEqual(record.taskWeights, { code: 0.9, recall: 0.1, comprehension: 0.25 });
});

test("task-weighted prediction falls back to latency without throughput (M4)", () => {
  assert.equal(predictWeightedMs({ latencyMs: 500 }, {}, {}), 500);
  assert.equal(predictWeightedMs({ latencyMs: 500, prefillTps: 1000, decodeTps: 100 }, {}, { code: 1 }), 500);
  const predicted = predictWeightedMs(
    { latencyMs: 500, prefillTps: 1000, decodeTps: 100 },
    { code: { promptTokens: 200, outputTokens: 400 } },
    { code: 1 },
  );
  assert.equal(predicted.ms, 4200);
});

test("the code task starts sampling greedy, and heat must prove itself (G3)", async () => {
  const seen = [];
  const result = await tune({
    evaluate: async (settings, itemIds) => {
      seen.push(settings.temperature);
      return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })) };
    },
    base: { ...BASE, temperature: 0.7 },
    tasks: ["code"],
    stages: ["sampling"],
    rungs: { code: [ids("code", 8)] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [
      { name: "temperature", patches: [{ temperature: 0 }, { temperature: 0.5 }] },
      { name: "maxTokens", patches: [{ maxTokens: 256 }] },
    ],
  });
  assert.equal(result.tasks.code.settings.temperature, 0, "nothing beat greedy");
  assert.ok(seen.includes(0.5), "higher temperatures are still tried");
  assert.equal(seen[0], 0, "but the first answers are greedy");
});

test("a quality change that breaks one function cluster does not revert the task (S4)", async () => {
  // Six inputs of one function flip, two of another do not. Item-level that
  // is a significant 6-0 loss; cluster-level it is one cluster moving.
  // The two passes come first so sequential stopping sees a live candidate.
  const items = ["g-1", "g-2", "f-1", "f-2", "f-3", "f-4", "f-5", "f-6"];
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({
      id,
      passed: settings.kvCache === "q8_0" && id.startsWith("f-") ? 0 : 1,
      total: 1,
      ms: settings.kvCache === "q8_0" ? 100 : 1000,
      tokensPerSecond: 10,
      outputTokens: 10,
      digest: id,
    })),
  });
  const quality = (clusterOf) => tune({
    evaluate,
    base: { ...BASE, kvCache: "f16" },
    tasks: ["math"],
    stages: ["quality"],
    rungs: { load: [items], loadByTask: { math: items }, math: [items] },
    hardware: { logicalCores: 12 },
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q8_0"].map((kvCache) => ({ kvCache })) }],
    speedAxes: [],
    ...(clusterOf && { clusterOf }),
    options: { seeds: [42], passes: 1, toleranceItems: 6 },
  });
  const plain = await quality(null);
  assert.equal(plain.load.reverted, "math", "item-level: six flips revert the task");
  assert.equal(plain.load.settings.kvCache, "f16");
  const clustered = await quality((id) => id.split("-")[0]);
  assert.equal(clustered.load.reverted, null, "cluster-level: one cluster moving does not revert");
  assert.equal(clustered.load.settings.kvCache, "q8_0", "the faster setting stands");
});

test("a task without rungs leaves its stages pending instead of crashing", async () => {
  const result = await tune({
    evaluate: async (settings, itemIds) => ({
      prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })),
    }),
    base: { ...BASE, threads: 8 },
    tasks: ["code"],
    stages: ["speed"],
    rungs: { speed: [ids("speed", 6)] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [{ name: "threads", patches: [{ threads: 8 }, { threads: 4 }] }],
    options: { seeds: [42], passes: 1 },
  });
  assert.deepEqual(result.load.settings.threads, 8);
  assert.equal(result.stages.sampling.code, "pending");
});

test("a KV cache that loses long-context items is rejected even when the load rungs keep it (M6)", async () => {
  // Six inputs of one function flip on q8_0 (one cluster: no per-task revert),
  // plus one long-context needle. The load rungs adopt the faster cache; the
  // long item rejects it.
  const items = ["g-1", "g-2", "f-1", "f-2", "f-3", "f-4", "f-5", "f-6"];
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({
      id,
      passed: settings.kvCache === "q8_0" && (id.startsWith("f-") || id === "L1") ? 0 : 1,
      total: 1,
      ms: settings.kvCache === "q8_0" ? 100 : 1000,
      tokensPerSecond: 10,
      outputTokens: 10,
      digest: id,
    })),
  });
  const runQuality = (longContext) => tune({
    evaluate,
    base: { ...BASE, kvCache: "f16" },
    tasks: ["math"],
    stages: ["quality"],
    rungs: { load: [items], loadByTask: { math: items }, math: [items] },
    hardware: { logicalCores: 12 },
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q8_0"].map((kvCache) => ({ kvCache })) }],
    speedAxes: [],
    clusterOf: (id) => id[0],
    longContext,
    options: { seeds: [42], passes: 1, toleranceItems: 6 },
  });
  const confirmed = await runQuality([{ id: "L1", estTokens: 100 }]);
  assert.equal(confirmed.load.reverted, null, "one cluster moving reverts no task");
  assert.equal(confirmed.load.settings.kvCache, "f16");
  assert.equal(confirmed.load.kvConfirm?.reverted, true, "the long item rejects the quantized cache");
  // Without long items the faster setting stands, as before.
  const plain = await runQuality([]);
  assert.equal(plain.load.settings.kvCache, "q8_0");
  assert.equal(plain.load.kvConfirm, undefined);
});

test("a pair of settings that only works together is found after the passes (G2)", async () => {
  const ids = Array.from({ length: 8 }, (_, index) => `m-${index + 1}`);
  const setup = (extra) => tune({
    evaluate: async (settings, itemIds) => ({
      prompts: itemIds.map((id) => ({
        id,
        passed: settings.a === 1 && settings.b === 1 ? 1 : 0,
        total: 1,
        ms: 10,
        outputTokens: 10,
        digest: `${settings.a}${settings.b}`,
      })),
    }),
    base: { a: 0, b: 0, temperature: 0 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { math: [ids] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [
      { name: "a", patches: [{ a: 0 }, { a: 1 }] },
      { name: "b", patches: [{ b: 0 }, { b: 1 }] },
    ],
    options: { seeds: [42], passes: 2 },
    ...extra,
  });
  const result = await setup({});
  assert.deepEqual(result.tasks.math.settings, { a: 1, b: 1 }, "the interaction is adopted with evidence");
  const pair = result.sweeps.find((sweep) => sweep.axis === "pair:a+b");
  assert.ok(pair, "a pair sweep ran");
  assert.equal(pair.changed, true);
  const quick = await setup({ quick: true });
  assert.ok(quick.sweeps.every((sweep) => !sweep.axis.startsWith("pair:")), "quick passes skip the pair check");
});

test("speed candidates are timed repeatedly and interleaved, with an A/A band (M2)", async () => {
  const { sweeps } = await run().result;
  const flash = sweeps.find((sweep) => sweep.stage === "speed" && sweep.axis === "threads");
  assert.equal(flash.repeats, 3);
  assert.ok(Number.isFinite(flash.aaSpread), "the incumbent's own spread is recorded");
  assert.ok(flash.speedTie >= 0.05, "the tie band never drops below 5%");
  const candidate = flash.rungs[0].candidates[0];
  assert.ok(candidate.prefillTps === null || Number.isFinite(candidate.prefillTps));
});

test("stage 0 keeps a 5x GPU that loses one speed item when the load rung ties (S7)", async () => {
  const speedCalls = [];
  const evaluate = async (settings, itemIds) => {
    const key = settings.gpuBackend === "cpu" || !settings.gpuBackend ? "cpu" : `${settings.gpuBackend}:${settings.gpuLayers}`;
    const gpu = key !== "cpu";
    // Speed items: GPU loses exactly one; load items (mix-*): both answer all.
    const passed = itemIds[0].startsWith("speed") ? (gpu ? 5 : 6) : 8;
    const ms = gpu ? 200 : 1000;
    speedCalls.push({ key, items: itemIds.length });
    return { prompts: itemIds.map((id, index) => ({ id, passed: index < passed ? 1 : 0, total: 1, ms: ms * (1 + index / 20), tokensPerSecond: 1000 / ms, digest: id })) };
  };
  const result = await tune({
    evaluate, base: { threads: 4 }, tasks: [], stages: ["device"], modelLayers: 28,
    rungs: { load: [ids("mix", 8)], speed: [ids("speed", 6)] }, qualityAxes: [], speedAxes: [],
  });
  assert.deepEqual(result.load.settings, { gpuBackend: "vulkan", gpuLayers: "max" });
  assert.ok(result.device.accuracyRecheck, "the load rung decided accuracy");
  assert.equal(result.device.accuracyRecheck.of, 8);
});

test("with parallel answers, the timing stages still answer one at a time", async () => {
  const { model, result } = run({ parallel: 4 });
  await result;
  const timed = model.calls.filter((call) => call.itemIds[0].startsWith("speed"));
  assert.ok(timed.length > 0 && timed.every((call) => call.settings.parallelism === 1));
  const quality = model.calls.filter((call) => call.itemIds[0].startsWith("mix"));
  assert.ok(quality.every((call) => call.settings.parallelism === undefined));
});

test("timing stages hold the timing lock, and only they do", async () => {
  const events = [];
  const timing = { acquire: async () => events.push("acquire"), release: async () => events.push("release") };
  const model = syntheticModel();
  const evaluate = async (settings, itemIds, seed) => {
    events.push(`${itemIds[0].split("-")[0]}${settings.timed ? ":timed" : ""}`);
    return model.evaluate(settings, itemIds, seed);
  };
  await tune({ evaluate, base: BASE, tasks: ["math"], rungs: RUNGS, hardware: { logicalCores: 12 }, ...AXES, timing });
  const held = (index) => events.slice(0, index).filter((event) => event === "acquire").length > events.slice(0, index).filter((event) => event === "release").length;
  assert.equal(events.filter((event) => event === "acquire").length, 2, "device and speed stages");
  events.forEach((event, index) => {
    if (event.endsWith(":timed")) assert.ok(held(index), `${event} ran without the lock`);
    if (event === "mix" || event === "math") assert.ok(!held(index), `${event} ran while holding the lock`);
  });
});

test("only chosen settings re-run, on top of everything else's current best", async () => {
  const first = await run().result;
  const { model, result } = run({ resume: { ...first.progress, sweeps: first.sweeps }, only: ["contextSize"] });
  const done = await result;
  const swept = done.sweeps.slice(first.sweeps.length).map((sweep) => sweep.axis);
  assert.deepEqual([...new Set(swept)], ["contextSize"]);
  assert.ok(model.calls.every((call) => call.itemIds[0].startsWith("mix")));
  assert.ok(model.calls.every((call) => call.settings.kvCache === first.load.settings.kvCache), "the other quality setting stays at its tuned value");
  assert.equal(done.stages.quality, "done", "a finished stage stays finished");
  assert.deepEqual(done.tasks.math.settings, first.tasks.math.settings);
});

test("a setting chosen on its own stores only what was measured", async () => {
  const { model, result } = run({ only: ["threads", "temperature"] });
  const done = await result;
  assert.deepEqual(Object.keys(done.load.settings), ["threads"], "flash attention was not measured, so it is not stored");
  assert.equal(done.stages.speed, "partial");
  assert.equal(done.stages.quality, "pending");
  assert.equal(done.stages.device, "pending");
  assert.deepEqual(Object.keys(done.tasks.math.settings), ["temperature"]);
  assert.equal(done.stages.sampling.math, "partial");
  assert.ok(!model.calls.some((call) => call.itemIds[0].startsWith("mix")), "no quality questions");
});

test("choosing the device re-probes it even when it was probed before", async () => {
  const first = await run({ stages: ["device"] }).result;
  const { model, result } = run({ resume: { ...first.progress, sweeps: first.sweeps }, only: ["device"] });
  const done = await result;
  assert.ok(model.calls.length > 0);
  assert.equal(done.stages.device, "done");
  assert.equal(done.stages.quality, "pending");
});

/** A prompt-only tune on 20 items where the suite prompt gets half right and each rival a known number more. */
async function promptTune(rivals) {
  const gains = { "Be precise.": 0, ...rivals };
  const items = ids("math", 20);
  return tune({
    evaluate: async (settings, itemIds) => ({
      memoryBytes: 1,
      prompts: itemIds.map((id) => {
        const index = Number(id.split("-")[1]);
        return { id, passed: index < 10 + gains[settings.systemPrompt] ? 1 : 0, total: 1, ms: 10, tokensPerSecond: 10, outputTokens: 10, digest: id };
      }),
    }),
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["prompt"],
    rungs: { ...RUNGS, math: [items] },
    hardware: { logicalCores: 12 },
    ...AXES,
    promptAxes: [{ name: "systemPrompt", patches: Object.keys(gains).map((systemPrompt) => ({ systemPrompt })), full: true }],
    options: { seeds: [42], passes: 1 },
  });
}

test("a challenger one lucky item ahead does not replace the current setting", async () => {
  const { tasks, sweeps } = await promptTune({ "Lucky guess.": 1, "Also lucky.": 1 });
  assert.equal(tasks.math.settings.systemPrompt, "Be precise.");
  const sweep = sweeps.find((entry) => entry.axis === "systemPrompt");
  assert.equal(sweep.changed, false);
  assert.match(sweep.kept, /Lucky guess\.|Also lucky\./, "the sweep says which challenger was best");
  assert.match(sweep.kept, /p=1/);
  assert.match(sweep.kept, /Holm p=1/, "the bar is Holm-adjusted over the surviving challengers");
  assert.match(sweep.kept, /p ≤ 0\.2/, "the change alpha itself is 0.2");
});

test("a challenger with a clear paired gain replaces the current setting", async () => {
  const { tasks, sweeps } = await promptTune({ "Lucky guess.": 1, "Work it out.": 10 });
  assert.equal(tasks.math.settings.systemPrompt, "Work it out.");
  const sweep = sweeps.find((entry) => entry.axis === "systemPrompt");
  assert.equal(sweep.changed, true);
  assert.equal(sweep.kept, undefined);
  assert.ok(sweep.pValue <= 0.1);
});

test("a gain measured after the losers are gone is Holm-adjusted over the survivors, not every value tried", async () => {
  // Seven prompts answer nothing and stop on the first look; two answer close to the suite prompt.
  const rivals = Object.fromEntries(Array.from({ length: 7 }, (_value, index) => [`No help ${index}.`, -10]));
  Object.assign(rivals, { "Gain five.": 5, "Gain one.": 1 });
  const { tasks, sweeps } = await promptTune(rivals);
  const sweep = sweeps.find((entry) => entry.axis === "systemPrompt");
  assert.equal(tasks.math.settings.systemPrompt, "Gain five.");
  assert.equal(sweep.changed, true);
  // 5 of 20 against 0 is p=0.0625; Holm doubles it to 0.125, past the old 0.2 / 9 but under 0.2.
  assert.equal(sweep.pValue, 0.0625);
  assert.equal(sweep.pAdjusted, 0.125);
  assert.equal(sweep.dropped.length, 7, "the seven hopeless prompts were stopped");
});

test("when nothing can load, the tune stops with the reason instead of choosing among failures", async () => {
  const calls = [];
  let answers = 0;
  const evaluate = async (settings, itemIds) => {
    calls.push(settings);
    answers += itemIds.length;
    return { prompts: itemIds.map((id) => ({ id, passed: 0, total: 1, error: "load failed: no GPU binary", ms: null })) };
  };
  const result = await tune({
    evaluate,
    base: BASE,
    tasks: ["math"],
    rungs: RUNGS,
    hardware: { logicalCores: 12 },
    ...AXES,
    options: { seeds: [42], passes: 2 },
  });
  assert.match(result.stopped, /could not load.*no GPU binary/i);
  assert.equal(result.stages.quality, "pending", "nothing is marked tuned");
  assert.equal(result.tasks.math, undefined, "no preset is made from failed answers");
  // The first rung of the first axis (with the baseline measurement), then nothing: no other axis, no later stage.
  assert.ok(calls.every((call) => call.kvCache === BASE.kvCache && call.temperature === 0), "it stops before any other axis");
  assert.ok(answers <= 2 * RUNGS.speed[0].length + AXES.qualityAxes[0].patches.length * RUNGS.load[0].length, "the two device probes and one quality rung, however chunked");
});

test("with a memory budget, the context size comes from free memory, not from short questions", async () => {
  const asked = [];
  const { model, result } = run({
    qualityAxes: [{ ...AXES.qualityAxes[0], budget: true }, AXES.qualityAxes[1]],
    contextBudget: async (settings, sizes) => {
      asked.push({ kvCache: settings.kvCache, sizes });
      return { contextSize: settings.kvCache === "q8_0" ? 8192 : 4096, reason: "4096 is the largest listed context that fits comfortably" };
    },
  });
  const { load, sweeps } = await result;
  const context = sweeps.find((sweep) => sweep.axis === "contextSize");
  assert.equal(context.budget, true);
  assert.match(context.reason, /fits comfortably/);
  assert.deepEqual(context.rungs, [], "no context size was measured on questions");
  assert.deepEqual(asked[0].sizes, [2048, 4096, 8192]);
  assert.equal(load.settings.contextSize, 4096);
  assert.ok(sweeps.some((sweep) => sweep.axis === "kvCache" && sweep.rungs.length > 0), "the KV cache is still measured");
  const contexts = new Set(model.calls.filter((call) => call.itemIds.some((id) => id.startsWith("mix"))).map((call) => call.settings.contextSize));
  assert.deepEqual([...contexts], [4096], "quality questions only ran at the budgeted size");
});

test("reasoning on is tried with room to answer, and the preset keeps that room", async () => {
  const items = ids("math", 20);
  const seen = [];
  const { tasks } = await tune({
    evaluate: async (settings, itemIds) => {
      seen.push({ reasoning: settings.reasoning, maxTokens: settings.maxTokens });
      // Thinking first helps only when the answer is not cut off.
      const thinks = settings.reasoning === "deep" && settings.maxTokens >= 1024;
      return { prompts: itemIds.map((id, index) => ({ id, passed: thinks || index < 10 ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id })) };
    },
    base: { ...BASE, temperature: 0, maxTokens: 256 },
    tasks: ["math"],
    stages: ["prompt"],
    rungs: { ...RUNGS, math: [items] },
    hardware: { logicalCores: 12 },
    ...AXES,
    promptAxes: promptAxes({ systemPrompt: ["Be precise."], reasoning: ["off", "deep"], promptRepeat: [1] }),
    options: { seeds: [42], passes: 1 },
  });
  assert.ok(seen.some((call) => call.reasoning === "deep" && call.maxTokens === 1024), "deep was tried with 1024 tokens");
  assert.equal(tasks.math.settings.reasoning, "deep");
  assert.equal(tasks.math.settings.maxTokens, 1024, "the preset keeps the room deep needs");
});

test("system prompts are screened on a quarter of the items, and only clear losers stop early", async () => {
  const items = ids("math", 48);
  const asked = new Map();
  // How many of the first items each prompt gets right; the suite prompt gets the first 30.
  const solved = { "Be precise.": 30, "Close behind.": 28, "Clearly worse.": 4 };
  const { sweeps } = await tune({
    evaluate: async (settings, itemIds) => {
      asked.set(settings.systemPrompt, [...(asked.get(settings.systemPrompt) ?? []), ...itemIds]);
      return { prompts: itemIds.map((id) => ({ id, passed: Number(id.split("-")[1]) < solved[settings.systemPrompt] ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id })) };
    },
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["prompt"],
    rungs: { ...RUNGS, math: [items] },
    hardware: { logicalCores: 12 },
    ...AXES,
    promptAxes: [{ name: "systemPrompt", patches: Object.keys(solved).map((systemPrompt) => ({ systemPrompt })), full: true }],
    options: { seeds: [42], passes: 1 },
  });
  const sweep = sweeps.find((entry) => entry.axis === "systemPrompt");
  assert.deepEqual(sweep.rungs.map((rung) => rung.size), [12, 48], "a 12-item screen, then the full set");
  assert.deepEqual(sweep.dropped.map((entry) => entry.patch.systemPrompt), ["Clearly worse."]);
  assert.equal(sweep.dropped[0].behind, 8);
  assert.equal(new Set(asked.get("Clearly worse.")).size, 12, "a dropped prompt answers only the screen");
  assert.equal(new Set(asked.get("Close behind.")).size, 48, "a close one is measured on everything");
  assert.equal(sweep.winner.systemPrompt, "Be precise.");
});

test("every newly measured answer reaches the run record once, cached ones never twice", async () => {
  let recorded = 0;
  const { model, result } = run({ onAnswers: (settings, seed, answers) => { recorded += answers.length; } });
  const done = await result;
  const measured = model.calls.reduce((sum, call) => sum + call.itemIds.length, 0);
  assert.equal(recorded, measured);
  assert.equal(recorded, done.runs);
});

/** A sampling-only tune on 12/24/48-item rungs where one temperature value answers every item. */
function earlyStopTune(correct) {
  const calls = [];
  const evaluate = async (settings, itemIds, seed) => {
    calls.push({ settings, itemIds, seed });
    return { prompts: itemIds.map((id) => ({ id, passed: correct(settings, id) ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id })) };
  };
  const result = tune({
    evaluate,
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { ...RUNGS, math: [ids("math", 12), ids("math", 24), ids("math", 48)] },
    hardware: { logicalCores: 12 },
    samplingAxes: () => [{ name: "temperature", patches: [0, 0.6].map((temperature) => ({ temperature })) }],
    options: { seeds: [42], passes: 1, changeAlpha: Infinity, stopAlpha: 0.05 },
  });
  return { calls, result };
}

test("a candidate clearly behind on a rung stops there, and the sweep ends when only the current setting is left", async () => {
  const { calls, result } = earlyStopTune((settings) => settings.temperature === 0);
  const { tasks, sweeps } = await result;
  const sweep = sweeps.find((entry) => entry.axis === "temperature");
  assert.deepEqual(sweep.rungs.map((rung) => rung.size), [12], "the sweep ended on the first rung");
  assert.match(sweep.endedEarly, /only the current setting is left/);
  assert.deepEqual(sweep.dropped.map((entry) => entry.patch.temperature), [0.6]);
  assert.ok(sweep.dropped[0].of < 12, "the loser stopped before the rung ended");
  assert.equal(typeof sweep.dropped[0].p, "number");
  assert.equal(sweep.changed, false);
  assert.equal(tasks.math.settings.temperature, 0);
  const answered = calls.filter((call) => call.settings.temperature === 0.6);
  assert.equal(answered.reduce((sum, call) => sum + call.itemIds.length, 0), sweep.dropped[0].of, "the loser answered only its looks");
});

test("a candidate within reach of the leader is measured on the next rung", async () => {
  const { result } = earlyStopTune((settings, id) => settings.temperature === 0 || id !== "math-0");
  const { sweeps } = await result;
  const sweep = sweeps.find((entry) => entry.axis === "temperature");
  assert.deepEqual(sweep.rungs.map((rung) => rung.size), [12, 24, 48], "one item behind is no reason to stop");
  assert.equal(sweep.dropped, undefined);
  assert.equal(sweep.endedEarly, undefined);
});

/** A code-only sampling tune where write and fix items respond differently to temperature. */
function groupedCodeTune(passes) {
  const items = [...ids("write", 12), ...ids("fix", 12)];
  return tune({
    evaluate: async (settings, itemIds) => ({
      prompts: itemIds.map((id) => ({ id, passed: passes(settings.temperature, id) ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id })),
    }),
    base: { ...BASE, temperature: 0 },
    tasks: ["code"],
    stages: ["sampling"],
    rungs: { code: [items], final: { code: items } },
    hardware: { logicalCores: 12 },
    groupOf: (id) => id.split("-")[0],
    samplingAxes: () => [{ name: "temperature", patches: [{ temperature: 0 }, { temperature: 0.6 }] }],
    options: { seeds: [42], passes: 1, changeAlpha: 0.2, stopAlpha: Infinity },
  });
}

test("a coding preset that gains overall by losing bug fixes is kept out", async () => {
  const { tasks, sweeps } = await groupedCodeTune((temperature, id) => {
    const index = Number(id.split("-")[1]);
    if (temperature === 0) return id.startsWith("write") ? index < 4 : index < 6;
    return id.startsWith("write"); // all 12 write items, no fix item
  });
  const sweep = sweeps.find((entry) => entry.axis === "temperature");
  assert.equal(tasks.code.settings.temperature, 0, "the balanced preset stays");
  assert.equal(sweep.changed, false);
  assert.match(sweep.groupGuard, /fix/, "the guard names the view it protected");
  assert.equal(sweep.groups.fix.worse, false, "the kept preset is not worse on any view");
});

test("a coding preset that improves every view wins", async () => {
  const { tasks, sweeps } = await groupedCodeTune((temperature, id) => {
    const index = Number(id.split("-")[1]);
    if (temperature === 0) return id.startsWith("write") ? index < 4 : index < 6;
    return id.startsWith("write") || index < 10;
  });
  const sweep = sweeps.find((entry) => entry.axis === "temperature");
  assert.equal(tasks.code.settings.temperature, 0.6);
  assert.equal(sweep.changed, true);
  assert.equal(sweep.groupGuard, undefined);
  assert.equal(sweep.groups.fix.worse, false);
  assert.equal(sweep.groups.write.rate, 100);
});

test("the prompt stage asks for the axes of the task being tuned", async () => {
  const asked = [];
  const items = ids("math", 4);
  await tune({
    evaluate: async (settings, itemIds) => ({ prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })) }),
    base: { ...BASE, temperature: 0 },
    tasks: ["code"],
    stages: ["prompt"],
    rungs: { code: [items], final: { code: items } },
    hardware: { logicalCores: 12 },
    promptAxes: (task) => {
      asked.push(task);
      return [{ name: "systemPrompt", patches: [{ systemPrompt: "Only code." }], full: true }];
    },
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  });
  assert.deepEqual(asked, ["code"]);
});

/** A prompt-only tune whose prompts behave differently on the tuning items and on the held-back ones. */
async function heldOutTune(behaviour) {
  const items = ids("math", 20);
  const held = ids("hold", 8);
  return tune({
    evaluate: async (settings, itemIds) => ({
      prompts: itemIds.map((id) => {
        const index = Number(id.split("-")[1]);
        const passed = behaviour(settings.systemPrompt, id.startsWith("hold"), index);
        return { id, passed: passed ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id };
      }),
    }),
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["sampling", "prompt"],
    rungs: { ...RUNGS, math: [items], holdout: { math: held } },
    hardware: { logicalCores: 12 },
    ...AXES,
    samplingAxes: () => [],
    promptAxes: [{ name: "systemPrompt", patches: ["Be precise.", "Other."].map((systemPrompt) => ({ systemPrompt })), full: true }],
    options: { seeds: [42], passes: 1 },
  });
}

test("a preset that only fits the tuning items falls back to the defaults on held-back items", async () => {
  // "Other." gets every tuning item right and every held-back one wrong: it learned the items, not the task.
  const { tasks } = await heldOutTune((prompt, held, index) => (prompt === "Other." ? !held : held || index < 10));
  assert.equal(tasks.math.holdout.fellBack, true);
  assert.equal(tasks.math.holdout.rate, 0);
  assert.equal(tasks.math.holdout.defaultRate, 100);
  assert.deepEqual(tasks.math.settings, {}, "the defaults apply");
});

test("a preset that also wins on held-back items is kept, with its honest gain", async () => {
  const { tasks } = await heldOutTune((prompt, held, index) => prompt === "Other." || index < (held ? 4 : 10));
  assert.equal(tasks.math.settings.systemPrompt, "Other.");
  assert.equal(tasks.math.holdout.fellBack, false);
  assert.equal(tasks.math.holdout.items, 8);
  assert.equal(tasks.math.holdout.vsDefault.rateDelta, 50, "8 of 8 against 4 of 8 on unseen items");
});

test("an equal but cheaper preset is kept by the held-back check (S5)", async () => {
  const { tasks } = await heldOutTune((prompt, held, index) => index < (held ? 4 : 10));
  assert.equal(tasks.math.holdout.fellBack, false, "equal rates are not a coin-flip fall-back");
  assert.equal(tasks.math.holdout.rate, tasks.math.holdout.defaultRate);
});

test("each task's result and its unseen check are broken down by question type", async () => {
  const items = ids("math", 20);
  const held = ids("hold", 8);
  const { tasks } = await tune({
    evaluate: async (settings, itemIds) => ({
      prompts: itemIds.map((id) => {
        const index = Number(id.split("-")[1]);
        // "Other." helps the hard half (index 10+) and leaves the easy half as it is.
        const passed = index < 10 || (settings.systemPrompt === "Other." && index < 18);
        return { id, passed: passed ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id };
      }),
    }),
    base: { ...BASE, temperature: 0 },
    tasks: ["math"],
    stages: ["sampling", "prompt"],
    rungs: { ...RUNGS, math: [items], holdout: { math: held } },
    typeOf: (id) => (Number(id.split("-")[1]) < 10 ? "easy" : "hard"),
    hardware: { logicalCores: 12 },
    ...AXES,
    samplingAxes: () => [],
    promptAxes: [{ name: "systemPrompt", patches: ["Be precise.", "Other."].map((systemPrompt) => ({ systemPrompt })), full: true }],
    options: { seeds: [42], passes: 1 },
  });
  // p is each type's own paired test: 8 hard items gained and none lost separates them; no change does not.
  assert.deepEqual(tasks.math.stats.byType, { easy: { items: 10, right: 10, defaultRight: 10, p: 1 }, hard: { items: 10, right: 8, defaultRight: 0, p: 0.0078 } });
  assert.deepEqual(tasks.math.holdout.byType.easy, { items: 8, right: 8, defaultRight: 8, p: 1 }, "held-back items 0-7 are all easy");
});

test("a shared quality setting that clearly hurts one task is reverted, naming the task", async () => {
  const math = ids("math", 20);
  const recall = ids("recall", 6);
  // q4_0 answers every math item and no recall item; f16 the other way round.
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: (settings.kvCache === "q4_0") === id.startsWith("math") ? 1 : 0, total: 1, ms: 10, outputTokens: 10, digest: id })),
  });
  const { load, sweeps } = await tune({
    evaluate,
    base: { ...BASE, kvCache: "f16", flashAttention: "on" },
    tasks: ["math", "recall"],
    stages: ["quality"],
    rungs: { ...RUNGS, load: [[...math, ...recall]], loadByTask: { math, recall } },
    hardware: { logicalCores: 12 },
    ...AXES,
    qualityAxes: [{ name: "kvCache", patches: ["f16", "q4_0"].map((kvCache) => ({ kvCache })) }],
    options: { seeds: [42], passes: 1 },
  });
  assert.equal(sweeps.find((sweep) => sweep.axis === "kvCache").winner.kvCache, "q4_0", "the mixed items chose q4_0");
  assert.equal(load.settings.kvCache, "f16", "but long context lost clearly, so it went back");
  assert.equal(load.perTask.recall.worse, true);
  assert.equal(load.perTask.math.worse, false);
  assert.equal(load.reverted, "recall");
});

test("a quick pass followed by a continue re-measures every axis on the full rungs (D1)", async () => {
  const seen = [];
  const evaluate = async (settings, itemIds, seed) => {
    seen.push({ maxTokens: settings.maxTokens, items: itemIds.length, seed });
    return { prompts: itemIds.map((id) => ({ id, passed: id.endsWith("-0") ? 0 : 1, total: 1, ms: 10, outputTokens: 10, digest: `${id}:${settings.maxTokens}` })) };
  };
  const axes = { samplingAxes: () => [{ name: "maxTokens", patches: [64, 128].map((maxTokens) => ({ maxTokens })) }] };
  const rungs = { math: [ids("math", 4), ids("math", 8)] };
  const quick = await tune({
    evaluate,
    base: { ...BASE, maxTokens: 64 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { ...rungs },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    ...axes,
    quick: true,
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  });
  assert.ok(quick.progress.sampling.math.done.some((key) => key.startsWith("quick:")), "quick sweeps are namespaced");
  assert.equal(quick.stages.sampling.math, "partial");
  const before = seen.length;
  const full = await tune({
    evaluate,
    base: { ...BASE, maxTokens: 64 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { ...rungs },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    ...axes,
    resume: { ...quick.progress, sweeps: quick.sweeps },
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  });
  // The measurement cache only asks for items a rung has not seen, so the
  // full rung appears as new-item calls plus a sweep record at size 8.
  const added = seen.slice(before);
  assert.ok(added.length > 0, "the continuation measured beyond the quick rung");
  const newSweeps = full.sweeps.slice(quick.sweeps.length);
  assert.ok(newSweeps.some((sweep) => sweep.rungs?.some((rung) => rung.size === 8)), "every axis ran on the full rung");
  assert.equal(full.stages.sampling.math, "done");
});

test("light and quiet are null when no measured thread count qualifies (D2)", async () => {
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 100, outputTokens: 10, digest: `${id}:${settings.threads}:${settings.flashAttention}` })),
  });
  // Every non-incumbent thread count flips an item's pass/fail, so nothing qualifies.
  // Text-only rounding without a flip qualifies since M3.
  const changing = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({ id, passed: settings.threads === 8 ? 1 : 0, total: 1, ms: 100, outputTokens: 10, digest: settings.threads === 8 ? `same-${id}` : `changed-${id}` })),
  });
  const { speed } = await tune({
    evaluate: changing,
    base: { ...BASE, threads: 8, flashAttention: "on" },
    tasks: [],
    rungs: { load: [ids("mix", 4)], speed: [ids("speed", 4)] },
    qualityAxes: [],
    speedAxes: [{ name: "threads", patches: [1, 2, 4, 8].map((threads) => ({ threads })) }],
    hardware: { logicalCores: 12 },
    options: { seeds: [42], passes: 1, changeAlpha: Infinity },
  });
  assert.equal(speed.fastest.threads, 8);
  assert.equal(speed.light, null, "no formula fallback to an unmeasured count");
  assert.ok(speed.quiet == null, "quiet is null or omitted when nothing qualifies");
  assert.ok(evaluate, "keeps the mock referenced");
});

test("above temperature 0 the first rung screens with one seed and decides with all (G1)", async () => {
  const calls = [];
  const evaluate = async (settings, itemIds, seed) => {
    calls.push({ items: [...itemIds], seed });
    return { prompts: itemIds.map((id) => ({ id, passed: 1, total: 1, ms: 10, outputTokens: 10, digest: id })) };
  };
  await tune({
    evaluate,
    base: { ...BASE, temperature: 0.7 },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { math: [ids("math", 4), ids("math", 8)] },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [{ name: "temperature", patches: [0.7, 0.2].map((temperature) => ({ temperature })) }],
    options: { seeds: [42, 7, 1234], passes: 1, changeAlpha: Infinity },
  });
  const firstFull = calls.findIndex((call) => call.items.length === 8);
  assert.ok(firstFull > 0, "the second rung asks new items");
  assert.ok(calls.slice(0, firstFull).every((call) => call.seed === 42), "the screen runs one seed");
  assert.ok(calls.some((call) => call.items.length === 8 && call.seed === 7), "the decision still uses every seed");
});

test("a rung leader that loses on unused items does not stand (S1)", async () => {
  const rung = ids("rung", 8);
  const unused = ids("unused", 10);
  const evaluate = async (settings, itemIds) => ({
    prompts: itemIds.map((id) => ({
      id,
      passed: (settings.level === "good") === id.startsWith("rung") ? 1 : 0,
      total: 1, ms: 10, outputTokens: 10, digest: id,
    })),
  });
  const run = (level) => tune({
    evaluate,
    base: { ...BASE, temperature: 0, level: "base" },
    tasks: ["math"],
    stages: ["sampling"],
    rungs: { math: [rung], final: { math: [...rung, ...(level === "flip" ? unused : [])] } },
    hardware: { logicalCores: 12 },
    qualityAxes: [],
    speedAxes: [],
    samplingAxes: () => [{ name: "level", patches: ["base", "good"].map((value) => ({ level: value })) }],
    options: { seeds: [42], passes: 1, changeAlpha: 0.2 },
  });
  const overturned = await run("flip");
  const sweep = overturned.sweeps.find((item) => item.axis === "level");
  assert.equal(overturned.tasks.math.settings.level, "base", "the unconfirmed challenger does not stand");
  assert.equal(sweep.confirmation.confirmed, false);
  assert.equal(sweep.confirmation.items, 10);
  assert.match(sweep.kept, /unused items/);
  const held = await run("keep");
  assert.equal(held.sweeps.find((item) => item.axis === "level").confirmation, undefined, "no leftover pool, no confirmation rung");
});

test("the tolerance counts items, not rounded percents (D4)", async () => {
  // 12 items: incumbent solves 11, challenger solves 10 with fewer tokens.
  // One item is within the tolerance, so the cheaper challenger wins on both rung sizes.
  const evaluate12 = async (settings, itemIds) => ({
    prompts: itemIds.map((id, index) => ({ id, passed: (settings.maxTokens === 64 ? index < 10 : index < 11) ? 1 : 0, total: 1, ms: 10, outputTokens: settings.maxTokens, digest: id })),
  });
  for (const size of [12, 24]) {
    const { tasks } = await tune({
      evaluate: evaluate12,
      base: { ...BASE, maxTokens: 128 },
      tasks: ["math"],
      stages: ["sampling"],
      rungs: { math: [ids("math", size)] },
      hardware: { logicalCores: 12 },
      qualityAxes: [],
      speedAxes: [],
      samplingAxes: () => [{ name: "maxTokens", patches: [64, 128].map((maxTokens) => ({ maxTokens })) }],
      options: { seeds: [42], passes: 1, changeAlpha: Infinity },
    });
    assert.equal(tasks.math.settings.maxTokens, 64, `one item lost is within tolerance on ${size} items`);
  }
});
