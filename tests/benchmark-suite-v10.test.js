import assert from "node:assert/strict";
import test from "node:test";

import { moreRecallPrompts } from "../benchmarks/own-items-v10.mjs";
import { repoPrompts } from "../benchmarks/repo-items-v10.mjs";
import { PROMPTS, SUITE_VERSION, evaluateTextCheck, runJavaScriptTests } from "../benchmarks/suite.mjs";
import { taskPrompts } from "../benchmarks/tasks.mjs";

const lines = (prompt) => prompt.split("\n");

/** The answer read back from the item's own text, the way a careful reader would. */
function recallAnswer(item) {
  const question = lines(item.prompt).at(-1);
  if (item.id.includes("-pin-")) {
    const badge = question.match(/badge (\d+)/)[1];
    return lines(item.prompt).find((line) => line.startsWith(`Badge ${badge}:`)).match(/PIN (\d+)/)[1];
  }
  if (item.id.includes("-holder-")) {
    const pin = question.match(/PIN (\d+)/)[1];
    return lines(item.prompt).find((line) => line.includes(`PIN ${pin},`)).match(/holder (\w+)/)[1].toLowerCase();
  }
  if (item.id.includes("-status-")) {
    const parcel = question.match(/parcel (P-\d+)/)[1];
    return lines(item.prompt).filter((line) => line.includes(`Parcel ${parcel} `)).at(-1).match(/now (\w+)\./)[1];
  }
  if (item.id.includes("-sum-")) {
    const [first, second] = [...question.matchAll(/balance of (\w+)/g)].map((match) => match[1]);
    const balance = (name) => Number(lines(item.prompt).find((line) => line.startsWith(`Account of ${name}:`)).match(/balance (\d+)/)[1]);
    return balance(first) + balance(second);
  }
  const colour = question.match(/colour (\w+)\?/)[1];
  return lines(item.prompt).filter((line) => line.endsWith(`colour ${colour}.`)).length;
}

test("suite v10 keeps a substantial long-context workload", () => {
  assert.ok(SUITE_VERSION >= 10);
  assert.ok(PROMPTS.length >= 198);
  assert.equal(new Set(PROMPTS.map((prompt) => prompt.id)).size, PROMPTS.length, "ids stay unique");
  assert.equal(taskPrompts("recall").length, 65);
});

test("every generated recall answer can be read back from its own text, and only once", () => {
  const items = moreRecallPrompts();
  assert.equal(items.length, 40);
  for (const item of items) {
    assert.equal(String(recallAnswer(item)), String(item.checks[0].value), item.id);
    assert.ok(item.prompt.length < 5000, `${item.id} fits a 2048-token context`);
  }
  for (const item of items.filter((entry) => /-(pin|holder)-/.test(entry.id))) {
    const [, field, value] = lines(item.prompt).at(-1).match(/(badge|PIN) (\d+)/);
    const marker = field === "badge" ? `Badge ${value}:` : `PIN ${value},`;
    assert.equal(lines(item.prompt).filter((line) => line.includes(marker)).length, 1, `${item.id} names its key once`);
  }
});

test("the generated registers are the same on every run", () => {
  assert.deepEqual(moreRecallPrompts(), moreRecallPrompts());
  assert.notEqual(moreRecallPrompts()[0].prompt, moreRecallPrompts()[1].prompt);
});

/** Reference answers for the codebase items, written against each codebase's own helpers. */
const REPO_REFERENCE = {
  cartTotalCents: `function cartTotalCents(lines) {
    return lines.reduce((sum, line) => sum + lineCents(line) + taxCents(lineCents(line), findProduct(line.sku).taxable), 0);
  }`,
  receipt: `function receipt(lines) {
    return [...lines.map((line) => line.qty + " x " + findProduct(line.sku).name + ": " + formatCents(lineCents(line))), "Subtotal: " + formatCents(cartSubtotalCents(lines))];
  }`,
  formatCents: `function formatCents(cents) {
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    return sign + "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  }`,
  searchDocs: `function searchDocs(docs, query) {
    const index = buildIndex(docs);
    const words = tokenize(query).filter((word) => !isStopword(word));
    if (!words.length) return [];
    return words.map((word) => index.get(word) ?? []).reduce((left, right) => left.filter((id) => right.includes(id))).sort((a, b) => a - b);
  }`,
  slugify: `function slugify(title) {
    const words = tokenize(title);
    const kept = words.filter((word) => !isStopword(word));
    return (kept.length ? kept : words).join("-");
  }`,
  tokenize: `function tokenize(text) {
    return normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
  }`,
  firstFreeSlot: `function firstFreeSlot(meetings, minutes, dayStart, dayEnd) {
    const slots = meetings.map(toSlot).sort((a, b) => a.start - b.start);
    for (let start = parseTime(dayStart); start + minutes <= parseTime(dayEnd); start += 1) {
      if (!slots.some((slot) => overlaps(slot, { start, end: start + minutes }))) return formatTime(start);
    }
    return null;
  }`,
  endTimes: `function endTimes(meetings) {
    return meetings.map((meeting) => [meeting.title, formatTime(toSlot(meeting).end)]);
  }`,
  overlaps: `function overlaps(a, b) {
    return a.start < b.end && b.start < a.end;
  }`,
};

