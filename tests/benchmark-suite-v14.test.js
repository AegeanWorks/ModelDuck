import assert from "node:assert/strict";
import test from "node:test";

import { codeComprehensionPrompts } from "../benchmarks/comprehension-items.mjs";
import { moreLongBugPrompts, moreLongCodePrompts } from "../benchmarks/own-items-v13.mjs";
import { PROMPTS, SMOKE_PROMPT_IDS, SUITE_VERSION, evaluateTextCheck } from "../benchmarks/suite.mjs";
import { taskHoldout, taskPrompts, taskRungs } from "../benchmarks/tasks.mjs";
import { REFERENCE_V13 as REFERENCE } from "./reference-solutions-v13.js";

const run = (code, entry, args) => {
  try {
    return JSON.stringify(new Function(`${code}\n;return ${entry};`)()(...structuredClone(args)));
  } catch (error) {
    return `threw ${error.message}`;
  }
};

const coding = [...moreLongCodePrompts(), ...moreLongBugPrompts()];
const count = (category) => PROMPTS.filter((prompt) => prompt.category === category).length;

test("suite v14 is code, code comprehension and long context only", () => {
  assert.equal(SUITE_VERSION, 18, "v18: paraphrase probes (G-003)");
  assert.equal(PROMPTS.length, 277);
  assert.equal(new Set(PROMPTS.map((prompt) => prompt.id)).size, PROMPTS.length, "ids stay unique");
  assert.equal(count("code"), 36, "30 own plus six paraphrase probes");
  assert.equal(count("code-long"), 12);
  assert.equal(count("bugfix"), 26);
  assert.equal(count("bugfix-long"), 12);
  assert.equal(count("code-repo"), 24);
  assert.equal(count("bugfix-repo"), 12);
  assert.equal(count("public-code"), 20);
  assert.equal(count("code-comprehension"), 70, "64 own plus six paraphrase probes");
  assert.equal(count("context"), 14);
  assert.equal(count("recall"), 51);
  for (const removed of ["instruction", "format", "comprehension", "knowledge", "facts", "reasoning", "public-math", "public-knowledge", "public-truthful"]) {
    assert.equal(count(removed), 0, `${removed} should not be in the coding suite`);
  }
  assert.equal(PROMPTS.some((prompt) => prompt.id === "squad"), false, "the short prose comprehension item is gone");
  for (const id of SMOKE_PROMPT_IDS) assert.ok(PROMPTS.some((prompt) => prompt.id === id), id);
});

test("the three tasks have full rungs and a held-back quarter, paraphrase probes wholly held (v18)", () => {
  assert.equal(taskPrompts("code").length, 142, "code adds six paraphrase probes");
  assert.equal(taskPrompts("comprehension").length, 70, "comprehension adds six paraphrase probes");
  assert.equal(taskPrompts("recall").length, 65);
  assert.deepEqual(taskRungs("code").map((rung) => rung.length), [12, 24, 48]);
  assert.deepEqual(taskRungs("comprehension").map((rung) => rung.length), [12, 24, 48]);
  assert.deepEqual(taskRungs("recall").map((rung) => rung.length), [12, 24, 46]);
  assert.equal(taskHoldout("comprehension").length, 22, "sixteen sampled plus six paraphrase probes");
  assert.equal(taskHoldout("recall").length, 16);
  const comprehension = taskPrompts("comprehension");
  const held = new Set(taskHoldout("comprehension"));
  const base = comprehension.filter((item) => !item.paraphrase);
  const paraphrase = comprehension.filter((item) => item.paraphrase);
  const groups = [...new Set(base.map((item) => item.group))];
  assert.equal(groups.length, 32, "each comprehension function is its own family");
  for (const group of groups) {
    const family = base.filter((item) => item.group === group);
    assert.equal(family.length, 2, `${group} has two inputs`);
    const heldCount = family.filter((item) => held.has(item.id)).length;
    assert.ok(heldCount === 0 || heldCount === 2, `${group} is held back wholly or not at all`);
  }
  const heldGroups = new Set(base.filter((item) => held.has(item.id)).map((item) => item.group));
  assert.equal(heldGroups.size, 8, "eight whole functions stay unseen");
  assert.equal(paraphrase.length, 6, "the paraphrase probes are their own family");
  assert.ok(paraphrase.every((item) => held.has(item.id)), "every paraphrase probe stays unseen by the search");
});

