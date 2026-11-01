// Sections 4.3 and 4.5: which items a tune uses, and whether held-back items are really unseen.
//   node docs/tuning-repro/suite-usage.mjs
import { PROMPTS } from "../../benchmarks/suite.mjs";
import { TASKS, tuneRungs, speedItems } from "../../benchmarks/tasks.mjs";

const byId = new Map(PROMPTS.map((prompt) => [prompt.id, prompt]));
const rungs = tuneRungs();
// A codebase item's codebase: the file names it shows; a comprehension item's: its function.
const familyOf = (prompt) => prompt.group ?? ((prompt.prompt.match(/\/\/ file: [\w./-]+/g) ?? []).sort().join(",") || null);
for (const task of TASKS) {
  const items = PROMPTS.filter((prompt) => task.categories.includes(prompt.category));
  const tuned = rungs[task.id].at(-1);
  const held = rungs.holdout[task.id];
  const unused = items.filter((prompt) => !tuned.includes(prompt.id) && !held.includes(prompt.id));
  const tunedFamilies = new Set(tuned.map((id) => familyOf(byId.get(id))).filter(Boolean));
  const sharing = held.filter((id) => tunedFamilies.has(familyOf(byId.get(id))));
  const families = new Set(items.map(familyOf).filter(Boolean));
  console.log(`${task.id.padEnd(14)} items ${items.length} · searched/final ${tuned.length} · held back ${held.length} · never used ${unused.length} (${Math.round((100 * unused.length) / items.length)}%) · families ${families.size} · held items sharing a family with tuned items ${sharing.length}/${held.length}`);
  if (unused.length) {
    const byCategory = {};
    for (const prompt of unused) byCategory[prompt.category] = (byCategory[prompt.category] ?? 0) + 1;
    console.log(`               never used by category: ${JSON.stringify(byCategory)}`);
  }
}
const longest = Math.max(...PROMPTS.map((prompt) => prompt.prompt.length));
console.log(`\nlongest prompt: ${longest} characters (about ${Math.round(longest / 4)} tokens)`);
console.log(`speed workload: ${speedItems().map((id) => `${id} (${byId.get(id).maxTokens ?? "?"}-token budget)`).join(", ")}`);
