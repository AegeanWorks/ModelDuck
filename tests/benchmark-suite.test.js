import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BENCHMARK_MODELS,
  EXCLUDED_IDS,
  PROMPTS,
  evaluateResponse,
  normalizeAnswer,
  stripFence,
} from "../benchmarks/suite.mjs";
import {
  BENCHMARK_MATRIX,
  CHAT_MATRIX,
  CORE_MODEL_IDS,
  CORE_MODEL_MATRIX,
  MODEL_MATRIX,
  buildChatMatrix,
  modelMatrix,
  modelMatrixFor,
  promptListFor,
} from "../benchmarks/matrix.mjs";

test("the benchmark keeps at least three different small model classes", () => {
  assert.ok(BENCHMARK_MODELS.length >= 3);
  assert.ok(new Set(BENCHMARK_MODELS.map((model) => model.kind)).size >= 3);
  assert.equal(PROMPTS.length, 265);
  const gallery = readFileSync(fileURLToPath(new URL("../assets/screenshots/README.md", import.meta.url)), "utf8");
  assert.ok(gallery.includes(`${PROMPTS.length} questions`), "the screenshot gallery names the current suite size");
});

test("a variant's prompt list refuses empty, unknown and repeated ids", () => {
  assert.deepEqual(promptListFor({ id: "x", promptIds: ["needle"] }).map((prompt) => prompt.id), ["needle"]);
  assert.deepEqual(promptListFor({ id: "x" }), PROMPTS, "no list means the whole suite");
  assert.throws(() => promptListFor({ id: "x", promptIds: [] }), (error) => error.code === "benchmark_prompt_empty");
  assert.throws(() => promptListFor({ id: "x", promptIds: ["no-such-prompt"] }), (error) => error.code === "benchmark_prompt_unknown");
  assert.throws(() => promptListFor({ id: "x", promptIds: ["needle", "needle"] }), (error) => error.code === "benchmark_prompt_duplicate");
});

test("short unscored items stay out of scored runs by id, not by a bare carve-out", () => {
  assert.ok(EXCLUDED_IDS.has("squad"), "the reading-comprehension demo is excluded");
  assert.ok(PROMPTS.every((prompt) => !EXCLUDED_IDS.has(prompt.id)));
});

test("every matrix variant asks only for shipped prompt ids", () => {
  for (const spec of [...BENCHMARK_MATRIX, ...CHAT_MATRIX, ...MODEL_MATRIX]) {
    for (const id of spec.promptIds ?? []) {
      assert.ok(PROMPTS.some((prompt) => prompt.id === id), `${spec.id} asks for ${id}`);
    }
  }
});

test("the matrix covers size, quantization, KV cache, context and threads", () => {
  const kv = new Set(BENCHMARK_MATRIX.map((variant) => variant.kvCache));
  const quant = new Set(BENCHMARK_MATRIX.map((variant) => variant.quant));
  const contexts = new Set(BENCHMARK_MATRIX.map((variant) => variant.contextSize));
  const threads = new Set(BENCHMARK_MATRIX.map((variant) => variant.threads));
  assert.ok(kv.has("f16") && kv.has("q8_0") && kv.has("q4_0"));
  assert.ok(quant.has("Q4_K_M") && quant.has("Q5_K_M") && quant.has("Q8_0"));
  assert.ok(contexts.has(2048) && contexts.has(4096));
  assert.ok(threads.has(4) && threads.has(8));
  assert.ok(BENCHMARK_MATRIX.some((variant) => variant.quant === "Q8_0" && variant.kvCache === "q8_0"));
});

test("the default model matrix is the three core models and full is opt-in", () => {
  assert.equal(CORE_MODEL_IDS.length, 3);
  assert.equal(new Set(CORE_MODEL_MATRIX.map((variant) => variant.catalogId)).size, 3);
  assert.ok(!CORE_MODEL_MATRIX.some((variant) => variant.catalogId.includes("llama")));
  assert.ok(!CORE_MODEL_MATRIX.some((variant) => variant.catalogId.includes("phi")));
  assert.equal(modelMatrix().length, CORE_MODEL_MATRIX.length);
  assert.equal(modelMatrix({ full: true }).length, MODEL_MATRIX.length);
  assert.ok(MODEL_MATRIX.length > CORE_MODEL_MATRIX.length);
  for (const id of ["qwen-0.5b-q4-ckpt-512", "qwen-0.5b-q4-ckpt-2048", "qwen-0.5b-q4-ckpt-max4"]) {
    const variant = CORE_MODEL_MATRIX.find((item) => item.id === id);
    assert.ok(variant, id);
    assert.equal(variant.promptIds.length, 16);
  }
  assert.equal(CORE_MODEL_MATRIX.find((item) => item.id === "qwen-0.5b-q4-ckpt-max4").checkpointMax, 4);
});

