import assert from "node:assert/strict";
import test from "node:test";

import { budgetContext, contextSizesFor, estimateLoad, estimateLoadV2, fitVerdict, kvBytesPerToken, splitKvCache } from "../src/memory-fit.js";

const GIB = 1024 ** 3;
const QWEN_1_5B = { layers: 28, kvHeads: 2, headDim: 128 };
const LLAMA_3B = { layers: 28, kvHeads: 8, headDim: 128 };

test("context keeps the sizes that cover the task prompts, or the largest when none does", () => {
  const steps = [2048, 4096, 8192, 16384];
  assert.deepEqual(contextSizesFor(steps, 2223), [4096, 8192, 16384], "code: 1711 + 512 margin");
  assert.deepEqual(contextSizesFor(steps, 0), steps);
  assert.deepEqual(contextSizesFor(steps, 16567), [16384], "recall needs more than any listed size");
  assert.deepEqual(contextSizesFor([2048], 4096), [2048], "a single step is the fallback");
});

test("V2 requirements normalize to the estimate shape, with the VRAM split kept (M7)", () => {
  const estimate = estimateLoadV2({
    requirements: { cpuRam: 300 * 1024 ** 2, gpuVram: 100 * 1024 ** 2 },
    weights: 1.83 * GIB,
    contextSize: 8192,
    kvCache: "q8_0",
  });
  assert.equal(estimate.estimator, "v2");
  assert.equal(estimate.kv, 400 * 1024 ** 2);
  assert.equal(estimate.overhead, 0, "graph and compute buffers live inside the V2 split");
  assert.equal(estimate.total, estimate.weights + 400 * 1024 ** 2);
  assert.equal(estimate.vram, 100 * 1024 ** 2);
  assert.equal(estimate.contextSize, 8192);
  // Garbage in: zero context, never NaN, so a bad simulator answer cannot block a load.
  const empty = estimateLoadV2({ requirements: null, weights: null, contextSize: 4096, kvCache: "f16" });
  assert.deepEqual([empty.kv, empty.total, empty.weights], [0, 0, 0]);
  // A V2 verdict composes with the same fit rule as the formula.
  const roomy = fitVerdict({ estimate, availableBytes: 8 * GIB });
  assert.equal(roomy.verdict, "comfortable");
  const tight = fitVerdict({ estimate, availableBytes: estimate.total / 0.7 });
  assert.equal(tight.verdict, "tight");
});

test("KV bytes per token follow the GGUF attention shape and cache type", () => {
  assert.equal(kvBytesPerToken(QWEN_1_5B, "f16"), 28_672);
  assert.equal(kvBytesPerToken(LLAMA_3B, "f16"), 114_688);
  assert.ok(kvBytesPerToken(LLAMA_3B, "q8_0") < kvBytesPerToken(LLAMA_3B, "f16") * 0.55);
  assert.equal(kvBytesPerToken(null, "f16"), null);
  assert.ok(
    kvBytesPerToken(LLAMA_3B, "q8_0:q4_0") < kvBytesPerToken(LLAMA_3B, "q8_0"),
    "mixed K/V (Q8 keys, Q4 values) sits between Q8 and Q4",
  );
  assert.ok(kvBytesPerToken(LLAMA_3B, "q8_0:q4_0") > kvBytesPerToken(LLAMA_3B, "q4_0"));
  assert.deepEqual(splitKvCache("q8_0:q4_0"), { key: "q8_0", value: "q4_0" });
  assert.deepEqual(splitKvCache("q8_0"), { key: "q8_0", value: "q8_0" });
});

test("the estimate adds weights, KV at the chosen context and a runtime reserve", () => {
  const estimate = estimateLoad({ modelBytes: 1.83 * GIB, shape: LLAMA_3B, contextSize: 8192, kvCache: "f16" });
  assert.equal(estimate.kv, 114_688 * 8192);
  assert.ok(estimate.total > estimate.weights + estimate.kv);
  assert.equal(estimateLoad({ modelBytes: GIB, shape: null, contextSize: 4096, kvCache: "f16" }).kv, null);
});

