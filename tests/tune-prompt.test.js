import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { DEFAULT_STEPS } from "../benchmarks/tune-grid.mjs";
import { askSteps, parseStepList } from "../benchmarks/tune-prompt.mjs";

test("a typed step list accepts commas or spaces and keeps words as words", () => {
  assert.deepEqual(parseStepList("2048, 4096 8192"), [2048, 4096, 8192]);
  assert.deepEqual(parseStepList("f16,q8_0"), ["f16", "q8_0"]);
  assert.deepEqual(parseStepList("0.1 0.25"), [0.1, 0.25]);
  assert.equal(parseStepList("   "), null, "blank keeps the current steps");
});

test("the prompt walks every setting; Enter keeps, a list replaces, and checkpointing is opt-in", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  const answers = [
    "", // kvCache
    "", // flashAttention
    "", // useMmap
    "", // batchSize
    "4 8", // threads
    "y", // checkpointing?
    "512", // interval
    "8 16", // max
    "0 0.2 0.4", // temperature
    "", "", "", "", // maxTokens per task
    "", "", "", "", // minP, topP, topK, repeatPenalty
  ];
  const pending = askSteps(DEFAULT_STEPS, { input, output });
  input.end(`${answers.join("\n")}\n`);
  const steps = await pending;
  assert.equal(steps.load.contextSize, undefined, "context is not a step: the 16K floor is fixed");
  assert.deepEqual(steps.load.kvCache, DEFAULT_STEPS.load.kvCache);
  assert.deepEqual(steps.load.threads, [4, 8]);
  assert.deepEqual(steps.load.checkpointing, { enabled: true, interval: [512], max: [8, 16] });
  assert.deepEqual(steps.sampling.temperature, [0, 0.2, 0.4]);
  assert.deepEqual(steps.sampling.maxTokens, DEFAULT_STEPS.sampling.maxTokens);
  assert.ok(!shown.includes("contextSize"), "the prompt never asks for a context size");
});
