import { AppError } from "../src/errors.js";
import { PROMPTS, SYSTEM_PROMPT } from "./suite.mjs";

/** The most answers a tune may run at once. The engine allows 8; past 4 a laptop gains little. */
export const MAX_PARALLEL = 4;

/** The engine never builds a context under 16K tokens for coding (ADR-089), so this is what the slots share. */
const CONTEXT_FLOOR = 16384;

/** Characters per token for sizing, kept pessimistic so a slot is never overbooked. */
const CHARS_PER_TOKEN = 3;

const whole = (value) => (Number.isFinite(Number(value)) ? Math.floor(Number(value)) : NaN);

/**
 * The tokens one item needs from its slot: the prompt, the system prompt and
 * the answer budget. The setting's budget wins over the item's own.
 */
export function itemNeed(prompt, { systemPrompt = "", maxTokens = null } = {}) {
  const chars = String(prompt?.prompt ?? "").length + String(systemPrompt ?? "").length;
  const answer = whole(maxTokens ?? prompt?.maxTokens ?? 512);
  return Math.ceil(chars / CHARS_PER_TOKEN) + (answer > 0 ? answer : 512);
}

/**
 * How many answers one call may run at once. Sequences share the context, so
 * with `n` of them each slot holds `context / n` tokens: the width is the
 * largest `n` (up to `parallel`) whose slot still holds the largest item.
 */
export function slotWidth({ parallel, contextSize, need }) {
  const wanted = Math.min(MAX_PARALLEL, whole(parallel));
  const largest = whole(need);
  if (!(wanted >= 1) || !(largest >= 0)) return 1;
  const total = Math.max(CONTEXT_FLOOR, whole(contextSize) || 0);
  let width = wanted;
  while (width > 1 && Math.floor(total / width) < largest) width -= 1;
  return width;
}

/**
 * How wide the tune asks to run: `auto` or a number, capped by the maximum
 * and by the machine (every answer keeps at least two cores). `reason` says
 * why the answer is narrower than the request, or is null.
 */
export function chooseParallel({ requested, logicalCores }) {
  const asked = requested === "auto" ? MAX_PARALLEL : Math.min(MAX_PARALLEL, Math.max(1, whole(requested) || 1));
  if (asked === 1) return { n: 1, reason: null };
  const cores = Math.max(1, whole(logicalCores) || 1);
  const fits = Math.max(1, Math.floor(cores / 2));
  if (fits >= asked) return { n: asked, reason: null };
  return { n: fits, reason: `${cores} logical core${cores === 1 ? "" : "s"} leave room for ${fits} answer${fits === 1 ? "" : "s"} at once, not ${asked}` };
}

/** The `--parallel` flag: `auto`, or a whole number from 1 to the maximum; absent means one at a time. */
export function parseParallel(value) {
  if (value === undefined || value === null || value === "") return 1;
  if (value === "auto") return "auto";
  const number = Number(value);
  if (Number.isInteger(number) && number >= 1 && number <= MAX_PARALLEL) return number;
  throw new AppError("--parallel needs auto or a whole number", {
    code: "tune_parallel_invalid",
    why: `"${value}" is not auto or a whole number from 1 to ${MAX_PARALLEL}.`,
    fix: `Pass --parallel auto, or --parallel 2 up to --parallel ${MAX_PARALLEL}. Leave it out to answer one at a time.`,
  });
}

/**
 * The items a probe asks: those of `ids` (a rung, in suite order) whose slot at
 * `width` holds them, so the probe really runs wide. At most `limit`.
 */
export function probeItemIds({ ids, width, limit = 4, settings = {}, prompts = PROMPTS }) {
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const fits = (id) => {
    const prompt = byId.get(id);
    if (!prompt) return false;
    const need = itemNeed(prompt, { systemPrompt: settings.systemPrompt ?? SYSTEM_PROMPT, maxTokens: settings.maxTokens ?? prompt.maxTokens ?? 512 });
    return slotWidth({ parallel: width, contextSize: settings.contextSize, need }) >= width;
  };
  return ids.filter(fits).slice(0, limit);
}

/** How many items a tune's probe asks: two calls' worth at the widest width, for more evidence than one batch. */
export const PROBE_ITEMS = 8;

