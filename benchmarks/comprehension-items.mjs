/**
 * Code comprehension: read a small JavaScript function and report what it returns.
 * The expected value is computed from the exact source shown in the prompt, so a
 * changed snippet and its check cannot drift apart.
 */

/**
 * The comprehension bank: 32 small functions with two inputs each (S4). Eight
 * inputs of one function move together when a setting changes how the model
 * reads it, so item-level p-values were 3-4x too optimistic; 32 functions x 2
 * inputs keep 64 items with 4x more independent clusters. Expected values are
 * computed from the exact source shown, so a changed snippet and its check
 * cannot drift apart.
 */
export const COMPREHENSION_BANK = [
  {
    name: "sumTo",
    code: "function sumTo(n) { let total = 0; for (let i = 1; i <= n; i += 1) total += i; return total; }",
    cases: [[0], [10]],
  },
  {
    name: "clamp",
    code: "function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }",
    cases: [[5, 0, 10], [0, 1, 2]],
  },
  {
    name: "reverseText",
    code: 'function reverseText(text) { return [...text].reverse().join(""); }',
    cases: [["duck"], ["ModelDuck"]],
  },
  {
    name: "countVowels",
    code: 'function countVowels(text) { return [...text.toLowerCase()].filter((letter) => "aeiou".includes(letter)).length; }',
    cases: [["duck"], ["banana"]],
  },
  {
    name: "isEven",
    code: "function isEven(n) { return n % 2 === 0; }",
    cases: [[0], [-3]],
  },
  {
    name: "maxOfThree",
    code: "function maxOfThree(a, b, c) { return Math.max(a, b, c); }",
    cases: [[1, 2, 3], [5, 9, 2]],
  },
  {
    name: "factorial",
    code: "function factorial(n) { if (n <= 1) return 1; let result = 1; for (let i = 2; i <= n; i += 1) result *= i; return result; }",
    cases: [[0], [4]],
  },
  {
    name: "repeatWord",
    code: 'function repeatWord(word, times) { return Array.from({ length: times }, () => word).join("-"); }',
    cases: [["duck", 1], ["hi", 2]],
  },
  {
    name: "double",
    code: "function double(n) { return n * 2; }",
    cases: [[3], [-4]],
  },
  {
    name: "square",
    code: "function square(n) { return n * n; }",
    cases: [[5], [-3]],
  },
  {
    name: "isOdd",
    code: "function isOdd(n) { return n % 2 !== 0; }",
    cases: [[7], [8]],
  },
  {
    name: "gcd",
    code: "function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }",
    cases: [[12, 18], [7, 13]],
  },
  {
    name: "lcm",
    code: "function lcm(a, b) { const g = (x, y) => (y === 0 ? x : g(y, x % y)); return (a * b) / g(a, b); }",
    cases: [[4, 6], [5, 7]],
  },
  {
    name: "fib",
    code: "function fib(n) { let a = 0, b = 1; for (let i = 0; i < n; i += 1) { const t = a + b; a = b; b = t; } return a; }",
    cases: [[10], [0]],
  },
  {
    name: "isPrime",
    code: "function isPrime(n) { if (n < 2) return false; for (let i = 2; i * i <= n; i += 1) if (n % i === 0) return false; return true; }",
    cases: [[13], [15]],
  },
  {
    name: "digitSum",
    code: "function digitSum(n) { let s = 0; for (let x = Math.abs(n); x > 0; x = Math.floor(x / 10)) s += x % 10; return s; }",
    cases: [[123], [1000]],
  },
  {
    name: "reverseDigits",
    code: "function reverseDigits(n) { let r = 0; for (let x = n; x > 0; x = Math.floor(x / 10)) r = r * 10 + (x % 10); return r; }",
    cases: [[123], [120]],
  },
  {
    name: "countWords",
    code: 'function countWords(text) { return text.split(" ").filter((w) => w.length > 0).length; }',
    cases: [["hi there you"], ["duck"]],
  },
  {
    name: "longestWord",
    code: 'function longestWord(text) { return text.split(" ").reduce((a, b) => (b.length > a.length ? b : a), ""); }',
    cases: [["a abcde abc"], ["x"]],
  },
  {
    name: "isPalindrome",
    code: 'function isPalindrome(text) { return text === [...text].reverse().join(""); }',
    cases: [["racecar"], ["duck"]],
  },
  {
    name: "capitalize",
    code: "function capitalize(text) { return text.length ? text[0].toUpperCase() + text.slice(1) : text; }",
    cases: [["duck"], ["hELLO"]],
  },
  {
    name: "initials",
    code: 'function initials(text) { return text.split(" ").map((w) => w[0].toUpperCase()).join(""); }',
    cases: [["ana ben"], ["x"]],
  },
  {
    name: "power",
    code: "function power(a, b) { return a ** b; }",
    cases: [[2, 10], [3, 0]],
  },
  {
    name: "posMod",
    code: "function posMod(a, b) { return ((a % b) + b) % b; }",
    cases: [[7, 3], [-7, 3]],
  },
  {
    name: "absDiff",
    code: "function absDiff(a, b) { return Math.abs(a - b); }",
    cases: [[5, 9], [-2, -5]],
  },
  {
    name: "rangeLen",
    code: "function rangeLen(a, b) { return Math.abs(b - a) + 1; }",
    cases: [[3, 7], [0, 0]],
  },
  {
    name: "repeatString",
    code: "function repeatString(s, n) { return s.repeat(n); }",
    cases: [["ab", 3], ["z", 1]],
  },
  {
    name: "trimEdges",
    code: "function trimEdges(s) { return s.trim(); }",
    cases: [["  duck  "], ["quack"]],
  },
  {
    name: "startsWithQu",
    code: 'function startsWithQu(s) { return s.startsWith("qu"); }',
    cases: [["quack"], ["duck"]],
  },
  {
    name: "arraySum",
    code: "function arraySum(xs) { return xs.reduce((a, b) => a + b, 0); }",
    cases: [[[1, 2, 3, 4]], [[]]],
  },
  {
    name: "arrayMax",
    code: "function arrayMax(xs) { return Math.max(...xs); }",
    cases: [[[3, 1, 9]], [[-5, -2]]],
  },
  {
    name: "uniqueCount",
    code: "function uniqueCount(xs) { return new Set(xs).size; }",
    cases: [[[1, 2, 2, 3]], [[5, 5]]],
  },
];

for (const entry of COMPREHENSION_BANK) {
  entry.run = new Function(`${entry.code}\nreturn ${entry.name};`)();
}

function formatArgs(values) {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

/** 64 code-reading items: 32 functions with two inputs each (S4). */
export function codeComprehensionPrompts() {
  return COMPREHENSION_BANK.flatMap((entry) =>
    entry.cases.map((values, index) => ({
      id: `read-${entry.name}-${index + 1}`,
      group: entry.name,
      label: `Read ${entry.name} #${index + 1}`,
      category: "code-comprehension",
      prompt:
        "Read this JavaScript function:\n\n" +
        "```js\n" +
        `${entry.code}\n` +
        "```\n\n" +
        `What does ${entry.name}(${formatArgs(values)}) return? Reply with only the value.`,
      maxTokens: 32,
      checks: [{ type: "exact", value: String(entry.run(...values)) }],
    })),
  );
}
