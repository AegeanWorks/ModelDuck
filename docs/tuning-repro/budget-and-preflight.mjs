// Sections 2.3 and 5.1: where a full tune's answers go, and what the Tune panel's preflight shows.
//   node docs/tuning-repro/budget-and-preflight.mjs
import { DEFAULT_STEPS, estimateTune, expectedAnswers, promptAxes } from "../../benchmarks/tune-grid.mjs";

const options = { logicalCores: 16, tasks: ["code", "comprehension", "recall"] };
const total = expectedAnswers(DEFAULT_STEPS, options);
const of = (stages, extra = {}) => expectedAnswers(DEFAULT_STEPS, { ...options, stages, ...extra });
const holdout = of(["sampling", "prompt"]) - of(["sampling"], { only: ["temperature", "maxTokens", "repeatPenalty", "minP", "topP", "topK"] }) - of(["prompt"], { only: ["systemPrompt", "reasoning", "promptRepeat"] });
const rows = [
  ["device", of(["device"])],
  ["quality (context, KV cache)", of(["quality"])],
  ["speed (flash, mmap, batch, threads)", of(["speed"])],
  ["sampling, 3 tasks", of(["sampling"], { only: ["temperature", "maxTokens", "repeatPenalty", "minP", "topP", "topK"] })],
  ["prompt, 3 tasks", of(["prompt"], { only: ["systemPrompt", "reasoning", "promptRepeat"] })],
  ["  of which the systemPrompt axis", of(["prompt"], { only: ["systemPrompt"] })],
  ["held-back check", holdout],
];
for (const [name, answers] of rows) console.log(`${name.padEnd(38)} ${String(answers).padStart(6)}  ${((100 * answers) / total).toFixed(1)}%`);
console.log(`${"one pass, upper bound".padEnd(38)} ${String(total).padStart(6)}  ≈ ${((total * 3) / 3600).toFixed(1)} h at 3 s/answer`);
for (const task of options.tasks) console.log(`  ${task}: ${promptAxes(DEFAULT_STEPS.prompt, task)[0].patches.length} system prompts`);

console.log("\nPreflight (GET /api/tune/estimate): answers follow the selection, seconds do not");
const seconds = estimateTune(DEFAULT_STEPS, { ...options, secondsPerAnswer: 3 }).onePassSeconds;
for (const stages of [["device", "quality", "speed", "sampling", "prompt"], ["prompt"], ["device"]]) {
  const answers = of(stages);
  console.log(`  stages=${stages.join(",").padEnd(36)} answers ${String(answers).padStart(6)} · seconds shown ${seconds} · answers × 3 s = ${answers * 3}`);
}
