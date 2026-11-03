import { createHash } from "node:crypto";

import { AppError } from "../src/errors.js";
import { PROMPTS, SUITE_VERSION } from "./suite.mjs";

/**
 * The kinds of work a tuned profile has a preset for. Every suite item belongs
 * to exactly one task, so a tune never scores the same item twice.
 */
export const TASKS = Object.freeze([
  Object.freeze({ id: "code", label: "Code", categories: Object.freeze(["code", "code-long", "code-repo", "bugfix", "bugfix-long", "bugfix-repo", "public-code"]) }),
  Object.freeze({ id: "comprehension", label: "Code comprehension", categories: Object.freeze(["code-comprehension"]) }),
  Object.freeze({ id: "recall", label: "Long context", categories: Object.freeze(["context", "recall"]) }),
]);

/** Item counts of the successive-halving rungs; a rung stops at the task's tuning items. */
export const TASK_RUNGS = Object.freeze([12, 24, 48]);

/** The share of each task never tuned on, to check the chosen preset on unseen items (ADR-054). */
export const HOLDOUT_SHARE = 0.25;

/** The coding work a preset can be selected for; categories that ask the same kind of question (ADR-070). */
export const CODE_GROUPS = Object.freeze({
  write: Object.freeze(["code", "code-long", "public-code"]),
  fix: Object.freeze(["bugfix", "bugfix-long"]),
  repo: Object.freeze(["code-repo", "bugfix-repo"]),
});

const CODE_GROUP_OF = new Map(Object.entries(CODE_GROUPS).flatMap(([group, categories]) => categories.map((category) => [category, group])));

/** The task an item category belongs to, or null. */
export function taskIdOfCategory(category) {
  return TASKS.find((task) => task.categories.includes(category))?.id ?? null;
}

/** The coding view an item's category belongs to, or null for other tasks. */
export function codeGroupOf(category) {
  return CODE_GROUP_OF.get(category) ?? null;
}

function taskOf(taskId) {
  const task = TASKS.find((item) => item.id === taskId);
  if (task) return task;
  throw new AppError("Unknown benchmark task", {
    code: "unknown_task",
    why: `Unknown task "${taskId}".`,
    fix: `Use one of: ${TASKS.map((item) => item.id).join(", ")}.`,
  });
}

/** The task's items in suite order. */
export function taskPrompts(taskId, prompts = PROMPTS) {
  const { categories } = taskOf(taskId);
  return prompts.filter((prompt) => categories.includes(prompt.category));
}

/**
 * Deal items round-robin across family buckets so a small rung samples the whole
 * task instead of its first category.
 */
function bucketKey(prompt) {
  return `${prompt.category}/${prompt.group ?? prompt.source?.dataset ?? "own"}`; // aikit:allow-secret bucket label
}