test("verdicts are comfortable, tight or will not fit, with the largest safe context", () => {
  const load = (contextSize) => estimateLoad({ modelBytes: 1.83 * GIB, shape: LLAMA_3B, contextSize, kvCache: "f16" });
  const roomy = fitVerdict({ estimate: load(4096), availableBytes: 8 * GIB, shape: LLAMA_3B, modelBytes: 1.83 * GIB, kvCache: "f16" });
  assert.equal(roomy.verdict, "comfortable");

  const tight = fitVerdict({ estimate: load(4096), availableBytes: 3.6 * GIB, shape: LLAMA_3B, modelBytes: 1.83 * GIB, kvCache: "f16" });
  assert.equal(tight.verdict, "tight");

  const tooBig = fitVerdict({ estimate: load(32768), availableBytes: 4 * GIB, shape: LLAMA_3B, modelBytes: 1.83 * GIB, kvCache: "f16" });
  assert.equal(tooBig.verdict, "will_not_fit");
  assert.ok(tooBig.largestSafeContext >= 512 && tooBig.largestSafeContext < 32768);
  const safe = load(tooBig.largestSafeContext);
  assert.ok(safe.total <= 4 * GIB * 0.75);

  const unknown = fitVerdict({ estimate: estimateLoad({ modelBytes: GIB, shape: null, contextSize: 4096, kvCache: "f16" }), availableBytes: 8 * GIB });
  assert.equal(unknown.verdict, "unknown");
});

const STEPS = [2048, 4096, 8192, 16384];

test("the context budget is the largest listed size that fits comfortably, capped by the trained context", () => {
  const llama = { modelBytes: 1.83 * GIB, shape: LLAMA_3B, kvCache: "f16", steps: STEPS };
  // 16k f16 KV for Llama 3B is 1.75 GiB: with 16 GiB of VRAM it fits easily.
  assert.equal(budgetContext({ ...llama, availableBytes: 16 * GIB, trainContext: 131072 }).contextSize, 16384);
  // With 4.5 GiB free, 60% is 2.7 GiB: weights (1.83) and reserve (0.25) leave room for 4096 (0.44 GiB KV) but not 8192 (0.88).
  const tight = budgetContext({ ...llama, availableBytes: 4.5 * GIB, trainContext: 131072 });
  assert.equal(tight.contextSize, 4096);
  assert.match(tight.reason, /4096.*fits.*4\.5 GiB free/);
  // A quantized KV cache takes less memory, so the same memory holds a larger context.
  assert.ok(budgetContext({ ...llama, kvCache: "q4_0", availableBytes: 4.5 * GIB, trainContext: 131072 }).contextSize > 4096);
  // Never above what the model was trained on.
  assert.equal(budgetContext({ ...llama, availableBytes: 16 * GIB, trainContext: 8192 }).contextSize, 8192);
});

test("the context budget prefers total-minus-reserve over momentary free memory (M7)", async () => {
  const { budgetContext: budget } = await import("../src/memory-fit.js");
  const llama = { modelBytes: 1.83 * GIB, shape: LLAMA_3B, kvCache: "f16", steps: STEPS, trainContext: 131072 };
  // Only 2 GiB free right now, but 16 GiB total: the tune must not shrink for a busy afternoon.
  const sized = budget({ ...llama, totalBytes: 16 * GIB, availableBytes: 2 * GIB });
  assert.equal(sized.contextSize, 16384);
  assert.match(sized.reason, /16\.0 GiB total/);
  assert.deepEqual(sized.inputs.totalBytes, 16 * GIB);
});

test("the context budget refuses an empty step list instead of choosing undefined", () => {
  assert.throws(() => budgetContext({ modelBytes: GIB, shape: LLAMA_3B, kvCache: "f16", steps: [], availableBytes: 8 * GIB, trainContext: 32768 }),
    (error) => error.code === "empty_context_steps" && /empty/.test(error.why) && /at least one/.test(error.fix));
});

test("inherited property names are not KV cache types", () => {
  assert.deepEqual(splitKvCache("toString"), { key: "f16", value: "f16" });
  assert.deepEqual(splitKvCache("__proto__"), { key: "f16", value: "f16" });
  assert.ok(Number.isFinite(kvBytesPerToken(QWEN_1_5B, "toString")));
});

test("fitVerdict without an estimate is unknown, not a throw", () => {
  assert.deepEqual(fitVerdict({ availableBytes: 8 * GIB }).verdict, "unknown");
  assert.deepEqual(fitVerdict({ estimate: { total: NaN }, availableBytes: 8 * GIB }).verdict, "unknown");
});

test("the context budget falls back to the smallest size, and says so, when nothing fits or memory is unknown", () => {
  const tiny = budgetContext({ modelBytes: 1.83 * GIB, shape: LLAMA_3B, kvCache: "f16", steps: STEPS, availableBytes: 1 * GIB, trainContext: 131072 });
  assert.equal(tiny.contextSize, 2048);
  assert.match(tiny.reason, /no listed size fits/i);
  const unknown = budgetContext({ modelBytes: GIB, shape: null, kvCache: "f16", steps: STEPS, availableBytes: 8 * GIB, trainContext: 32768 });
  assert.equal(unknown.contextSize, 2048);
  assert.match(unknown.reason, /unknown/i);
});
