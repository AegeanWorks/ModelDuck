import { SYSTEM_PROMPT } from "./suite.mjs";
import { speedItems, tuneRungs } from "./tasks.mjs";

/**
 * Search spaces for a tune, as plain step lists the user can edit
 * (`~/.modelduck/tune-grid.json`, the Bench panel, `--interactive`). A tune
 * runs four stages in order (ADR-030): quality load settings, speed load
 * settings, sampling per task, prompt per task. Each axis becomes a list of
 * setting patches; a patch with several keys moves them together.
 */

const freezeDeep = (value) => {
  if (value && typeof value === "object") Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
};

/** The user's first one-sentence system prompts (2026-10-30); no longer a default step (ADR-036), still usable from a saved grid. */
export const THINKING_PROMPTS = freezeDeep([
  "Exercise abstract thinking.",
  "Think from first principles.",
  "Identify hidden patterns.",
  "Challenge conventional assumptions.",
  "Connect unrelated concepts.",
  "Explore counterfactual scenarios.",
  "Develop lateral thinking.",
  "Practice causal reasoning.",
  "Recognize emergent patterns.",
  "Think across multiple levels of abstraction.",
  "Question your own conclusions.",
  "Embrace ambiguity.",
  "Synthesize opposing perspectives.",
  "Generate unconventional solutions.",
  "Practice analogical reasoning.",
  "Explore multidimensional relationships.",
  "Compress complex ideas into simple principles.",
  "Think beyond established frameworks.",
  "Develop recursive reasoning.",
  "Anticipate unintended consequences.",
  "Seek connections between distant disciplines.",
]);

/** One-sentence directives a small model can act on, each tried on every task (ADR-036). */
export const DIRECTIVE_PROMPTS = freezeDeep([
  "Answer with only what the question asks for.",
  "Follow the requested output format exactly.",
  "Be concise and do not explain unless asked.",
  "Read the whole question before answering.",
  "Check your answer against the question before replying.",
  "Work through the problem step by step, then state the final answer.",
  "Put the final answer on the last line.",
  "Give numeric answers as plain numbers.",
  "Answer only from the given text, quoting it where you can.",
  "Do not invent details that are not in the question.",
  "If the given text does not contain the answer, say so.",
  "Use the exact function name and signature requested.",
  "Write complete, runnable code with no placeholders.",
  "Return only the code when asked for code.",
  "Fix only the bug and keep the rest of the code unchanged.",
  "Handle edge cases such as empty input.",
  "Do not repeat the question.",
  "Answer in one word when one word is enough.",
  "Prefer correctness over brevity.",
  "State any assumption in one short sentence before using it.",
  "Keep the names, order and formatting of the input.",
]);

/** Coding directives, tried on the code task only (ADR-070). */
export const CODE_PROMPTS = freezeDeep([
  "Return only the code, with no example usage or explanation.",
  "Write complete, runnable code with no placeholders or TODOs.",
  "Fix only the bug and leave every other line unchanged.",
  "Use the exact function name, parameters and return type requested.",
  "Read every file of the codebase before changing a function.",
  "Change the fewest functions and files needed to satisfy the request.",
  "Check the code against the failing test before you answer.",
  "Handle empty, invalid and boundary inputs explicitly.",
]);

const TOKEN_STEPS = [64, 128, 256, 512, 1024, 2048];
// The least answer length a reasoning candidate is tried with.
export const REASONING_TOKENS = 1024;

