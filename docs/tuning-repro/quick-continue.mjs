// Finding D1 and D2: a Quick pass followed by the scheduler's `--continue` (ADR-074).
// Uses the synthetic model of tests/benchmark-tune.test.js, plus four items that only the
// full rung contains and that need a 512-token budget.
//   node docs/tuning-repro/quick-continue.mjs
import { tune } from "../../benchmarks/tune.mjs";
import { quickRungs } from "../../benchmarks/tune-grid.mjs";

const ids = (prefix, count) => Array.from({ length: count }, (_v, i) => `${prefix}-${i}`);
const RUNGS = {
  load: [ids("mix", 4), ids("mix", 8)],
  speed: [ids("speed", 6)],
  math: [ids("math", 4), ids("math", 8)],
  recall: [ids("recall", 4), ids("recall", 6)],
  loadByTask: { math: ids("math", 8), recall: ids("recall", 6) },
};
const BASE = { contextSize: 4096, kvCache: "f16", flashAttention: "auto", threads: 16, temperature: 0.7, maxTokens: 256, minP: 0.05, systemPrompt: "Be precise.", reasoning: "off", promptRepeat: 1 };
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
function syntheticModel() {
  const calls = [];
  const evaluate = async (settings, itemIds) => {
    calls.push(itemIds.length);
    const threads = Math.min(settings.threads, 8);
    return {
      memoryBytes: settings.contextSize * 1000,
      prompts: itemIds.map((id) => {
        let passed = true;
        if (id.startsWith("recall") || id === "mix-3") passed = settings.contextSize >= 8192;
        if (id === "mix-1" && settings.kvCache === "q4_0") passed = false;
        if (id.startsWith("math")) {
          const budget = settings.maxTokens ?? 512;
          passed = settings.temperature <= 0.2 && budget >= 128;
          if (["math-4", "math-5", "math-6", "math-7"].includes(id)) passed = passed && budget >= 512;
        }
        return { id, passed: passed ? 1 : 0, total: 1, ms: 1000 / threads + id.length, tokensPerSecond: threads * 5, outputTokens: (settings.maxTokens ?? 200) / 2, digest: `${id}:same` };
      }),
    };
  };
  return { evaluate, answers: () => calls.reduce((sum, n) => sum + n, 0) };
}
const common = { base: BASE, tasks: ["math", "recall"], hardware: { logicalCores: 12 }, ...AXES, options: { seeds: [42, 7, 1234], passes: 2, changeAlpha: Infinity } };

const fullModel = syntheticModel();
const full = await tune({ ...common, evaluate: fullModel.evaluate, rungs: RUNGS });
const quickModel = syntheticModel();
const quick = await tune({ ...common, evaluate: quickModel.evaluate, rungs: quickRungs(RUNGS, ["math", "recall"]), quick: true });
const contModel = syntheticModel();
const events = [];
const cont = await tune({ ...common, evaluate: contModel.evaluate, rungs: RUNGS, resume: { ...quick.progress, sweeps: quick.sweeps }, onEvent: (event) => events.push(event) });

console.log("Full tune     math preset:", JSON.stringify(full.tasks.math.settings), `rate ${full.tasks.math.stats?.rate}%`);
console.log("Quick pass    stages:", JSON.stringify(quick.stages));
console.log("Continuation  search candidates measured:", events.filter((event) => event.type === "candidate").length);
console.log("Continuation  stages:", JSON.stringify(cont.stages));
console.log("Continuation  answers asked:", contModel.answers(), "vs a full tune:", fullModel.answers());
console.log("Speed presets (fastest/light/quiet threads): full", [full.speed.fastest.threads, full.speed.light.threads, full.speed.quiet.threads].join("/"),
  "· quick", [quick.speed.fastest.threads, quick.speed.light.threads, quick.speed.quiet.threads].join("/"),
  "· after continuation", [cont.speed.fastest.threads, cont.speed.light.threads, cont.speed.quiet.threads].join("/"), "(measured steps: 1,2,4,8)");
