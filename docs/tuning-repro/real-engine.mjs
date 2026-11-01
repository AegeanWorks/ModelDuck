// Section 3: real-engine checks of the speed stage (A/A noise, answer digests across threads and batch
// sizes, prefill share). Needs a folder holding SmolLM2-135M-Instruct-Q4_K_M.gguf.
//   node docs/tuning-repro/real-engine.mjs <models-folder>
import { LlamaEngine } from "../../src/engine.js";
import { createModelRegistry } from "../../src/model-registry.js";
import { createEvaluator } from "../../benchmarks/tune-evaluate.mjs";
import { Measurements, score, costDelta, changedAnswers } from "../../benchmarks/tune-measure.mjs";
import { speedItems, tuneRungs } from "../../benchmarks/tasks.mjs";
import { tuneBase } from "../../benchmarks/tune-job.mjs";
import { PROMPTS } from "../../benchmarks/suite.mjs";

const modelsDir = process.argv[2];
const registry = createModelRegistry({ modelsDir });
await registry.scan();
const entry = registry.findById(registry.listPublic().find((model) => /smollm2-135m/i.test(model.fileName)).id);
const engine = new LlamaEngine({ registry, logger: { warn() {}, info() {}, log() {} } });
const TIMED = { temperature: 0, maxTokens: null, parallelism: 1, timed: true };
const base = { ...tuneBase(), threads: 3, batchSize: 512, gpuBackend: "cpu", gpuLayers: 0 };
const items = speedItems();
const byId = new Map(PROMPTS.map((p) => [p.id, p]));

// A fresh evaluator per measurement forces a reload + warm-up, as each speed-stage candidate gets.
async function measureOnce(settings, ids) {
  const evaluate = createEvaluator({ engine, modelId: entry.id });
  return score(new Measurements(evaluate, Infinity), { ...settings, ...TIMED }, ids, [42]);
}

console.log(`model ${entry.fileName}, ${items.length} speed items: ${items.join(", ")}`);

// E1: A/A — identical settings measured as six separate "candidates".
const REPEATS = 6;
const reps = [];
for (let r = 0; r < REPEATS; r++) reps.push(await measureOnce(base, items));
let pairs = 0, significant = 0;
const medians = reps.map((s) => s.latencyMs);
for (let i = 0; i < REPEATS; i++) for (let j = 0; j < REPEATS; j++) {
  if (i === j) continue;
  pairs++;
  const d = costDelta(reps[i], reps[j], 0.03, "itemLatency");
  if (d.significant) significant++;
}
const digestsStable = reps.every((s) => changedAnswers(reps[0], s).length === 0);
console.log(`\nE1 A/A: median latency per repeat (ms): ${medians.join(", ")}`);
console.log(`E1 A/A: costDelta called identical settings "significantly different" in ${significant}/${pairs} ordered pairs; digests identical across repeats: ${digestsStable}`);
const perItem = items.map((id) => { const v = reps.map((s) => s.itemLatency.get(id)); const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); return `${id}: mean ${m.toFixed(0)} ms, CV ${(100 * sd / m).toFixed(1)}%`; });
console.log("E1 per-item latency spread:\n  " + perItem.join("\n  "));

// E2: do answers (digests) change across thread counts and batch sizes on the CPU?
const extra = tuneRungs(["code"]).code[0]; // first code rung: 12 items, includes long ones
const ids2 = [...items, ...extra];
const reference = await measureOnce(base, ids2);
console.log(`\nE2 reference (threads 3, batch 512) on ${ids2.length} items`);
for (const patch of [{ threads: 1 }, { threads: 2 }, { batchSize: 64 }, { batchSize: 128 }, { flashAttention: "on" }, { useMmap: "off" }]) {
  const s = await measureOnce({ ...base, ...patch }, ids2);
  const changed = changedAnswers(reference, s);
  const delta = costDelta(reference, s, 0.03, "itemLatency");
  console.log(`E2 ${JSON.stringify(patch).padEnd(26)} changed answers: ${String(changed.length).padStart(2)}/${ids2.length}${changed.length ? ` (${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ", …" : ""})` : ""} · median ${s.latencyMs} ms vs ${reference.latencyMs} · speed delta significant: ${delta.significant} (${delta.meanDelta} ms)`);
}

// E3: what the speed workload actually times — prefill vs decode, and the short-answer tok/s bias.
await engine.load({ modelId: entry.id, ...base, maxThreads: 3 });
console.log("\nE3 per item: prompt tokens, output tokens, time to first token, total, engine tok/s vs (n-1)/decode-time");
for (const id of items) {
  const p = byId.get(id);
  const r = await engine.chat({ conversationId: `e3-${id}`, messages: [{ role: "user", content: p.prompt }], systemPrompt: base.systemPrompt, settings: { ...base, temperature: 0, maxTokens: p.maxTokens ?? 512, seed: 42 }, onToken: () => {} });
  engine.dropSession(`e3-${id}`);
  const s = r.stats; const decodeMs = Math.max(1, s.ms - s.firstTokenMs);
  const corrected = s.outputTokens > 1 ? ((s.outputTokens - 1) / (decodeMs / 1000)).toFixed(1) : "n/a";
  console.log(`  ${id.padEnd(22)} prompt ${String(s.promptTokens).padStart(5)} · out ${String(s.outputTokens).padStart(4)} · TTFT ${String(s.firstTokenMs).padStart(5)} ms (${Math.round(100 * s.firstTokenMs / s.ms)}% of ${s.ms} ms) · engine ${s.tokensPerSecond} tok/s vs corrected ${corrected} · stop ${s.stopReason}`);
}
await engine.unload();
await engine.dispose?.();