/** Wide must beat one-at-a-time by this share of wall time to be kept; less is within run-to-run noise. */
export const MIN_PARALLEL_GAIN = 0.15;

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Answer the same items `width` at a time and one at a time, and keep the
 * width only when it is both safe and worth it:
 *
 * - safe: every answer is byte-identical (batching can change floating-point
 *   order in the runtime, so this is checked, not assumed);
 * - worth it: the wide pass takes at least MIN_PARALLEL_GAIN less wall time.
 *   On a CPU a small model is compute-bound, and answering together can be no
 *   faster than one at a time (measured: 16.7 s wide vs 15.6 s serial).
 *
 * With `sampled` (sampling settings merged over `settings`), a second pass
 * checks the same items sampled, since the later stages sample. The passes
 * alternate which side runs first, and each side's time is the sum over both.
 * Each side is loaded at its own width before it is timed, so a context
 * rebuild never counts against either. The probe stops paying as soon as the verdict is
 * known: a pass with a mismatch refuses without running the next one, and `expired()`
 * (the tune's time budget) is asked before every pass. Never throws: any failure
 * refuses with a reason. On success the evaluator is left at `width`, otherwise at 1.
 */
export async function probeParallel({ evaluate, width, items, settings, seed, sampled = null, expired = () => false, clock = () => performance.now(), minGain = MIN_PARALLEL_GAIN }) {
  // A greedy pass, and with `sampled` a second pass at those sampling settings:
  // the later stages sample, and greedy agreement alone does not show that.
  const passes = [{ settings, label: "" }, ...(sampled ? [{ settings: { ...settings, ...sampled }, label: " (sampled)" }] : [])];
  const total = Array.isArray(items) ? items.length * passes.length : 0;
  const refuse = (reason, extra = {}) => {
    evaluate.setParallel(1);
    return { ok: false, matched: 0, total, mismatches: [], serialMs: null, wideMs: null, speedup: null, reason, ...extra };
  };
  if (!Array.isArray(items) || items.length < 2) return refuse("the probe needs at least two items to share a context");
  const timedPass = async (at, passSettings) => {
    evaluate.setParallel(at);
    await evaluate.ensureLoaded(passSettings);
    const started = clock();
    const out = await evaluate(passSettings, items, seed);
    return { out, ms: clock() - started };
  };
  try {
    let wideMs = 0;
    let serialMs = 0;
    const mismatches = [];
    let compared = 0;
    for (const [index, pass] of passes.entries()) {
      if (expired()) return refuse(index === 0 ? "the time budget was already spent" : "the time budget ran out during the probe");
      // Wide first on even passes and second on odd ones, so a cold first pass favours neither side.
      const order = index % 2 === 0 ? [width, 1] : [1, width];
      const [first, second] = [await timedPass(order[0], pass.settings), await timedPass(order[1], pass.settings)];
      const [wide, serial] = order[0] === width ? [first, second] : [second, first];
      const failed = [...serial.out.prompts, ...wide.out.prompts].find((row) => row.error);
      if (failed) return refuse(`an answer failed during the probe: ${failed.error}`);
      const serialDigest = new Map(serial.out.prompts.map((row) => [row.id, row.digest]));
      mismatches.push(...wide.out.prompts.filter((row) => serialDigest.get(row.id) !== row.digest).map((row) => `${row.id}${pass.label}`));
      wideMs += wide.ms;
      serialMs += serial.ms;
      compared += items.length;
      // A mismatch already decides the verdict: the next pass would only cost time.
      if (mismatches.length) break;
    }
    const matched = compared - mismatches.length;
    const timing = { serialMs: Math.round(serialMs), wideMs: Math.round(wideMs), speedup: wideMs > 0 ? Math.round((serialMs / wideMs) * 100) / 100 : null };
    const wide = { ms: wideMs };
    const serial = { ms: serialMs };
    if (mismatches.length) return refuse(`${mismatches.length} of ${compared} answers differed when run ${width} at a time (${mismatches.join(", ")})`, { matched, total: compared, mismatches, ...timing });
    if (!(wide.ms <= serial.ms * (1 - minGain))) {
      return refuse(`answering ${width} at a time was not faster: ${seconds(wide.ms)} against ${seconds(serial.ms)} one at a time (needs ${Math.round(minGain * 100)}% less)`, { matched, ...timing });
    }
    evaluate.setParallel(width);
    return { ok: true, matched, total: compared, mismatches: [], ...timing, reason: null };
  } catch (error) {
    return refuse(`the probe could not run ${width} at a time: ${error?.message ?? error}`);
  }
}
