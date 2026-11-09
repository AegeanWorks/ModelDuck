import assert from "node:assert/strict";
import test from "node:test";

import { SYSTEM_PROMPT } from "../benchmarks/suite.mjs";
import {
  CODE_PROMPTS,
  DEFAULT_STEPS,
  DIRECTIVE_PROMPTS,
  THINKING_PROMPTS,
  estimateTune,
  expectedAnswers,
  timeLeft,
  isValidCombination,
  normalizeSteps,
  promptAxes,
  qualityAxes,
  samplingAxes,
  settingNames,
  speedAxes,
  threadSteps,
} from "../benchmarks/tune-grid.mjs";

const values = (axes, name) => axes.find((axis) => axis.name === name)?.patches.map((patch) => Object.values(patch)[0]);

test("quality axes tune the KV cache only; context is a fixed floor", () => {
  const axes = qualityAxes();
  assert.deepEqual(axes.map((axis) => axis.name), ["kvCache"]);
  assert.deepEqual(values(axes, "kvCache"), ["f16", "q8_0", "q8_0:q4_0"], "symmetric q4_0 is out (lit §3), mixed K/V is measured");
  assert.equal(DEFAULT_STEPS.load.contextSize, undefined, "context is not a step");
  assert.ok(!settingNames().includes("contextSize"), "context is not a --settings name");
});

test("speed axes are the load settings that only change speed", () => {
  const axes = speedAxes({ logicalCores: 16 });
  assert.deepEqual(axes.map((axis) => axis.name), ["flashAttention", "useMmap", "batchSize", "threads"]);
  assert.deepEqual(values(axes, "batchSize"), [64, 128, 256, 512, 1024, 2048]);
  assert.deepEqual(values(axes, "threads"), [1, 2, 4, 6, 8, 10, 12]);
});

