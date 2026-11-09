import { createInterface } from "node:readline/promises";

/** Parse "2048, 4096 8192" or "f16,q8_0"; null for a blank answer (keep the current steps). */
export function parseStepList(text) {
  const parts = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((part) => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : part));
}

const LOAD_ORDER = ["kvCache", "flashAttention", "useMmap", "batchSize", "threads"];
const SAMPLING_ORDER = ["repeatPenalty", "minP", "topP", "topK"];

/**
 * Ask for every setting's steps (`npm run tune -- --interactive`). Enter keeps
 * the shown list; the answer is returned raw, to be cleaned by `normalizeSteps`.
 */
export async function askSteps(current, { input = process.stdin, output = process.stdout } = {}) {
  const reader = createInterface({ input, terminal: false });
  const lines = reader[Symbol.asyncIterator]();
  const ask = async (label, values) => {
    output.write(`${label} [${values.join(", ")}]: `);
    const next = await lines.next();
    output.write("\n");
    return next.done ? null : next.value;
  };
  const list = async (label, values) => parseStepList(await ask(label, values)) ?? [...values];

  output.write("Enter keeps a setting's steps; type a new list to replace them.\nStage 1, load settings:\n");
  const load = {};
  for (const key of LOAD_ORDER) load[key] = await list(key, current.load[key]);
  const wanted = String(await ask("Tune checkpointing (only matters for hybrid/sliding-window models)? y/N", [current.load.checkpointing.enabled ? "y" : "n"]) ?? "");
  const enabled = wanted.trim() ? /^y/i.test(wanted.trim()) : current.load.checkpointing.enabled;
  load.checkpointing = enabled
    ? { enabled, interval: await list("checkpointing interval", current.load.checkpointing.interval), max: await list("checkpointing max", current.load.checkpointing.max) }
    : { ...current.load.checkpointing, enabled: false };

  output.write("Stage 2, sampling settings per task:\n");
  const sampling = { temperature: await list("temperature", current.sampling.temperature), maxTokens: {} };
  for (const [task, values] of Object.entries(current.sampling.maxTokens)) sampling.maxTokens[task] = await list(`maxTokens (${task})`, values);
  for (const key of SAMPLING_ORDER) sampling[key] = await list(key, current.sampling[key]);
  output.write("Stage 4, prompt settings per task (system prompts are kept as they are; edit tune-grid.json to change them):\n");
  const prompt = {
    systemPrompt: [...current.prompt.systemPrompt],
    reasoning: await list("reasoning", current.prompt.reasoning),
    promptRepeat: await list("promptRepeat", current.prompt.promptRepeat),
  };
  reader.close();
  return { load, sampling, prompt };
}
