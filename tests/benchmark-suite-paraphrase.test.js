import assert from "node:assert/strict";
import test from "node:test";

import { PROMPTS } from "../benchmarks/suite.mjs";
import { TASKS, taskHoldout, taskPrompts, taskRungs } from "../benchmarks/tasks.mjs";

const PARAPHRASES = PROMPTS.filter((prompt) => prompt.paraphrase);
const byId = new Map(PROMPTS.map((prompt) => [prompt.id, prompt]));

/** Sentences of the prose around the fenced code block, terminal punctuation delimited. */
const sentences = (text) =>
  text.replace(/```[\s\S]*?```/g, " ").split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;

test("the suite carries twelve paraphrase probes over the code and comprehension lanes", () => {
  assert.equal(PARAPHRASES.length, 12, "six code probes and six comprehension probes");
  assert.deepEqual([...new Set(PARAPHRASES.map((prompt) => prompt.category))].sort(), ["code", "code-comprehension"]);
  for (const prompt of PARAPHRASES) {
    assert.equal(prompt.baseId, byId.get(prompt.baseId)?.id, `paraphrase ${prompt.id} references a real base item`);
    assert.ok(prompt.id.startsWith("para-"), `paraphrase ids are visibly paraphrases: ${prompt.id}`);
  }
});

test("a paraphrase probe mirrors its base contract verbatim", () => {
  for (const prompt of PARAPHRASES) {
    const base = byId.get(prompt.baseId);
    assert.ok(base, `base of ${prompt.id} exists`);
    assert.equal(prompt.category, base.category, `${prompt.id} stays in its base's lane`);
    assert.equal(prompt.maxTokens, base.maxTokens, `${prompt.id} keeps the base's answer budget`);
    assert.deepEqual(prompt.checks, base.checks, `${prompt.id} checks the identical contract`);
  }
});

test("paraphrase probes span the one-, two- and three-sentence strata per lane", () => {
  const strata = { code: {}, "code-comprehension": {} };
  for (const prompt of PARAPHRASES) {
    const count = sentences(prompt.prompt);
    assert.ok([1, 2, 3].includes(count), `${prompt.id} is 1, 2 or 3 sentences, not ${count}`);
    strata[prompt.category][count] = (strata[prompt.category][count] ?? 0) + 1;
  }
  for (const [category, counts] of Object.entries(strata)) {
    assert.deepEqual(counts, { 1: 2, 2: 2, 3: 2 }, `${category} has two probes per sentence stratum`);
  }
});

test("paraphrase probes are held back, never searched", () => {
  for (const task of TASKS) {
    const paraphraseIds = new Set(taskPrompts(task.id).filter((prompt) => prompt.paraphrase).map((prompt) => prompt.id));
    if (!paraphraseIds.size) continue;
    const held = new Set(taskHoldout(task.id));
    const searched = new Set(taskRungs(task.id).flat());
    for (const id of paraphraseIds) {
      assert.ok(held.has(id), `${id} is in ${task.id}'s holdout`);
      assert.ok(!searched.has(id), `${id} never enters ${task.id}'s search rungs`);
    }
  }
});