test("thread steps never use more than three quarters of the logical threads", () => {
  assert.deepEqual(threadSteps([1, 2, 4, 6, 8, 10, 12], { logicalCores: 16 }), [1, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(threadSteps([1, 2, 4, 6, 8, 10, 12], { logicalCores: 8 }), [1, 2, 4, 6]);
  assert.deepEqual(threadSteps([8, 12], { logicalCores: 2 }), [1]);
});

test("checkpointing can be switched on as one speed axis of interval × max", () => {
  const steps = normalizeSteps({ load: { checkpointing: { enabled: true, interval: [512, 1024], max: [4, 8] } } }).steps;
  const axis = speedAxes({ logicalCores: 16 }, steps.load).find((item) => item.name === "checkpointing");
  assert.equal(axis.patches.length, 1 + 2 * 2);
  assert.deepEqual(axis.patches[1], { checkpoints: true, checkpointInterval: 512, checkpointMax: 4 });
});

test("the sampling steps are the user's, and truncation axes are marked as no-ops when greedy", () => {
  const axes = samplingAxes("comprehension");
  assert.deepEqual(axes.map((axis) => axis.name), ["sampler", "maxTokens", "repeatPenalty", "penalizeNewLine", "topK"]);
  assert.deepEqual(values(axes, "maxTokens"), [64, 128, 256, 512, 1024, 2048]);
  assert.deepEqual(values(axes, "repeatPenalty"), [1, 1.05]);
  assert.deepEqual(values(axes, "penalizeNewLine"), [true, false]);
  assert.deepEqual(values(axes, "topK"), [0, 20, 40]);
  assert.deepEqual(axes.filter((axis) => axis.greedyNoop).map((axis) => axis.name), ["topK"]);
  const sampler = axes.find((axis) => axis.name === "sampler");
  assert.deepEqual(sampler.patches, [
    { temperature: 0 },
    { temperature: 0.2, minP: 0.1, topP: 0.8 },
    { temperature: 0.4, minP: 0.1, topP: 0.8 },
    { temperature: 0.6, minP: 0.05, topP: 0.9 },
    { temperature: 0.8, minP: 0.05, topP: 0.9 },
    { temperature: 1, minP: 0, topP: 0.85 },
  ], "low temperatures pair with truncated top-p: tail tokens hurt code");
  assert.equal(typeof axes.find((axis) => axis.name === "topK").skipWhen, "function");
  assert.equal(axes.find((axis) => axis.name === "topK").skipWhen({ temperature: 0.2, minP: 0.1 }), true, "top-k only when min-p is 0");
  assert.equal(axes.find((axis) => axis.name === "topK").skipWhen({ temperature: 0.2, minP: 0 }), false);
  assert.equal(axes.find((axis) => axis.name === "penalizeNewLine").skipWhen({ repeatPenalty: 1 }), true);
  assert.equal(axes.find((axis) => axis.name === "penalizeNewLine").skipWhen({ repeatPenalty: 1.1 }), false);
});

test("the code task tries DRY but not the code fence", () => {
  const axes = samplingAxes("code");
  assert.deepEqual(axes.map((axis) => axis.name), ["sampler", "maxTokens", "repeatPenalty", "dry", "penalizeNewLine", "topK"]);
  assert.ok(!axes.some((axis) => axis.name === "codeFence"), "the fence amputates code (39 vs 1, p≈7e-12): evidence-against, not searched");
});

test("the prompt stage tries the baseline and all 21 directives, fully scored, then reasoning and repetition", () => {
  assert.equal(DIRECTIVE_PROMPTS.length, 21);
  assert.equal(new Set(DIRECTIVE_PROMPTS).size, 21, "no directive twice");
  assert.ok(!DIRECTIVE_PROMPTS.includes(SYSTEM_PROMPT), "the baseline is not repeated");
  assert.equal(THINKING_PROMPTS.length, 21, "the earlier prompts stay available for a saved grid");
  const axes = promptAxes();
  assert.deepEqual(axes.map((axis) => axis.name), ["systemPrompt", "reasoning", "promptRepeat"]);
  const prompts = values(axes, "systemPrompt");
  assert.equal(prompts[0], SYSTEM_PROMPT);
  assert.deepEqual(prompts.slice(1), DIRECTIVE_PROMPTS);
  assert.equal(axes[0].full, true, "every prompt gets a full score, no elimination");
  assert.deepEqual(values(axes, "reasoning"), ["off", "deep"], "reasoning is tried off and fully on");
  assert.deepEqual(values(axes, "promptRepeat"), [1, 2]);
  assert.deepEqual(values(promptAxes(DEFAULT_STEPS.prompt, "code"), "promptRepeat"), [1], "code stays at one copy unless opted in (G1)");
});

test("the code task tries coding directives and reasoning auto, and respects a custom list", () => {
  const axes = promptAxes(DEFAULT_STEPS.prompt, "code");
  const prompts = values(axes, "systemPrompt");
  assert.equal(prompts[0], SYSTEM_PROMPT);
  assert.deepEqual(prompts.slice(1), CODE_PROMPTS);
  assert.equal(CODE_PROMPTS.length, 8);
  assert.equal(new Set(CODE_PROMPTS).size, 8, "no coding directive twice");
  assert.deepEqual(values(axes, "reasoning"), ["off", "auto", "deep"]);
  const custom = promptAxes({ ...DEFAULT_STEPS.prompt, systemPrompt: ["Custom."], reasoning: ["off"] }, "code");
  assert.deepEqual(values(custom, "systemPrompt"), ["Custom."], "a user's prompt list is not replaced");
  assert.deepEqual(values(custom, "reasoning"), ["off"], "a user's reasoning steps are not replaced");
});

test("a quantized KV cache with flash attention off is not a real combination", () => {
  assert.equal(isValidCombination({ kvCache: "q8_0", flashAttention: "off" }), false);
  assert.equal(isValidCombination({ kvCache: "f16", flashAttention: "off" }), true);
  assert.equal(isValidCombination({ kvCache: "q8_0", flashAttention: "auto" }), true);
});

test("user steps are checked against the settings ranges; bad values are reported, not clamped", () => {
  const { steps, problems } = normalizeSteps({
    load: { contextSize: [256, 4096], kvCache: ["f16", "q2_k"], threads: [] },
    sampling: { temperature: [0, 0.5, 3], repeatPenalty: [0.9, 1.1], maxTokens: { code: [512, 8] } },
    prompt: { systemPrompt: ["Be brief.", "", "Be brief."], reasoning: ["off", "loud"], promptRepeat: [1, 4] },
  });
  assert.equal(steps.load.contextSize, undefined, "context steps are dropped: the floor is fixed");
  assert.deepEqual(steps.load.kvCache, ["f16"]);
  assert.deepEqual(steps.load.threads, DEFAULT_STEPS.load.threads, "an emptied axis falls back to its defaults");
  assert.deepEqual(steps.sampling.temperature, [0, 0.5]);
  assert.deepEqual(steps.sampling.repeatPenalty, [1.1]);
  assert.deepEqual(steps.sampling.maxTokens.code, [512]);
  assert.deepEqual(steps.prompt.systemPrompt, ["Be brief."]);
  assert.deepEqual(steps.prompt.reasoning, ["off"]);
  assert.deepEqual(steps.prompt.promptRepeat, [1]);
  for (const text of ["kvCache q2_k", "temperature 3", "repeatPenalty 0.9", "maxTokens.code 8", "reasoning loud", "promptRepeat 4", "threads"]) {
    assert.ok(problems.some((problem) => problem.includes(text)), `no problem reported for ${text}`);
  }
});

test("the estimate covers all four stages and the worst case of two passes", () => {
  const estimate = estimateTune(DEFAULT_STEPS, { logicalCores: 16, tasks: ["comprehension"], secondsPerAnswer: 3, reloadSeconds: 5 });
  assert.equal(estimate.quality.configs, 3, "only the KV cache is measured; the context is a fixed 16K floor (ADR-089)");
  assert.equal(estimate.speed.configs, 2 + 2 + 6 + 7);
  assert.equal(estimate.sampling.comprehension.configs, 6 + 6 + 2 + 2 + 3, "sampler, tokens, repeat, newline, top-k (G2/G4)");
  assert.equal(estimate.prompt.comprehension.configs, 22 + 2 + 2);
  assert.ok(estimate.onePassSeconds > 0);
  assert.equal(estimate.worstCaseSeconds, estimate.onePassSeconds * 2);
});

test("a quick estimate uses the first rung and stays below the full pass", () => {
  const options = { logicalCores: 16, tasks: ["code"], secondsPerAnswer: 3, reloadSeconds: 5 };
  const full = estimateTune(DEFAULT_STEPS, options);
  const quick = estimateTune(DEFAULT_STEPS, { ...options, quick: true });
  assert.ok(quick.onePassSeconds < full.onePassSeconds);
  const fullAnswers = expectedAnswers(DEFAULT_STEPS, { tasks: ["code"] });
  const quickAnswers = expectedAnswers(DEFAULT_STEPS, { tasks: ["code"], quick: true });
  assert.ok(quickAnswers < fullAnswers);
  assert.equal(quick.worstCaseSeconds, quick.onePassSeconds * 2);
});

test("stage 0 probes the CPU and Vulkan by default, and the CPU is always kept as the reference", () => {
  assert.deepEqual(DEFAULT_STEPS.device.backends, ["cpu", "vulkan"]);
  const { steps, problems } = normalizeSteps({ device: { backends: ["vulkan", "opencl"] } });
  assert.deepEqual(steps.device.backends, ["cpu", "vulkan"]);
  assert.ok(problems.some((problem) => problem.includes("backends opencl")));
  assert.equal(estimateTune(DEFAULT_STEPS, { tasks: ["comprehension"] }).device.configs, 2);
});

test("lane counts are settings, since every PC has different CPU and GPU", () => {
  assert.deepEqual(DEFAULT_STEPS.lanes, { cpu: 1, gpu: 2 });
  const { steps, problems } = normalizeSteps({ lanes: { cpu: 0, gpu: 9 } });
  assert.deepEqual(steps.lanes, { cpu: 1, gpu: 2 }, "out-of-range lanes fall back to the defaults");
  assert.ok(problems.some((problem) => problem.includes("lanes.cpu 0")));
  assert.ok(problems.some((problem) => problem.includes("lanes.gpu 9")));
  assert.deepEqual(normalizeSteps({ lanes: { cpu: 2, gpu: 0 } }).steps.lanes, { cpu: 2, gpu: 0 }, "0 GPU lanes: GPU models tune one after another");
});

test("every setting a tune can run on its own has a name, in stage order", () => {
  const names = settingNames();
  assert.equal(names[0], "device");
  for (const name of ["kvCache", "threads", "batchSize", "checkpointing", "sampler", "maxTokens", "systemPrompt", "promptRepeat"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("contextSize"), "context is a fixed floor, not a setting");
  assert.ok(names.indexOf("threads") < names.indexOf("sampler"));
});

test("a run's expected answers count only its chosen stages or settings, and the budgeted context costs none", () => {
  const whole = expectedAnswers(DEFAULT_STEPS, { logicalCores: 16, tasks: ["comprehension"] });
  assert.equal(expectedAnswers(DEFAULT_STEPS, { tasks: ["comprehension"], stages: ["device"] }), 2 * 6, "two backends on the six speed items");
  const prompt = expectedAnswers(DEFAULT_STEPS, { tasks: ["comprehension"], stages: ["prompt"] });
  assert.ok(prompt > 0 && prompt < whole);
  const reasoning = expectedAnswers(DEFAULT_STEPS, { tasks: ["comprehension"], only: ["reasoning"] });
  assert.ok(reasoning > 0 && reasoning < prompt, "one setting is a fraction of its stage");
  assert.equal(expectedAnswers(DEFAULT_STEPS, { tasks: ["comprehension"], only: ["contextSize"] }), 0, "context is not a measurable setting");
});

test("the preflight seconds cover only the selected stages or settings (D3)", () => {
  const options = { logicalCores: 16, tasks: ["comprehension"], secondsPerAnswer: 3, reloadSeconds: 5 };
  const whole = estimateTune(DEFAULT_STEPS, options);
  const deviceOnly = estimateTune(DEFAULT_STEPS, { ...options, stages: ["device"] });
  assert.ok(deviceOnly.onePassSeconds > 0 && deviceOnly.onePassSeconds < whole.onePassSeconds, "a device-only preflight no longer shows the full-tune time");
  const reasoning = estimateTune(DEFAULT_STEPS, { ...options, only: ["reasoning"] });
  assert.ok(reasoning.onePassSeconds > 0 && reasoning.onePassSeconds < whole.onePassSeconds);
  assert.equal(estimateTune(DEFAULT_STEPS, { ...options, only: ["contextSize"] }).onePassSeconds, 0, "the budgeted context costs no seconds");
});

test("time left comes from the measured pace, and never invents a number past the estimate", () => {
  assert.equal(timeLeft({ answers: 0, expected: 100, elapsedMs: 0 }), null, "nothing measured yet");
  assert.equal(timeLeft({ answers: 100, expected: 400, elapsedMs: 10 * 60_000 }), "about 30 min left");
  assert.equal(timeLeft({ answers: 100, expected: 1000, elapsedMs: 10 * 60_000 }), "about 1 h 30 min left");
  assert.equal(timeLeft({ answers: 395, expected: 400, elapsedMs: 10 * 60_000 }), "less than a minute left");
  assert.equal(timeLeft({ answers: 450, expected: 400, elapsedMs: 10 * 60_000 }), "finishing up (a second pass)");
});