/** What each locate item's culprit should be, and a call that shows the bug. */
const LOCATE_REFERENCE = {
  "repo-find-tax": { fixed: "function taxCents(cents, taxable) { return taxable ? Math.round(cents * TAX_RATE) : 0; }", probe: "cartSubtotalCents([{ sku: 'lamp', qty: 1 }]) + taxCents(1999, true)", expect: 2159 },
  "repo-find-accents": { fixed: 'function normalize(text) { return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }', probe: "buildIndex([{ id: 1, text: 'Café Paris' }]).has('cafe')", expect: true },
  "repo-find-midnight": { fixed: "function formatTime(minutes) { return String(Math.floor(minutes / 60) % 24).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'); }", probe: "formatTime(toSlot({ at: '23:30', minutes: 90 }).end)", expect: "01:00" },
};

const run = (setup, answer, entry, args) => {
  try {
    return JSON.stringify(new Function(`${setup}\n;${answer}\n;return ${entry};`)()(...structuredClone(args)));
  } catch (error) {
    return `threw ${error.message}`;
  }
};
const repoItems = repoPrompts();

test("codebase items: six to implement, three to fix, three to locate, all in the code task", () => {
  assert.equal(repoItems.length, 12);
  assert.equal(repoItems.filter((item) => item.category === "bugfix-repo").length, 3);
  assert.equal(repoItems.filter((item) => item.checks[0].type === "oneOf").length, 3);
  const code = new Set(taskPrompts("code").map((item) => item.id));
  for (const item of repoItems) {
    assert.ok(code.has(item.id), item.id);
    assert.ok(item.prompt.split("// file: ").length - 1 >= 4, `${item.id} shows a multi-file codebase`);
  }
});

test("every codebase test case passes with a reference answer on top of the codebase", () => {
  for (const item of repoItems.filter((entry) => entry.checks[0].type === "jsTests")) {
    const check = item.checks[0];
    for (const testCase of check.cases) {
      assert.equal(run(check.setup, REPO_REFERENCE[check.entry], check.entry, testCase.args), JSON.stringify(testCase.expect), `${item.id} ${JSON.stringify(testCase.args)}`);
    }
  }
});

test("every implement item asks for a function the codebase does not have yet", () => {
  for (const item of repoItems.filter((entry) => entry.category === "code-repo" && entry.checks[0].type === "jsTests")) {
    const check = item.checks[0];
    assert.match(run(check.setup, "", check.entry, check.cases[0].args), /^threw/, item.id);
  }
});

test("every shipped codebase bug fails its own tests", () => {
  for (const item of repoItems.filter((entry) => entry.category === "bugfix-repo")) {
    const check = item.checks[0];
    const failing = check.cases.filter((testCase) => run(check.setup, "", check.entry, testCase.args) !== JSON.stringify(testCase.expect));
    assert.ok(failing.length > 0, `${item.id} ships code that already passes`);
  }
});

test("every located bug shows in its probe and goes away when the named function is fixed", () => {
  for (const item of repoItems.filter((entry) => entry.checks[0].type === "oneOf")) {
    const { fixed, probe, expect } = LOCATE_REFERENCE[item.id];
    const evaluate = (extra) => new Function(`${item.buggyCode}\n;${extra}\n;return ${probe};`)();
    assert.notDeepEqual(evaluate(""), expect, `${item.id} bug does not show`);
    assert.deepEqual(evaluate(fixed), expect, `${item.id} culprit fix does not cure it`);
    assert.ok(fixed.startsWith(`function ${item.checks[0].values[0]}(`), `${item.id} names the fixed function`);
  }
});

test("a codebase answer runs after the codebase in the sandbox", async () => {
  const item = repoItems.find((entry) => entry.id === "repo-end-times");
  const results = await runJavaScriptTests(`\`\`\`js\n${REPO_REFERENCE.endTimes}\n\`\`\``, item.checks[0]);
  assert.deepEqual(results.map((result) => result.passed), [true, true]);
});