/** The user's chosen steps (2026-10-30). */
export const DEFAULT_STEPS = freezeDeep({
  // Stage 0 probes these; "cpu" is always the reference.
  device: { backends: ["cpu", "vulkan"] },
  // Tunes run side by side in lanes (ADR-033); set per PC. 0 GPU lanes runs GPU models one after another.
  lanes: { cpu: 1, gpu: 2 },
  load: {
    // Context is a fixed 16K floor, not a tunable (ADR-089).
    // Symmetric q4_0 is off the default list (lit §3: catastrophic at context);
    // the mixed K/V Pareto point is measured instead. q4_0 stays a valid opt-in.
    kvCache: ["f16", "q8_0", "q8_0:q4_0"],
    flashAttention: ["on", "off"],
    useMmap: ["on", "off"],
    batchSize: [64, 128, 256, 512, 1024, 2048],
    threads: [1, 2, 4, 6, 8, 10, 12],
    // Only taken for recurrent, hybrid or sliding-window models (node-llama-cpp docs); off unless switched on.
    checkpointing: { enabled: false, interval: [128, 256, 512, 1024, 2048], max: [4, 8, 16, 32] },
  },
  sampling: {
    temperature: [0, 0.2, 0.4, 0.6, 0.8, 1],
    maxTokens: { code: TOKEN_STEPS, comprehension: TOKEN_STEPS, recall: TOKEN_STEPS },
    // On code, 1.05 beat "off" on the search rung, while 1.1 and 1.15 tied it
    // and 1.2 lost; the unused-item confirmation then kept 1 (60 solved against
    // 59). Only 1.05 is still worth a challenger, so the default search spends
    // one candidate instead of four and keeps the same winners. A user can add
    // the wider list back through tune-grid.json.
    repeatPenalty: [1, 1.05],
    dryStrength: [0, 0.8],
    minP: [0, 0.05, 0.1, 0.15, 0.2],
    topP: [0.8, 0.85, 0.9, 0.95, 1],
    topK: [0, 20, 40],
    penalizeNewLine: [true, false],
  },
  prompt: {
    // The prompt the earlier stages answered with comes first, as the reference.
    systemPrompt: [SYSTEM_PROMPT, ...DIRECTIVE_PROMPTS],
    // Off against fully on: "deep" asks the model to think before answering; "auto" is only a nudge.
    reasoning: ["off", "deep"],
    promptRepeat: [1, 2, 3],
  },
});