function stratified(prompts) {
  const buckets = new Map();
  for (const prompt of prompts) {
    const key = bucketKey(prompt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(prompt.id);
  }
  const queues = [...buckets.values()];
  const order = [];
  while (order.length < prompts.length) {
    for (const queue of queues) if (queue.length) order.push(queue.shift());
  }
  return order;
}

/**
 * A task split into the items tuned on and those held back (S5). By default
 * a share of every family bucket is held back, spread evenly through the
 * bucket by midpoint, so each kind of item is checked unseen, both in
 * stratified order. When every bucket is tiny
 * (one function = one bucket), splitting buckets would tear clusters apart
 * and shrink the tuned pool below rung size: every fourth bucket is held
 * back wholly instead, so whole functions stay unseen (S4/S5) while the
 * tuned pool keeps full rungs. Long-context items (M6) stay out of both:
 * the search rungs and the holdout keep their sizes, and the quality stage
 * consults them separately.
 */
function split(taskId, prompts) {
  const items = taskPrompts(taskId, prompts).filter((prompt) => !prompt.longContext);
  const buckets = new Map();
  for (const prompt of items) {
    const key = bucketKey(prompt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(prompt.id);
  }
  let held;
  if ([...buckets.values()].every((ids) => ids.length <= 2)) {
    const keys = [...buckets.keys()].sort();
    held = new Set(keys.filter((_key, index) => index % 4 === 3).flatMap((key) => buckets.get(key)));
  } else {
    held = new Set([...buckets.values()].flatMap((ids) => {
      const count = Math.round(ids.length * HOLDOUT_SHARE);
      if (!count) return [];
      return Array.from({ length: count }, (_, index) =>
        ids[Math.floor(((index + 0.5) * ids.length) / count)]);
    }));
  }
  const order = stratified(items);
  return { tune: order.filter((id) => !held.has(id)), held: order.filter((id) => held.has(id)) };
}

/** Long-context KV confirmation items (M6): searched never, used only to confirm a KV choice at the budgeted context. */
export function taskLongContext(taskId, prompts = PROMPTS) {
  return taskPrompts(taskId, prompts).filter((prompt) => prompt.longContext).map((prompt) => prompt.id);
}

/** The items a task holds back from tuning, across its categories. */
export function taskHoldout(taskId, prompts = PROMPTS) {
  return split(taskId, prompts).held;
}

/** Nested item-id lists, one per rung, each a prefix of the next, from the items tuned on. */
export function taskRungs(taskId, prompts = PROMPTS) {
  const order = split(taskId, prompts).tune;
  const rungs = [];
  for (const size of TASK_RUNGS) {
    rungs.push(order.slice(0, Math.min(size, order.length)));
    if (size >= order.length) break;
  }
  return rungs;
}

/** Rungs for `tune()`: each task's own, and for the load stage the union of every task's first two. */
export function tuneRungs(taskIds = TASKS.map((task) => task.id), prompts = PROMPTS) {
  const rungs = Object.fromEntries(taskIds.map((taskId) => [taskId, taskRungs(taskId, prompts)]));
  rungs.load = [0, 1].map((index) => taskIds.flatMap((taskId) => rungs[taskId][index] ?? rungs[taskId].at(-1)));
  rungs.speed = [speedItems(prompts)];
  // Each task's share of the last load level, to check the shared quality settings per task (ADR-057).
  rungs.loadByTask = Object.fromEntries(taskIds.map((taskId) => [taskId, rungs[taskId][1] ?? rungs[taskId].at(-1)]));
  rungs.holdout = Object.fromEntries(taskIds.map((taskId) => [taskId, taskHoldout(taskId, prompts)]));
  // The full tuning pool per task: rungs are prefixes of it, and whatever the
  // search rungs leave out confirms a rung leader before it stands (S1/S3).
  rungs.pool = Object.fromEntries(taskIds.map((taskId) => [taskId, split(taskId, prompts).tune]));
  // Long-context KV confirmation items (M6): searched never.
  rungs.longContext = Object.fromEntries(taskIds.map((taskId) => [taskId, taskLongContext(taskId, prompts)]));
  return rungs;
}

/**
 * Rebuild each task's search rungs from the items that have not saturated for
 * this model, keeping the rung sizes, and keep the whole tuning set for the
 * final check (`final`). A task with too few discriminating items keeps every
 * item, so a filtered search never rests on a handful of questions (ADR-064).
 * A deterministic 10% of saturated items is re-admitted (S6): `salt` rotates
 * the subset (per model by default), so drift is caught without re-asking all.
 */
function hash32(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash;
}

export function withDiscriminatingRungs(rungs, saturated = null, taskIds = TASKS.map((task) => task.id).filter((id) => Array.isArray(rungs[id])), { salt = "", readmitFraction = 0.1 } = {}) {
  const search = { ...rungs, final: {} };
  const tunedOn = {};
  const readmit = (id) => saturated?.has(id) && hash32(`${salt}\n${id}`) % 10 < Math.round(readmitFraction * 10);
  for (const taskId of taskIds) {
    const full = rungs[taskId].at(-1);
    search.final[taskId] = full;
    const keep = saturated ? full.filter((id) => !saturated.has(id) || readmit(id)) : full;
    if (keep.length < Math.min(TASK_RUNGS[0], full.length)) {
      tunedOn[taskId] = { items: full.length, ids: full, excluded: [], fellBack: true };
      continue;
    }
    const sizes = [...new Set(rungs[taskId].map((rung) => Math.min(rung.length, keep.length)))];
    search[taskId] = sizes.map((size) => keep.slice(0, size));
    tunedOn[taskId] = { items: full.length, ids: keep, excluded: full.filter((id) => !keep.includes(id)), fellBack: false };
  }
  search.load = [0, 1].map((index) => taskIds.flatMap((taskId) => search[taskId][index] ?? search[taskId].at(-1)));
  search.loadByTask = Object.fromEntries(taskIds.map((taskId) => [taskId, search[taskId][1] ?? search[taskId].at(-1)]));
  return { rungs: search, tunedOn };
}

/** The speed stage's fixed workload: the first item of every task, then a second item for each task. Long-context items (M6) stay out: a 16k-token prefill would dominate the workload and is not what the speed settings are chosen for. */
export function speedItems(prompts = PROMPTS) {
  const order = (taskId) => stratified(taskPrompts(taskId, prompts).filter((prompt) => !prompt.longContext));
  return [
    ...TASKS.map((task) => order(task.id)[0]),
    order("code")[1],
    order("comprehension")[1],
    order("recall")[1],
  ];
}

/** Hash of every item definition a tune can ask, by task; part of a profile's comparability key. */
export function taskSubsetHash(prompts = PROMPTS) {
  const definition = {
    suiteVersion: SUITE_VERSION,
    rungs: TASK_RUNGS,
    holdout: HOLDOUT_SHARE,
    tasks: TASKS.map((task) => ({ id: task.id, items: taskPrompts(task.id, prompts) })),
  };
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
}

/**
 * What the suite asks, per task and question type: item counts, where the items come
 * from, how answers are checked, and how many are held back from tuning.
 */
export function suiteSummary(prompts = PROMPTS) {
  const tasks = TASKS.map((task) => {
    const items = taskPrompts(task.id, prompts);
    const held = new Set(taskHoldout(task.id, prompts));
    const rungs = taskRungs(task.id, prompts);
    const types = task.categories.map((category) => {
      const ofType = items.filter((prompt) => prompt.category === category);
      return {
        category,
        items: ofType.length,
        held: ofType.filter((prompt) => held.has(prompt.id)).length,
        sources: [...new Set(ofType.map((prompt) => prompt.source?.dataset ?? "own"))].sort(),
        checks: [...new Set(ofType.flatMap((prompt) => prompt.checks.map((check) => check.type)))].sort(),
      };
    }).filter((type) => type.items);
    return { id: task.id, label: task.label, items: items.length, held: held.size, tunedOn: rungs.at(-1).length, rungs: rungs.map((rung) => rung.length), types };
  });
  return { suiteVersion: SUITE_VERSION, items: prompts.length, holdoutShare: HOLDOUT_SHARE, tasks };
}
