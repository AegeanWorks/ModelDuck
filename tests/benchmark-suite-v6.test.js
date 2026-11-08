import assert from "node:assert/strict";
import test from "node:test";

import { PROMPTS, SMOKE_PROMPT_IDS, checkCount, evaluateTextCheck, javascriptTestCacheStats, resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";
import { REFERENCE_V9 } from "./reference-solutions-v9.js";
import { referenceV13 } from "./reference-solutions-v13.js";

/** Reference solutions: every executable case must pass with these, proving the expectations. */
const REFERENCE = {
  isPalindrome: (s) => { const t = s.toLowerCase().replace(/[^a-z0-9]/g, ""); return t === [...t].reverse().join(""); },
  fizzBuzz: (n) => (n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Fizz" : n % 5 === 0 ? "Buzz" : String(n)),
  reverseWords: (s) => s.split(" ").reverse().join(" "),
  countVowels: (s) => (s.match(/[aeiou]/gi) ?? []).length,
  fibonacci: (n) => { let a = 0; let b = 1; for (let i = 0; i < n; i += 1) [a, b] = [b, a + b]; return a; },
  uniqueSorted: (arr) => [...new Set(arr)].sort((a, b) => a - b),
  titleCase: (s) => s.split(" ").map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" "),
  clamp: (x, min, max) => Math.min(max, Math.max(min, x)),
  factorial: (n) => (n <= 1 ? 1 : n * REFERENCE.factorial(n - 1)),
  chunk: (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; },
  sumTo: (n) => (n * (n + 1)) / 2,
  maxOf: (arr) => Math.max(...arr),
  average: (arr) => arr.reduce((a, b) => a + b, 0) / arr.length,
  isEven: (n) => n % 2 === 0,
  reverseString: (s) => [...s].reverse().join(""),
  removeDuplicates: (arr) => arr.filter((x, i) => arr.indexOf(x) === i),
  countWords: (s) => s.split(/\s+/).filter(Boolean).length,
  toFahrenheit: (c) => (c * 9) / 5 + 32,
  sumEvens: (arr) => arr.filter((n) => n % 2 === 0).reduce((a, b) => a + b, 0),
  isAnagram: (a, b) => [...a].sort().join("") === [...b].sort().join(""),
  isPositive: (n) => n > 0,
  firstChar: (s) => s[0],
};

const executable = PROMPTS.filter((prompt) => !prompt.category.startsWith("public-") && !prompt.category.endsWith("-repo")).flatMap((prompt) => prompt.checks.filter((check) => check.type === "jsTests").map((check) => ({ prompt, check })));

test("v8 suite: unique ids, new families present, smoke ids resolve", () => {
  const ids = PROMPTS.map((prompt) => prompt.id);
  assert.equal(new Set(ids).size, ids.length);
  const categories = new Set(PROMPTS.map((prompt) => prompt.category));
  for (const family of ["code", "bugfix", "code-comprehension", "recall"]) assert.ok(categories.has(family), family);
  for (const id of SMOKE_PROMPT_IDS) assert.ok(ids.includes(id), id);
  assert.equal(executable.length, 66 + 12, "v13 adds six long functions and six long bug fixes");
});

test("every executable case is satisfied by a reference solution", () => {
  for (const { prompt, check } of executable) {
    const reference = REFERENCE[check.entry] ?? REFERENCE_V9[check.entry] ?? referenceV13(check.entry);
    assert.ok(reference, `no reference for ${check.entry}`);
    for (const testCase of check.cases) {
      assert.deepEqual(reference(...structuredClone(testCase.args)), testCase.expect, `${prompt.id} ${JSON.stringify(testCase.args)}`);
    }
    assert.equal(checkCount(prompt), check.cases.length);
  }
});

test("bug-fix prompts ship code that actually fails their own tests", () => {
  for (const { prompt, check } of executable.filter(({ prompt: item }) => item.category.startsWith("bugfix"))) {
    const buggy = prompt.buggyCode ?? prompt.prompt.split("\n")[1];
    const fn = new Function(`${buggy}; return ${check.entry};`)();
    // Throwing counts as failing: the long bug fixes include crashes.
    const run = (args) => {
      try {
        return JSON.stringify(fn(...structuredClone(args)));
      } catch {
        return "threw";
      }
    };
    const failing = check.cases.filter((testCase) => run(testCase.args) !== JSON.stringify(testCase.expect));
    assert.ok(failing.length > 0, `${prompt.id} buggy code passes every case`);
  }
});

test("text checks accept listed answers and reject others", () => {
  assert.equal(evaluateTextCheck({ type: "oneOf", values: ["leo"] }, "Leo.").passed, true);
  assert.equal(evaluateTextCheck({ type: "oneOf", values: ["leo"] }, "Mira").passed, false);
  assert.equal(evaluateTextCheck({ type: "containsAny", values: ["carbon dioxide", "co2"] }, "CO2").passed, true);
  assert.equal(evaluateTextCheck({ type: "notContains", value: "bean" }, "tomatoes").passed, true);
});

test("generated code runs sandboxed: a correct answer passes, file access fails", async () => {
  const check = { entry: "clamp", cases: [{ args: [5, 0, 10], expect: 5 }, { args: [42, 0, 10], expect: 10 }] };
  const good = await runJavaScriptTests("```js\nexport function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }\n```", check);
  assert.deepEqual(good.map((item) => item.passed), [true, true]);

  const hostile = await runJavaScriptTests(
    'function clamp() { require("fs").writeFileSync("pwned.txt", "x"); return 5; }',
    { entry: "clamp", cases: [{ args: [5, 0, 10], expect: 5 }] },
  );
  assert.equal(hostile[0].passed, false);
  assert.match(hostile[0].detail, /threw/);
});

test("an identical answer is verified once and the cached checks stay identical", async () => {
  resetJavaScriptTestCache();
  const check = { entry: "clamp", cases: [{ args: [5, 0, 10], expect: 5 }, { args: [42, 0, 10], expect: 10 }] };
  const answer = "```js\nfunction clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }\n```";
  const first = await runJavaScriptTests(answer, check);
  const afterFirst = javascriptTestCacheStats();
  const second = await runJavaScriptTests(answer, check);
  const afterSecond = javascriptTestCacheStats();
  assert.deepEqual(second, first);
  assert.equal(afterFirst.misses, 1);
  assert.equal(afterSecond.hits, afterFirst.hits + 1);
});

test("runaway generated code is killed by the timeout", async () => {
  const result = await runJavaScriptTests("function clamp() { while (true) {} }", { entry: "clamp", cases: [{ args: [1, 0, 2], expect: 1 }] }, { timeoutMs: 300 });
  assert.equal(result[0].passed, false);
  assert.match(result[0].detail, /timed out/);
});

const PUBLIC_REFERENCE = {
  greatestCommonDivisor: (a, b) => (b === 0 ? a : PUBLIC_REFERENCE.greatestCommonDivisor(b, a % b)),
  removeDuplicates: (arr) => arr.filter((x) => arr.indexOf(x) === arr.lastIndexOf(x)),
  largestDivisor: (n) => { for (let d = n - 1; d > 0; d -= 1) if (n % d === 0) return d; return 1; },
  isPrime: (n) => { if (n < 2) return false; for (let d = 2; d * d <= n; d += 1) if (n % d === 0) return false; return true; },
  monotonic: (l) => l.every((x, i) => i === 0 || x >= l[i - 1]) || l.every((x, i) => i === 0 || x <= l[i - 1]),
  countDistinctCharacters: (s) => new Set(s.toLowerCase()).size,
  howManyTimes: (s, sub) => { let n = 0; for (let i = 0; i + sub.length <= s.length; i += 1) if (s.slice(i, i + sub.length) === sub) n += 1; return n; },
  modp: (n, p) => { let r = 1; for (let i = 0; i < n; i += 1) r = (r * 2) % p; return r; },
  tetrahedralNumber: (n) => (n * (n + 1) * (n + 2)) / 6,
  centeredHexagonalNumber: (n) => 3 * n * (n - 1) + 1,
  octagonalNumber: (n) => 3 * n * n - 2 * n,
  recursiveListSum: (arr) => arr.reduce((sum, x) => sum + (Array.isArray(x) ? PUBLIC_REFERENCE.recursiveListSum(x) : x), 0),
  hasCloseElements: (numbers, threshold) => numbers.some((a, i) => numbers.some((b, j) => i !== j && Math.abs(a - b) < threshold)),
  truncateNumber: (number) => number % 1,
  filterBySubstring: (strings, substring) => strings.filter((value) => value.includes(substring)),
  strlen: (value) => value.length,
  removeOcc: (value, character) => {
    const first = value.indexOf(character);
    if (first < 0) return value;
    const last = value.lastIndexOf(character);
    return value.slice(0, first) + value.slice(first + 1, last) + value.slice(last + 1);
  },
  sortMatrix: (matrix) => [...matrix].sort((left, right) => left.reduce((a, b) => a + b, 0) - right.reduce((a, b) => a + b, 0)),
  triangularPrismVolume: (length, base, height) => (length * base * height) / 2,
  textLowercaseUnderscore: (value) => /^[a-z]+_[a-z]+$/.test(value),
};

test("public items carry source and license, and translated code cases hold", () => {
  const publicItems = PROMPTS.filter((prompt) => prompt.category.startsWith("public-"));
  assert.equal(publicItems.length, 20);
  assert.equal(PROMPTS.length - publicItems.length, 245, "ModelDuck's own questions stay in the suite");
  for (const prompt of publicItems) {
    assert.ok(prompt.source?.dataset && prompt.source?.license, prompt.id);
    for (const check of prompt.checks.filter((item) => item.type === "jsTests")) {
      for (const testCase of check.cases) {
        assert.deepEqual(PUBLIC_REFERENCE[check.entry](...structuredClone(testCase.args)), testCase.expect, `${prompt.id} ${JSON.stringify(testCase.args)}`);
      }
    }
  }
  assert.equal(evaluateTextCheck({ type: "number", value: 1600 }, "1,600").passed, true);
  assert.equal(evaluateTextCheck({ type: "number", value: 75 }, "$75.00").passed, true);
  assert.equal(evaluateTextCheck({ type: "number", value: 600 }, "25 x 3 = 75\n75 x 8 = 600").passed, true);
  assert.equal(evaluateTextCheck({ type: "number", value: 600 }, "The first number is 25, the answer is 540.").passed, false);
});
