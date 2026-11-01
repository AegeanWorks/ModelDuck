// Section 3.5: repeat penalty 1.1 (newlines penalized) against off, greedy, on the code task's 48 tuning items.
// Needs a folder holding qwen2.5-0.5b-instruct-q4_k_m.gguf.
//   node docs/tuning-repro/repeat-penalty.mjs <models-folder>
import { LlamaEngine } from "../../src/engine.js";
import { createModelRegistry } from "../../src/model-registry.js";
import { createEvaluator } from "../../benchmarks/tune-evaluate.mjs";
import { Measurements, score, paired } from "../../benchmarks/tune-measure.mjs";
import { tuneRungs } from "../../benchmarks/tasks.mjs";
import { tuneBase } from "../../benchmarks/tune-job.mjs";
import { holm } from "../../benchmarks/stats.mjs";

const registry = createModelRegistry({ modelsDir: process.argv[2] });
await registry.scan();
const match = registry.listPublic().find((m) => /qwen2\.5-0\.5b/i.test(m.fileName));
const engine = new LlamaEngine({ registry, logger: { warn() {}, info() {}, log() {} } });
const evaluate = createEvaluator({ engine, modelId: match.id });
const m = new Measurements(evaluate, Infinity);
const items = tuneRungs(["code"]).code.at(-1);
const base = { ...tuneBase(), threads: 3, gpuBackend: "cpu", gpuLayers: 0, temperature: 0, maxTokens: null };
const runs = {};
for (const repeatPenalty of [1.1, 1]) {
  const started = Date.now();
  runs[repeatPenalty] = await score(m, { ...base, repeatPenalty }, items, [42]);
  console.log(`repeatPenalty ${repeatPenalty}: ${runs[repeatPenalty].rate}% of ${items.length} code items · median ${runs[repeatPenalty].outputTokens} tokens · ${Math.round((Date.now() - started) / 1000)} s`);
}
const e = paired(runs[1.1], runs[1]);
console.log(`paired: ${e.c} items fixed by turning the penalty off, ${e.b} broken; exact McNemar p=${e.pValue}`);
await engine.unload();