test("long-context KV items are seeded needles excluded from search, speed and holdout (M6)", () => {
  const longs = ["recall-long-4k", "recall-long-8k", "recall-long-16k"].map((id) => PROMPTS.find((prompt) => prompt.id === id));
  assert.ok(longs.every(Boolean), "all three long items exist");
  const kilos = [4, 8, 16];
  longs.forEach((item, index) => {
    assert.equal(item.category, "recall");
    assert.equal(item.group, "long-context", "one shared family for the cluster guards");
    assert.equal(item.longContext, true);
    assert.equal(item.maxTokens, 16);
    assert.equal(item.checks.length, 1);
    assert.ok(item.prompt.includes("VAULT-"), item.id);
    const estTokens = item.prompt.length / 4;
    assert.ok(Math.abs(estTokens - kilos[index] * 1000) < kilos[index] * 250, `${item.id} is ~${kilos[index]}k tokens, got ${Math.round(estTokens)}`);
    assert.equal(evaluateTextCheck(item.checks[0], item.checks[0].value).passed, true, `${item.id} answers its own needle`);
  });
  const longIds = new Set(longs.map((item) => item.id));
  assert.ok(!taskRungs("recall").flat().some((id) => longIds.has(id)), "never searched");
  assert.ok(!taskHoldout("recall").some((id) => longIds.has(id)), "never held out");
});

test("the 16-item smoke set covers every task and five comprehension families", () => {
  assert.equal(SMOKE_PROMPT_IDS.length, 16);
  const smoke = SMOKE_PROMPT_IDS.map((id) => PROMPTS.find((item) => item.id === id));
  assert.ok(smoke.every(Boolean));
  assert.ok(smoke.some((item) => item.category === "recall"));
  assert.ok(smoke.some((item) => item.category === "context"));
  assert.ok(smoke.some((item) => item.category === "code-repo"));
  const families = new Set(smoke.filter((item) => item.category === "code-comprehension").map((item) => item.group));
  assert.equal(families.size, 5);
});

test("every code-comprehension item asks about the code it shows and has an exact answer", () => {
  const items = codeComprehensionPrompts();
  assert.equal(items.length, 64);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  const task = new Set(taskPrompts("comprehension").map((item) => item.id));
  for (const item of items) {
    assert.ok(task.has(item.id), item.id);
    assert.equal(item.category, "code-comprehension");
    assert.equal(item.maxTokens, 32);
    assert.match(item.prompt, /function\s+\w+/);
    assert.match(item.prompt, new RegExp(`\\b${item.id.split("-")[1]}\\(`));
    assert.equal(item.checks.length, 1);
    assert.equal(item.checks[0].type, "exact");
    assert.equal(evaluateTextCheck(item.checks[0], item.checks[0].value).passed, true, item.id);
  }
  assert.equal(items.find((item) => item.id === "read-sumTo-2").checks[0].value, "55");
  assert.equal(items.find((item) => item.id === "read-factorial-2").checks[0].value, "24");
});

test("every new long function passes its cases with a reference answer", () => {
  for (const item of coding) {
    const check = item.checks[0];
    assert.ok(REFERENCE[check.entry], `${item.id} has a reference`);
    for (const testCase of check.cases) {
      assert.equal(run(REFERENCE[check.entry], check.entry, testCase.args), JSON.stringify(testCase.expect), `${item.id} ${JSON.stringify(testCase.args)}`);
    }
  }
});

test("every new buggy function is long and fails its own tests", () => {
  for (const item of moreLongBugPrompts()) {
    const check = item.checks[0];
    assert.ok(item.buggyCode.split("\n").length >= 8, `${item.id} is a long function`);
    assert.equal(item.maxTokens, 1024, item.id);
    const failing = check.cases.filter((testCase) => run(item.buggyCode, check.entry, testCase.args) !== JSON.stringify(testCase.expect));
    assert.ok(failing.length >= 2, `${item.id} has more than one failing case`);
  }
});
