import assert from "node:assert/strict";
import test from "node:test";

import { CODING_CATEGORIES } from "../benchmarks/recommend.mjs";
import { PROMPTS, SUITE_VERSION } from "../benchmarks/suite.mjs";
import { taskPrompts } from "../benchmarks/tasks.mjs";
import { moreLongBugPrompts, moreLongCodePrompts } from "../benchmarks/own-items-v13.mjs";

// The v9 items alone; suite v13 adds long items of its own (tests/benchmark-suite-v13.test.js).
const V13 = new Set([...moreLongCodePrompts(), ...moreLongBugPrompts()].map((prompt) => prompt.id));
const V9_ON = PROMPTS.filter((prompt) => !V13.has(prompt.id));
const count = (category) => V9_ON.filter((prompt) => prompt.category === category).length;

test("suite v9 adds our own coding and bug-fix questions, long ones included", () => {
  assert.ok(SUITE_VERSION >= 9);
  assert.equal(V9_ON.filter((prompt) => (prompt.category.includes("code") || prompt.category.includes("bugfix")) && prompt.category !== "code-comprehension" && !prompt.category.endsWith("-repo")).length, 94, "v18 adds six code paraphrase probes");
  assert.equal(count("code"), 36, "30 own plus six paraphrase probes");
  assert.equal(count("code-long"), 6);
  assert.equal(count("bugfix"), 26);
  assert.equal(count("bugfix-long"), 6);
  assert.equal(new Set(PROMPTS.map((prompt) => prompt.id)).size, PROMPTS.length, "ids stay unique");
});

test("long items get room to answer, and every long bug fix shows a multi-line function", () => {
  for (const prompt of PROMPTS.filter((item) => item.category.endsWith("-long"))) {
    assert.equal(prompt.maxTokens, 1024, prompt.id);
  }
  for (const prompt of PROMPTS.filter((item) => item.category === "bugfix-long")) {
    assert.ok(prompt.buggyCode.split("\n").length >= 8, `${prompt.id} is a long function`);
    assert.ok(prompt.prompt.includes(prompt.buggyCode), `${prompt.id} shows its code`);
  }
});

test("the long categories count as coding everywhere", () => {
  const code = new Set(taskPrompts("code").map((prompt) => prompt.category));
  for (const category of ["code", "code-long", "code-repo", "bugfix", "bugfix-long", "bugfix-repo", "public-code"]) {
    assert.ok(code.has(category), `code task lacks ${category}`);
    assert.ok(CODING_CATEGORIES.includes(category), `coding rate lacks ${category}`);
  }
});