const number = (min, max, integer = false) => (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
const oneOf = (...allowed) => (value) => allowed.includes(value);

/** The ranges the settings form accepts (`normalizeSettings`); a step outside one would be silently clamped. */
const VALID = Object.freeze({
  kvCache: oneOf("f16", "q8_0", "q4_0", "q8_0:q4_0"),
  flashAttention: oneOf("auto", "on", "off"),
  useMmap: oneOf("auto", "on", "off"),
  batchSize: number(32, 8192, true),
  threads: number(1, 64, true),
  interval: number(128, 32768, true),
  max: number(1, 64, true),
  temperature: number(0, 2),
  maxTokens: number(16, 8192, true),
  repeatPenalty: number(1, 2),
  dryStrength: number(0, 1),
  minP: number(0, 1),
  topP: number(0.05, 1),
  topK: number(0, 200, true),
  systemPrompt: (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 8000,
  reasoning: oneOf("off", "auto", "deep"),
  backends: oneOf("cpu", "vulkan", "cuda"),
  cpuLanes: number(1, 4, true),
  gpuLanes: number(0, 4, true),
  promptRepeat: number(1, 3, true),
});

function cleanList(name, input, fallback, check, problems) {
  if (input === undefined) return [...fallback];
  const list = Array.isArray(input) ? input : [input];
  const kept = [];
  for (const value of list) {
    const shown = typeof value === "string" && value.length > 40 ? `${value.slice(0, 40)}…` : value;
    if (!check(value)) problems.push(`${name} ${shown === "" ? "(empty)" : shown} is outside the allowed range and was dropped`);
    else if (!kept.includes(value)) kept.push(value);
  }
  if (!kept.length) {
    problems.push(`${name} had no usable steps; its defaults are used`);
    return [...fallback];
  }
  return typeof kept[0] === "number" ? kept.sort((left, right) => left - right) : kept;
}

/** Validate a user step file: unknown or out-of-range values are dropped and reported, missing axes use the defaults. */
export function normalizeSteps(input = {}) {
  const problems = [];
  const load = input?.load ?? {};
  const sampling = input?.sampling ?? {};
  const prompt = input?.prompt ?? {};
  const defaults = DEFAULT_STEPS;
  const list = (name, value, fallback, check = VALID[name]) => cleanList(name, value, fallback, check, problems);
  const checkpointing = load.checkpointing ?? {};
  const backends = list("backends", input?.device?.backends, defaults.device.backends);
  const lane = (key, check) => {
    const value = input?.lanes?.[key];
    if (value === undefined) return defaults.lanes[key];
    if (check(value)) return value;
    problems.push(`lanes.${key} ${value} is outside the allowed range; the default ${defaults.lanes[key]} is used`);
    return defaults.lanes[key];
  };
  const steps = {
    lanes: { cpu: lane("cpu", VALID.cpuLanes), gpu: lane("gpu", VALID.gpuLanes) },
    device: { backends: backends.includes("cpu") ? backends : ["cpu", ...backends] },
    load: {
      kvCache: list("kvCache", load.kvCache, defaults.load.kvCache),
      flashAttention: list("flashAttention", load.flashAttention, defaults.load.flashAttention),
      useMmap: list("useMmap", load.useMmap, defaults.load.useMmap),
      batchSize: list("batchSize", load.batchSize, defaults.load.batchSize),
      threads: list("threads", load.threads, defaults.load.threads),
      checkpointing: {
        enabled: checkpointing.enabled === true,
        interval: list("checkpointing.interval", checkpointing.interval, defaults.load.checkpointing.interval, VALID.interval),
        max: list("checkpointing.max", checkpointing.max, defaults.load.checkpointing.max, VALID.max),
      },
    },
    sampling: {
      temperature: list("temperature", sampling.temperature, defaults.sampling.temperature),
      maxTokens: Object.fromEntries(Object.entries(defaults.sampling.maxTokens).map(([task, fallback]) => [ // aikit:allow-secret token budgets
        task,
        list(`maxTokens.${task}`, sampling.maxTokens?.[task], fallback, VALID.maxTokens),
      ])),
      repeatPenalty: list("repeatPenalty", sampling.repeatPenalty, defaults.sampling.repeatPenalty),
      dryStrength: list("dryStrength", sampling.dryStrength, defaults.sampling.dryStrength, VALID.dryStrength),
      minP: list("minP", sampling.minP, defaults.sampling.minP),
      topP: list("topP", sampling.topP, defaults.sampling.topP),
      topK: list("topK", sampling.topK, defaults.sampling.topK),
      penalizeNewLine: list("penalizeNewLine", sampling.penalizeNewLine, defaults.sampling.penalizeNewLine, (value) => typeof value === "boolean"),
    },
    prompt: {
      systemPrompt: list("systemPrompt", prompt.systemPrompt, defaults.prompt.systemPrompt),
      reasoning: list("reasoning", prompt.reasoning, defaults.prompt.reasoning),
      promptRepeat: list("promptRepeat", prompt.promptRepeat, defaults.prompt.promptRepeat),
    },
  };
  return { steps, problems };
}

/** Thread steps that leave a quarter of the logical threads free, so a tune never takes the whole computer. */
export function threadSteps(values, { logicalCores = 8 } = {}) {
  const cap = Math.max(1, Math.floor(logicalCores * 0.75));
  const kept = values.filter((count) => count >= 1 && count <= cap);
  return kept.length ? kept : [1];
}

/** llama.cpp refuses a quantized V cache without flash attention, and ModelDuck turns flash on for one anyway. */
export function isValidCombination(settings) {
  return !(settings.kvCache && settings.kvCache !== "f16" && settings.flashAttention === "off");
}

const axis = (name, key, values, extra = {}) =>
  Object.freeze({ name, patches: Object.freeze(values.map((value) => Object.freeze({ [key]: value }))), ...extra });

/** Stage 1: load settings that can change answers. Context is fixed at the 16K floor (ADR-089). */
export function qualityAxes(steps = DEFAULT_STEPS.load) {
  return Object.freeze([axis("kvCache", "kvCache", steps.kvCache)]);
}

/** Stage 2: load settings that only change speed, measured on a fixed workload. */
export function speedAxes(hardware = {}, steps = DEFAULT_STEPS.load) {
  const axes = [
    axis("flashAttention", "flashAttention", steps.flashAttention),
    axis("useMmap", "useMmap", steps.useMmap),
    axis("batchSize", "batchSize", steps.batchSize),
    axis("threads", "threads", threadSteps(steps.threads, hardware)),
  ];
  if (steps.checkpointing?.enabled) {
    const patches = [{ checkpoints: false }];
    for (const checkpointInterval of steps.checkpointing.interval) {
      for (const checkpointMax of steps.checkpointing.max) patches.push({ checkpoints: true, checkpointInterval, checkpointMax });
    }
    axes.push(Object.freeze({ name: "checkpointing", patches: Object.freeze(patches.map(Object.freeze)) }));
  }
  return Object.freeze(axes);
}

/**
 * One sampler-profile axis instead of three interacting ones (G2): temperature
 * interacts with min-p and top-p, so once temperature 0 wins those three are
 * skipped as no-ops and combinations like "T 0.2 with min-p 0.1" are never
 * tried. Each profile pairs a temperature from the user's steps with the
 * nearest min-p/top-p to a known-good combination; greedy stays alone.
 * Low temperatures pair with truncated top-p (0.8): untruncated tails hurt
 * code, where top-p matters more than temperature (lit review §1).
 */
export function samplerProfiles(
  temperatures = DEFAULT_STEPS.sampling.temperature,
  minPs = DEFAULT_STEPS.sampling.minP,
  topPs = DEFAULT_STEPS.sampling.topP,
) {
  const nearest = (list, target) => {
    if (!list.length) return target;
    return list.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), list[0]);
  };
  const combos = [];
  for (const temperature of temperatures) {
    if (temperature === 0) combos.push({ temperature: 0 });
    else if (temperature <= 0.4) {
      combos.push({ temperature, minP: nearest(minPs, 0.1), topP: nearest(topPs, 0.75) });
    } else if (temperature <= 0.8) {
      combos.push({ temperature, minP: nearest(minPs, 0.05), topP: nearest(topPs, 0.9) });
    } else {
      combos.push({ temperature, minP: nearest(minPs, 0), topP: nearest(topPs, 0.85) });
    }
  }
  const seen = new Set();
  return combos.filter((combo) => {
    const key = JSON.stringify(combo);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const multiAxis = (name, patches, extra = {}) => Object.freeze({ name, patches: Object.freeze(patches.map((patch) => Object.freeze({ ...patch }))), ...extra });

/**
 * Stage 3: sampling for one task. The sampler profile first (temperature with
 * its min-p/top-p); top-k only drops unlikely tokens, so it is skipped for
 * greedy answers and only tuned when min-p is 0 (G1).
 */
export function samplingAxes(taskId, steps = DEFAULT_STEPS.sampling) {
  const axes = [
    multiAxis("sampler", samplerProfiles(steps.temperature, steps.minP, steps.topP)),
    axis("maxTokens", "maxTokens", steps.maxTokens[taskId] ?? steps.maxTokens.code),
    axis("repeatPenalty", "repeatPenalty", steps.repeatPenalty),
    // DRY penalizes repeated sequences, not repeated tokens, so it fits code
    // (lit review §2): tried on the code task only, off against the measured on.
    ...(taskId === "code" ? [axis("dry", "dryStrength", steps.dryStrength ?? [0, 0.8])] : []),
    // No code-fence axis: a "```" prefix plus closing stop amputates the code
    // on this suite (39 vs 1, p≈7e-12, replicated 7 vs 1) — the stop fires
    // mid-answer and the checkers fail the stump. The serving plumbing stays
    // for explicit user presets, but the search does not offer it.
    axis("penalizeNewLine", "penalizeNewLine", steps.penalizeNewLine ?? [true, false], {
      skipWhen: (current) => (current.repeatPenalty ?? 1) === 1,
      skipReason: "repeat penalty 1: newlines are not penalized at all",
    }),
    axis("topK", "topK", steps.topK, {
      greedyNoop: true,
      skipWhen: (current) => (current.minP ?? 0) !== 0,
      skipReason: "top-k is only tuned when min-p is 0",
    }),
  ];
  return Object.freeze(axes);
}

/** Stage 4: prompt wording for one task. Every system prompt gets a full score on the task's whole set; code uses its own directives and also tries reasoning "auto" (ADR-070). */
export function promptAxes(steps = DEFAULT_STEPS.prompt, task = null) {
  const systemPrompts = Array.isArray(steps.systemPrompt) ? steps.systemPrompt : DEFAULT_STEPS.prompt.systemPrompt;
  const reasoningSteps = Array.isArray(steps.reasoning) ? steps.reasoning : DEFAULT_STEPS.prompt.reasoning;
  const promptRepeats = Array.isArray(steps.promptRepeat) ? steps.promptRepeat : DEFAULT_STEPS.prompt.promptRepeat;
  const customPrompts = JSON.stringify(systemPrompts) !== JSON.stringify(DEFAULT_STEPS.prompt.systemPrompt);
  const customReasoning = JSON.stringify(reasoningSteps) !== JSON.stringify(DEFAULT_STEPS.prompt.reasoning);
  return Object.freeze([
    axis("systemPrompt", "systemPrompt", task === "code" && !customPrompts ? [SYSTEM_PROMPT, ...CODE_PROMPTS] : systemPrompts, { full: true }),
    // Thinking first needs room: a reasoning candidate gets at least REASONING_TOKENS, and the preset keeps them (ADR-046).
    axis("reasoning", "reasoning", task === "code" && !customReasoning ? ["off", "auto", "deep"] : reasoningSteps, {
      extraKeys: ["maxTokens"],
      widen: (current, patch) => (patch.reasoning === "off" ? patch : { ...patch, maxTokens: Math.max(Number(current.maxTokens) || 0, REASONING_TOKENS) }), // aikit:allow-secret token budget
    }),
    // Repeating the prompt costs prefill; recall gained from a second copy, and
    // code tests the same counts now (the user asked for code too).
    axis("promptRepeat", "promptRepeat", promptRepeats),
  ]);
}

/** Every setting name a tune can run on its own (`--settings`), in stage order. */
export function settingNames() {
  const load = { ...DEFAULT_STEPS.load, checkpointing: { ...DEFAULT_STEPS.load.checkpointing, enabled: true } };
  return ["device", ...qualityAxes(load), ...speedAxes({ logicalCores: 64 }, load), ...samplingAxes("code"), ...promptAxes()].map((axis) => axis.name ?? axis);
}

/** Answers one axis costs under successive halving: every value on the first rung, the better half on each next one. */
function axisAnswers(count, rungSizes, seeds, full = false) {
  if (full) return count * rungSizes.at(-1) * seeds;
  let answers = count * rungSizes[0];
  let kept = count;
  for (let index = 1; index < rungSizes.length; index += 1) {
    kept = Math.min(kept, Math.max(2, Math.ceil(kept / 2)));
    answers += kept * (rungSizes[index] - rungSizes[index - 1]);
  }
  return answers * seeds;
}

/** The first rung of each task and stage, for a provisional pass with no held-back check yet. */
export function quickRungs(rungs, tasks = ["code", "comprehension", "recall"]) {
  const copy = { ...rungs, holdout: {} };
  copy.load = rungs.load.slice(0, 1);
  copy.speed = rungs.speed.slice(0, 1);
  copy.loadByTask = Object.fromEntries(tasks.map((task) => [task, (rungs.loadByTask?.[task] ?? []).slice(0, 1)]));
  for (const task of tasks) copy[task] = rungs[task].slice(0, 1);
  return copy;
}

function stageCost(axes, sizes, seeds, secondsPerAnswer, reloadSeconds = 0) {
  const entry = { configs: 0, answers: 0, seconds: 0 };
  // A memory-budget axis asks no questions (ADR-043).
  for (const { patches, full } of axes.filter((axis) => !axis.budget)) {
    const answers = axisAnswers(patches.length, sizes, seeds, full);
    entry.configs += patches.length;
    entry.answers += answers;
    entry.seconds += answers * secondsPerAnswer + patches.length * reloadSeconds;
  }
  return entry;
}

/**
 * Rough cost of one coordinate-descent pass, before a tune starts. Sampling
 * and prompt stages count every seed and every axis, so they are upper bounds;
 * a second pass only runs when the first changed something. Tolerant halving
 * can keep more than half, so the halving counts are a lower bound; the
 * confirmation rung (S1) is counted as an upper bound instead.
 */
export function estimateTune(steps, { logicalCores = 8, tasks = ["code", "comprehension", "recall"], stages = ["device", "quality", "speed", "sampling", "prompt"], only = null, secondsPerAnswer = 3, reloadSeconds = 5, seeds = 3, quick = false } = {}) {
  const allRungs = tuneRungs(tasks);
  const rungs = quick ? quickRungs(allRungs, tasks) : allRungs;
  // Upper bound on confirmation answers for one task (S1): every counted
  // sampling/prompt sweep re-scores two configs on the pool the rungs leave
  // out. Quick and targeted runs skip confirmation, as does a small pool.
  const confirmFor = (task, axesCount) => {
    if (quick || only) return 0;
    const unused = Math.max(0, (allRungs.pool?.[task]?.length ?? 0) - (allRungs[task].at(-1)?.length ?? 0));
    if (unused < 8) return 0;
    return axesCount * 2 * unused * seeds;
  };
  const wanted = (stage, axes) => stages.includes(stage) && (!only || axes.some((axis) => only.includes(axis.name ?? axis)));
  const deviceAxes = [{ patches: steps.device.backends, name: "device" }];
  const quality = qualityAxes(steps.load);
  const speed = speedAxes({ logicalCores }, steps.load);
  const device = wanted("device", ["device"])
    ? stageCost(deviceAxes, [speedItems().length], 1, secondsPerAnswer, reloadSeconds)
    : { configs: 0, answers: 0, seconds: 0 };
  const qualityCost = wanted("quality", quality)
    ? stageCost(quality.filter((axis) => !only || only.includes(axis.name)), rungs.load.map((rung) => rung.length), 1, secondsPerAnswer, 2 * reloadSeconds)
    : { configs: 0, answers: 0, seconds: 0 };
  const speedCost = wanted("speed", speed)
    ? stageCost(speed.filter((axis) => !only || only.includes(axis.name)), [speedItems().length], 1, secondsPerAnswer, reloadSeconds)
    : { configs: 0, answers: 0, seconds: 0 };
  const sampling = {};
  const prompt = {};
  const confirm = {};
  for (const task of tasks) {
    const sizes = rungs[task].map((rung) => rung.length);
    const samplingAxesFor = samplingAxes(task, steps.sampling);
    const promptAxesFor = promptAxes(steps.prompt, task);
    const samplingWanted = wanted("sampling", samplingAxesFor) ? samplingAxesFor.filter((axis) => !only || only.includes(axis.name)) : [];
    const promptWanted = wanted("prompt", promptAxesFor) ? promptAxesFor.filter((axis) => !only || only.includes(axis.name)) : [];
    sampling[task] = samplingWanted.length
      ? stageCost(samplingWanted, sizes, seeds, secondsPerAnswer)
      : { configs: 0, answers: 0, seconds: 0 };
    prompt[task] = promptWanted.length
      ? stageCost(promptWanted, sizes, seeds, secondsPerAnswer)
      : { configs: 0, answers: 0, seconds: 0 };
    const confirmAnswers = confirmFor(task, samplingWanted.length + promptWanted.length);
    confirm[task] = { configs: 0, answers: confirmAnswers, seconds: confirmAnswers * secondsPerAnswer };
  }
  const perTask = (entries) => Object.values(entries).reduce((sum, entry) => sum + entry.seconds, 0);
  const onePassSeconds = Math.round(device.seconds + qualityCost.seconds + speedCost.seconds + perTask(sampling) + perTask(prompt) + perTask(confirm));
  return { device, quality: qualityCost, speed: speedCost, sampling, prompt, confirm, onePassSeconds, worstCaseSeconds: onePassSeconds * 2 };
}

/**
 * At most how many answers a run of `stages` (or only the `only` settings) asks in one
 * pass: the denominator of its time left (ADR-045). Sampling and prompt count every
 * seed, so it is an upper bound; a memory-budget axis asks none.
 */
export function expectedAnswers(steps, { logicalCores = 8, tasks = ["code", "comprehension", "recall"], stages = ["device", "quality", "speed", "sampling", "prompt"], only = null, seeds = 3, quick = false } = {}) {
  const allRungs = tuneRungs(tasks);
  const rungs = quick ? quickRungs(allRungs, tasks) : allRungs;
  const chosen = (axes) => axes.filter((axis) => !axis.budget && (!only || only.includes(axis.name)));
  const cost = (axes, sizes, seedCount) => chosen(axes).reduce((sum, axis) => sum + axisAnswers(axis.patches.length, sizes, seedCount, axis.full), 0);
  let total = 0;
  if (stages.includes("device") && (!only || only.includes("device"))) total += steps.device.backends.length * speedItems().length;
  if (stages.includes("quality")) total += cost(qualityAxes(steps.load), rungs.load.map((rung) => rung.length), 1);
  if (stages.includes("speed")) total += cost(speedAxes({ logicalCores }, steps.load), [speedItems().length], 1);
  for (const task of tasks) {
    const sizes = rungs[task].map((rung) => rung.length);
    let axesCount = 0;
    if (stages.includes("sampling")) {
      const axes = chosen(samplingAxes(task, steps.sampling));
      total += axes.reduce((sum, axis) => sum + axisAnswers(axis.patches.length, sizes, seeds, axis.full), 0);
      axesCount += axes.length;
    }
    if (stages.includes("prompt")) {
      const axes = chosen(promptAxes(steps.prompt, task));
      total += axes.reduce((sum, axis) => sum + axisAnswers(axis.patches.length, sizes, seeds, axis.full), 0);
      axesCount += axes.length;
    }
    // The final preset and the defaults on the held-back items (ADR-054).
    if (!only && (stages.includes("sampling") || stages.includes("prompt"))) total += 2 * (rungs.holdout?.[task]?.length ?? 0) * seeds;
    // Upper bound on the confirmation rung (S1): two configs per counted sweep
    // on the pool the rungs leave out; quick and targeted runs skip it.
    if (!quick && !only) {
      const unused = Math.max(0, (allRungs.pool?.[task]?.length ?? 0) - (allRungs[task].at(-1)?.length ?? 0));
      if (unused >= 8) total += axesCount * 2 * unused * seeds;
    }
  }
  return total;
}

/** "about 25 min left" from the pace so far; null before the first answer, and no number past the estimate. */
export function timeLeft({ answers, expected, elapsedMs }) {
  if (!(answers > 0) || !(elapsedMs > 0)) return null;
  if (answers >= expected) return "finishing up (a second pass)";
  const seconds = ((expected - answers) * elapsedMs) / answers / 1000;
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min left` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}