test("a single-model sweep builds settings variants for any model", () => {
  const qwen = modelMatrixFor("qwen2.5-0.5b-instruct-q4");
  assert.equal(qwen.length, 17);
  assert.ok(qwen.every((variant) => variant.catalogId === "qwen2.5-0.5b-instruct-q4"));
  assert.ok(qwen.every((variant) => variant.promptIds.length === 16));
  assert.ok(qwen.some((variant) => variant.id.endsWith("-ckpt512")));
  assert.ok(qwen.some((variant) => variant.id.endsWith("-batch256")));
  const coder = modelMatrixFor("qwen2.5-coder-1.5b-instruct-q4");
  assert.equal(coder.length, 17);
  assert.ok(coder.some((variant) => variant.id.endsWith("-kv8")));
  assert.deepEqual(modelMatrixFor("not-a-model"), []);
});

test("the model and chat phases cover their own settings", () => {
  assert.ok(MODEL_MATRIX.length > CHAT_MATRIX.length);
  assert.ok(CHAT_MATRIX.some((variant) => variant.topK === 20));
  assert.ok(CHAT_MATRIX.some((variant) => variant.minP === 0.1));
  assert.ok(CHAT_MATRIX.some((variant) => variant.repeatPenalty === 1.2));
  assert.ok(CHAT_MATRIX.some((variant) => variant.promptRepeat === 2));
  assert.ok(CHAT_MATRIX.some((variant) => variant.reasoning === "deep"));
  assert.ok(!CHAT_MATRIX.some((variant) => variant.structuredOutput === "json_schema"), "the removed JSON-format prompt has no variant");
  assert.ok(CHAT_MATRIX.every((variant) => variant.seed === 42));
});

test("a selected model-phase base drives every chat variant", () => {
  const matrix = buildChatMatrix({
    catalogId: "qwen2.5-coder-1.5b-instruct-q4",
    family: "qwen2.5-coder-1.5b-instruct",
    label: "Coder base",
    kvCache: "q8_0",
    contextSize: 4096,
    threads: 4,
    batchSize: 256,
    checkpoints: false,
  });
  assert.equal(matrix.length, CHAT_MATRIX.length);
  for (const variant of matrix) {
    assert.equal(variant.catalogId, "qwen2.5-coder-1.5b-instruct-q4");
    assert.equal(variant.family, "qwen2.5-coder-1.5b-instruct");
    assert.match(variant.fileName, /coder/);
    assert.equal(variant.kvCache, "q8_0");
    assert.equal(variant.contextSize, 4096);
    assert.equal(variant.threads, 4);
    assert.equal(variant.batchSize, 256);
    assert.equal(variant.checkpoints, false);
    assert.equal(variant.checkpointInterval, 8192);
    assert.equal(variant.checkpointMax, 32);
    assert.equal(variant.seed, 42);
  }
  assert.ok(matrix.some((variant) => variant.topK === 20));
  assert.ok(!matrix.some((variant) => variant.structuredOutput === "json_schema"));
});

test("fenced answers and trailing punctuation normalize for exact checks", () => {
  assert.equal(normalizeAnswer("```text\nParis.\n```"), "paris");
  assert.equal(normalizeAnswer('"QUACK!"'), "quack");
  assert.equal(stripFence("```js\nconst x = 1;\n```"), "const x = 1;");
});

test("exact checks are deterministic on the coding suite", async () => {
  const exactPrompt = PROMPTS.find((prompt) => prompt.id === "read-sumTo-2");
  const exact = await evaluateResponse(exactPrompt, "55");
  assert.equal(exact.passed, exact.total);
  const wrong = await evaluateResponse(exactPrompt, "54");
  assert.ok(wrong.passed < wrong.total);
});

test("code checks require a matching function and valid JavaScript syntax", async () => {
  const codePrompt = PROMPTS.find((prompt) => prompt.id === "javascript");
  const good = await evaluateResponse(
    codePrompt,
    "```js\nfunction add(a, b) {\n  return a + b;\n}\n```",
  );
  assert.equal(good.passed, good.total);

  const bad = await evaluateResponse(codePrompt, "function add(a, b) {");
  assert.ok(bad.passed < bad.total);
});

test("code comprehension asks for a value from the code shown", async () => {
  const prompt = PROMPTS.find((item) => item.id === "read-clamp-1");
  const correct = await evaluateResponse(prompt, "5");
  assert.equal(correct.passed, correct.total);
  const wrong = await evaluateResponse(prompt, "4");
  assert.ok(wrong.passed < wrong.total);
});
