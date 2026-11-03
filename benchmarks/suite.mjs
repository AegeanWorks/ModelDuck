import { moreBugFixPrompts, moreCodingPrompts } from "./own-items-v9.mjs";
import { moreMathPrompts, moreRecallPrompts } from "./own-items-v10.mjs";
import { repoPrompts } from "./repo-items-v10.mjs";
import { moreRepoPrompts } from "./repo-items-v11.mjs";
import { moreChatPrompts, moreContextPrompts } from "./own-items-v12.mjs";
import { moreKnowledgePrompts, moreLongBugPrompts, moreLongCodePrompts, moreMathPromptsV13 } from "./own-items-v13.mjs";
import { changeAndTracePrompts } from "./repo-items-v13.mjs";
import { publicPrompts } from "./public-items.mjs";
import { codeComprehensionPrompts } from "./comprehension-items.mjs";

export const SUITE_VERSION = 17;

export const SYSTEM_PROMPT =
  "You are a precise assistant. Follow the requested output format exactly. " +
  "Do not explain unless the user asks for an explanation.";

export const BENCHMARK_MODELS = [
  {
    catalogId: "smollm2-135m-instruct-q4",
    fileName: "SmolLM2-135M-Instruct-Q4_K_M.gguf",
    label: "SmolLM2 135M",
    kind: "tiny general",
  },
  {
    catalogId: "qwen2.5-0.5b-instruct-q4",
    fileName: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    aliases: ["qwen2.5-0.5b-q4_k_m.gguf"],
    label: "Qwen2.5 0.5B",
    kind: "general chat",
  },
  {
    catalogId: "qwen2.5-1.5b-instruct-q4",
    fileName: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    label: "Qwen2.5 1.5B",
    kind: "general 1.5B",
  },
  {
    catalogId: "qwen2.5-coder-1.5b-instruct-q4",
    fileName: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    label: "Qwen2.5 Coder 1.5B",
    kind: "code",
  },
  {
    catalogId: "llama-3.2-3b-instruct-q4",
    fileName: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    label: "Llama 3.2 3B",
    kind: "general 3B",
  },
  {
    catalogId: "phi-3.5-mini-instruct-q4",
    fileName: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    label: "Phi-3.5 Mini",
    kind: "reasoning 3.8B",
  },
];

const FILLER = Array.from(
  { length: 34 },
  (_value, index) =>
    `Note ${index + 1}: the pond is calm and the duck census records ${100 + index} birds.`,
).join(" ");

// Deterministic filler for the long-context KV items (M6): a seeded PRNG so
// the same prompt is generated on every machine. Token counts are estimated
// at four characters per token, matching the suite's longest prompt.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const LONG_FILLER_WORDS = Object.freeze([
  "pond", "duck", "reed", "census", "calm", "morning", "count", "ledger", "keeper", "fen",
  "water", "nest", "quack", "wader", "marsh", "tally", "dawn", "ripple", "sedge", "brook",
]);

function longFiller(targetChars, seed) {
  const next = mulberry32(seed);
  const sentences = [];
  let chars = 0;
  let note = 1;
  while (chars < targetChars) {
    const words = Array.from({ length: 8 + Math.floor(next() * 8) }, () => LONG_FILLER_WORDS[Math.floor(next() * LONG_FILLER_WORDS.length)]);
    const sentence = `Entry ${note}: the ${words.join(" ")} tally is ${1000 + Math.floor(next() * 9000)}.`;
    sentences.push(sentence);
    chars += sentence.length + 1;
    note += 1;
  }
  return sentences.join(" ");
}

/**
 * Long-context KV confirmation items (M6): the KV cache is chosen on prompts
 * of ~1k tokens but served at up to 16k, and a quantized cache degrades with
 * length. Three recall needles at about 4k, 8k and 16k tokens share one
 * codebase-like family (`long-context`), which also gives the recall task a
 * cluster for the cluster-aware guards. They are excluded from the search
 * rungs, the speed workload and the holdout; the quality stage uses only
 * them to confirm a KV choice at the budgeted context.
 */
function longContextPrompts() {
  const specs = [
    { id: "recall-long-4k", kiloTokens: 4, seed: 427, code: 4510 },
    { id: "recall-long-8k", kiloTokens: 8, seed: 428, code: 8823 },
    { id: "recall-long-16k", kiloTokens: 16, seed: 429, code: 16047 },
  ];
  return specs.map(({ id, kiloTokens, seed, code }) => {
    const filler = longFiller(kiloTokens * 4000, seed);
    const half = Math.floor(filler.length / 2);
    const prompt =
      `Read these notes carefully.\n\n${filler.slice(0, half)}\n\nThe vault code is VAULT-${code}. Keep it in mind.\n\n` +
      `${filler.slice(half)}\n\nQuestion: What is the vault code? Reply with only the code.`;
    return {
      id,
      label: `Long-context needle (${kiloTokens}k)`,
      category: "recall",
      group: "long-context",
      longContext: true,
      prompt,
      maxTokens: 16,
      checks: [{ type: "exact", value: `vault-${code}` }],
    };
  });
}

const NEEDLE_PROMPT =
  `Read these notes carefully.\n\n${FILLER}\n\n` +
  "The secret code is DUCK-427. Keep it in mind.\n\n" +
  `${FILLER}\n\n` +
  "Question: What is the secret code? Reply with only the code.";

const OWNERS = ["Ana", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun"];
const LOCKERS = Array.from({ length: 30 }, (_value, index) => ({
  number: 101 + index,
  owner: OWNERS[(index * 7) % OWNERS.length],
  code: ((index + 1) * 7919) % 9000 + 1000,
}));
const LOCKER_TABLE = LOCKERS.map((item) => `Locker ${item.number}: owner ${item.owner}, code ${item.code}.`).join("\n");
const locker = (number) => LOCKERS.find((item) => item.number === number);

const ALL_PROMPTS = [
  {
    id: "exact-word",
    label: "Exact word",
    category: "instruction",
    prompt: "Reply with exactly this word and nothing else: quack",
    maxTokens: 16,
    checks: [{ type: "exact", value: "quack" }],
  },
  {
    id: "arithmetic",
    label: "Arithmetic",
    category: "reasoning",
    prompt: "What is 17 * 23? Reply with only the number.",
    maxTokens: 16,
    checks: [{ type: "exact", value: "391" }],
  },
  {
    id: "factual",
    label: "Factual recall",
    category: "knowledge",
    prompt: "What is the capital of France? Reply with only the city name.",
    maxTokens: 16,
    checks: [{ type: "exact", value: "paris" }],
  },
  {
    id: "reasoning",
    label: "Simple reasoning",
    category: "reasoning",
    prompt:
      "All ducks in the pond can swim. Puddles is a duck in the pond. Can Puddles swim? Reply with only yes or no.",
    maxTokens: 16,
    checks: [{ type: "exact", value: "yes" }],
  },
  {
    id: "json-format",
    label: "JSON format",
    category: "format",
    prompt:
      'Return only a JSON object with exactly two keys: "name" set to "ModelDuck" and "answer" set to 42. No code fences.',
    maxTokens: 64,
    checks: [
      { type: "json", keys: ["name", "answer"] },
      { type: "jsonValue", key: "name", value: "ModelDuck" },
      { type: "jsonValue", key: "answer", value: 42 },
    ],
  },
  {
    id: "format-json-list",
    label: "JSON array",
    category: "format",
    prompt: "Return only a JSON array containing the numbers 1, 2 and 3 in that order. No code fences.",
    maxTokens: 64,
    checks: [{ type: "regex", pattern: "^\\s*\\[\\s*1\\s*,\\s*2\\s*,\\s*3\\s*\\]\\s*$" }],
  },
  {
    id: "javascript",
    label: "Code generation",
    category: "code",
    prompt:
      "Write a JavaScript function named add that takes two numbers and returns their sum. Reply with code only.",
    maxTokens: 96,
    checks: [
      { type: "regex", pattern: "(function\\s+add\\s*\\(|(?:const|let|var)\\s+add\\s*=)" },
      { type: "regex", pattern: "(return\\s+[^;]*\\+|=>)" },
      { type: "jsSyntax" },
    ],
  },
  {
    id: "lowercase",
    label: "Format control",
    category: "instruction",
    prompt: "Reply in lowercase only with the sentence: The Quick Brown Fox Jumps.",
    maxTokens: 32,
    checks: [{ type: "exact", value: "the quick brown fox jumps." }, { type: "noUppercase" }],
  },
  {
    id: "list-three",
    label: "List constraint",
    category: "instruction",
    prompt: "List exactly three colors, separated by commas. Reply with only the list.",
    maxTokens: 32,
    checks: [{ type: "commaCount", count: 3 }],
  },
  {
    id: "instruction-prefix",
    label: "Exact prefix",
    category: "instruction",
    prompt: "Reply with only this text: duck-quack",
    maxTokens: 16,
    checks: [{ type: "exact", value: "duck-quack" }],
  },
  {
    id: "needle",
    label: "Long-context recall",
    category: "context",
    prompt: NEEDLE_PROMPT,
    maxTokens: 16,
    checks: [{ type: "exact", value: "duck-427" }],
  },
  {
    id: "context-code",
    label: "Long-context code",
    category: "context",
    prompt:
      `Read these notes carefully.\n\n${FILLER}\n\nThe mint token is MINT-88. Keep it in mind.\n\n` +
      `${FILLER}\n\nQuestion: What is the mint token? Reply with only the token.`,
    maxTokens: 16,
    checks: [{ type: "exact", value: "mint-88" }],
  },
  {
    id: "hellaswag",
    label: "Plausible ending",
    category: "reasoning",
    prompt:
      "Context: The duck waddled to the pond. It saw a loaf of bread.\n" +
      "Which ending is most plausible?\n" +
      "A) It ate the bread.\nB) It filed taxes.\nC) It became a submarine.\n" +
      "Answer with only the letter.",
    maxTokens: 16,
    checks: [{ type: "choice", value: "a" }],
  },
  {
    id: "reasoning-shortest",
    label: "Three-way comparison",
    category: "reasoning",
    prompt: "Ann is taller than Ben. Ben is taller than Cid. Who is shortest? Reply with only the name.",
    maxTokens: 16,
    checks: [{ type: "exact", value: "cid" }],
  },
  {
    id: "mmlu",
    label: "Knowledge multiple choice",
    category: "knowledge",
    prompt:
      "Which planet is known as the Red Planet?\n" +
      "A) Venus\nB) Mars\nC) Jupiter\nD) Saturn\n" +
      "Answer with only the letter.",
    maxTokens: 16,
    checks: [{ type: "choice", value: "b" }],
  },
  {
    id: "knowledge-ocean",
    label: "Largest ocean",
    category: "knowledge",
    prompt: "Which ocean is the largest by area? Reply with only the name.",
    maxTokens: 16,
    checks: [{ type: "exact", value: "pacific" }],
  },
  {
    id: "gsm8k",
    label: "Word problem",
    category: "reasoning",
    prompt:
      "A farmer has 12 ducks. She buys 6 more ducks, then gives 3 ducks to a friend. " +
      "How many ducks does she have now? Reply with only the number.",
    maxTokens: 24,
    checks: [{ type: "exact", value: "15" }],
  },
  {
    id: "squad",
    label: "Reading comprehension",
    category: "context",
    prompt:
      "Passage: The duck returned to the pond at dusk, after a long day of chasing dragonflies.\n" +
      "Question: When did the duck return to the pond? Reply with only the time of day.",
    maxTokens: 16,
    checks: [{ type: "contains", value: "dusk" }],
  },
  {
    id: "code-repair",
    label: "Bug fix",
    category: "code",
    prompt:
      "This JavaScript function is wrong: function add(a, b) { return a - b; }\n" +
      "Fix it so it returns the sum. Reply with code only, keeping the same function name.",
    maxTokens: 96,
    checks: [
      { type: "regex", pattern: "function\\s+add\\s*\\(" },
      { type: "regex", pattern: "return\\s+[^;]*\\+" },
      { type: "jsSyntax" },
    ],
  },
  ...codingPrompts(),
  ...bugFixPrompts(),
  ...moreCodingPrompts(),
  ...moreBugFixPrompts(),
  ...repoPrompts(),
  ...moreRepoPrompts(),
  ...comprehensionPrompts(),
  ...recallPrompts(),
  ...longContextPrompts(),
  ...moreMathPrompts(),
  ...moreRecallPrompts(),
  ...moreChatPrompts(),
  ...moreContextPrompts(),
  ...moreKnowledgePrompts(),
  ...moreLongCodePrompts(),
  ...moreLongBugPrompts(),
  ...moreMathPromptsV13(),
  ...changeAndTracePrompts(),
  ...factPrompts(),
  ...publicPrompts(),
  ...codeComprehensionPrompts(),
];

/**
 * The coding suite keeps three workloads: implementation and repair, code
 * comprehension, and long-context recall. Historical items stay in their
 * modules but are not part of a run.
 */
const SUITE_CATEGORIES = new Set([
  "code",
  "code-long",
  "code-repo",
  "bugfix",
  "bugfix-long",
  "bugfix-repo",
  "public-code",
  "code-comprehension",
  "context",
  "recall",
]);

// Short unscored items: kept in the file for reference, never part of a run.
// A rename or a new tiny demo item stays out by adding its id here, instead
// of another bare carve-out in the filter below.
export const EXCLUDED_IDS = Object.freeze(new Set(["squad"]));

export const PROMPTS = Object.freeze(
  ALL_PROMPTS.filter((prompt) => SUITE_CATEGORIES.has(prompt.category) && !EXCLUDED_IDS.has(prompt.id)),
);

/* v5 families ------------------------------------------------------------- */

function codeTask(id, label, spec, entry, cases) {
  return {
    id,
    label,
    category: "code",
    prompt: `Write a JavaScript function named ${entry} that ${spec} Reply with code only.`,
    maxTokens: 256,
    checks: [{ type: "jsTests", entry, cases }],
  };
}

function codingPrompts() {
  return [
    codeTask("code-palindrome", "Palindrome check",
      "takes a string and returns true if it reads the same forwards and backwards, ignoring case and any character that is not a letter or digit.",
      "isPalindrome",
      [{ args: ["Racecar"], expect: true }, { args: ["A man, a plan, a canal: Panama"], expect: true }, { args: ["duck"], expect: false }, { args: [""], expect: true }]),
    codeTask("code-fizzbuzz", "FizzBuzz value",
      'takes a positive integer n and returns "FizzBuzz" if n is divisible by 3 and 5, "Fizz" if only by 3, "Buzz" if only by 5, and otherwise n as a string.',
      "fizzBuzz",
      [{ args: [3], expect: "Fizz" }, { args: [5], expect: "Buzz" }, { args: [15], expect: "FizzBuzz" }, { args: [7], expect: "7" }]),
    codeTask("code-reverse-words", "Reverse words",
      "takes a string of words separated by single spaces and returns the words in reverse order, separated by single spaces.",
      "reverseWords",
      [{ args: ["the quick duck"], expect: "duck quick the" }, { args: ["one"], expect: "one" }, { args: ["a b c"], expect: "c b a" }]),
    codeTask("code-count-vowels", "Count vowels",
      "takes a string and returns how many of its characters are the vowels a, e, i, o or u, ignoring case.",
      "countVowels",
      [{ args: ["Duck"], expect: 1 }, { args: ["AEIOU"], expect: 5 }, { args: ["rhythm"], expect: 0 }, { args: ["Hello World"], expect: 3 }]),
    codeTask("code-fibonacci", "Fibonacci",
      "takes a non-negative integer n and returns the nth Fibonacci number, where fibonacci(0) is 0 and fibonacci(1) is 1.",
      "fibonacci",
      [{ args: [0], expect: 0 }, { args: [1], expect: 1 }, { args: [10], expect: 55 }, { args: [20], expect: 6765 }]),
    codeTask("code-unique-sorted", "Unique sorted",
      "takes an array of numbers and returns a new array with duplicates removed, sorted in ascending numeric order.",
      "uniqueSorted",
      [{ args: [[3, 1, 3, 2]], expect: [1, 2, 3] }, { args: [[]], expect: [] }, { args: [[5, 5, 5]], expect: [5] }, { args: [[-1, 10, 2, -1]], expect: [-1, 2, 10] }]),
    codeTask("code-title-case", "Title case",
      "takes a string of words separated by single spaces and returns it with the first letter of each word uppercase and the remaining letters lowercase.",
      "titleCase",
      [{ args: ["hello duck"], expect: "Hello Duck" }, { args: ["mODEL dUCK"], expect: "Model Duck" }, { args: ["a"], expect: "A" }]),
    codeTask("code-clamp", "Clamp",
      "takes three numbers x, min and max and returns x limited to the range from min to max inclusive.",
      "clamp",
      [{ args: [5, 0, 10], expect: 5 }, { args: [-3, 0, 10], expect: 0 }, { args: [42, 0, 10], expect: 10 }]),
    codeTask("code-factorial", "Factorial",
      "takes a non-negative integer n and returns n factorial, where factorial(0) is 1.",
      "factorial",
      [{ args: [0], expect: 1 }, { args: [5], expect: 120 }, { args: [10], expect: 3628800 }]),
    codeTask("code-chunk", "Chunk array",
      "takes an array and a positive integer size and returns an array of consecutive chunks of that size; the last chunk may be shorter.",
      "chunk",
      [{ args: [[1, 2, 3, 4, 5], 2], expect: [[1, 2], [3, 4], [5]] }, { args: [[], 3], expect: [] }, { args: [[1, 2, 3], 3], expect: [[1, 2, 3]] }]),
    codeTask("code-sum-evens", "Sum even numbers",
      "takes an array of integers and returns the sum of only its even numbers.",
      "sumEvens",
      [{ args: [[1, 2, 3, 4]], expect: 6 }, { args: [[]], expect: 0 }, { args: [[1, 3, 5]], expect: 0 }, { args: [[-2, 2, 7]], expect: 0 }]),
    codeTask("code-is-anagram", "Anagram check",
      "takes two lowercase strings and returns true if they contain exactly the same letters with the same counts, ignoring order.",
      "isAnagram",
      [{ args: ["listen", "silent"], expect: true }, { args: ["duck", "luck"], expect: false }, { args: ["", ""], expect: true }, { args: ["aab", "abb"], expect: false }]),
  ];
}

function bugTask(id, label, code, should, entry, cases) {
  return {
    id,
    label,
    category: "bugfix",
    prompt:
      `This JavaScript function has a bug:\n${code}\n` +
      `It should ${should} Fix the bug. Reply with code only, keeping the function name ${entry}.`,
    maxTokens: 256,
    checks: [{ type: "jsTests", entry, cases }],
  };
}

function bugFixPrompts() {
  return [
    bugTask("bug-sum-to", "Off-by-one loop",
      "function sumTo(n) { let s = 0; for (let i = 1; i < n; i++) s += i; return s; }",
      "return the sum of all integers from 1 to n inclusive.", "sumTo",
      [{ args: [1], expect: 1 }, { args: [4], expect: 10 }, { args: [10], expect: 55 }]),
    bugTask("bug-max-of", "Wrong initial maximum",
      "function maxOf(arr) { let m = 0; for (const x of arr) if (x > m) m = x; return m; }",
      "return the largest number in a non-empty array, including arrays of negative numbers.", "maxOf",
      [{ args: [[1, 5, 3]], expect: 5 }, { args: [[-4, -2, -9]], expect: -2 }, { args: [[7]], expect: 7 }]),
    bugTask("bug-average", "Wrong divisor",
      "function average(arr) { let s = 0; for (const x of arr) s += x; return s / 2; }",
      "return the arithmetic mean of a non-empty array of numbers.", "average",
      [{ args: [[2, 4]], expect: 3 }, { args: [[1, 2, 3]], expect: 2 }, { args: [[10]], expect: 10 }]),
    bugTask("bug-is-even", "Inverted parity",
      "function isEven(n) { return n % 2 === 1; }",
      "return true when the integer n is even and false otherwise.", "isEven",
      [{ args: [4], expect: true }, { args: [7], expect: false }, { args: [0], expect: true }]),
    bugTask("bug-reverse-string", "Missing join",
      'function reverseString(s) { return s.split("").reverse(); }',
      "return the string reversed, as a string.", "reverseString",
      [{ args: ["duck"], expect: "kcud" }, { args: [""], expect: "" }, { args: ["ab"], expect: "ba" }]),
    bugTask("bug-remove-duplicates", "Inverted filter",
      "function removeDuplicates(arr) { return arr.filter((x, i) => arr.indexOf(x) !== i); }",
      "return the array without duplicates, keeping the first occurrence of each value in order.", "removeDuplicates",
      [{ args: [[1, 2, 1, 3, 2]], expect: [1, 2, 3] }, { args: [[]], expect: [] }, { args: [[4, 4]], expect: [4] }]),
    bugTask("bug-count-words", "Wrong split",
      'function countWords(s) { return s.split("").length; }',
      "return the number of words in s, where words are separated by any amount of whitespace.", "countWords",
      [{ args: ["the duck swims"], expect: 3 }, { args: ["  one   two "], expect: 2 }, { args: [""], expect: 0 }]),
    bugTask("bug-fahrenheit", "Wrong formula",
      "function toFahrenheit(c) { return c * 5 / 9 + 32; }",
      "convert a temperature from Celsius to Fahrenheit.", "toFahrenheit",
      [{ args: [0], expect: 32 }, { args: [100], expect: 212 }, { args: [-40], expect: -40 }]),
    bugTask("bug-is-positive", "Wrong comparison",
      "function isPositive(n) { return n >= 0; }",
      "return true only for numbers greater than zero.", "isPositive",
      [{ args: [-1], expect: false }, { args: [0], expect: false }, { args: [1], expect: true }]),
    bugTask("bug-first-char", "Wrong index",
      "function firstChar(s) { return s[s.length - 1]; }",
      "return the first character of a non-empty string.", "firstChar",
      [{ args: ["duck"], expect: "d" }, { args: ["a"], expect: "a" }, { args: ["hello"], expect: "h" }]),
  ];
}

function readTask(id, label, passage, question, maxTokens, checks) {
  return { id, label, category: "comprehension", prompt: `Passage: ${passage}\nQuestion: ${question}`, maxTokens, checks };
}

function comprehensionPrompts() {
  const garden =
    "Mira planted tomatoes on Monday. On Wednesday she planted beans. " +
    "Her brother Leo watered both on Friday.";
  return [
    readTask("read-who", "Who did it", garden, "Who watered the plants? Reply with only the name.", 16,
      [{ type: "oneOf", values: ["leo"] }]),
    readTask("read-order", "Event order", garden, "What did Mira plant first? Reply with only one word.", 16,
      [{ type: "containsAny", values: ["tomato"] }, { type: "notContains", value: "bean" }]),
    readTask("read-negation", "Negation",
      "The museum is open every day except Monday. Tickets are free on Sundays.",
      "Is the museum open on Monday? Reply with only yes or no.", 16, [{ type: "exact", value: "no" }]),
    readTask("read-train-time", "Time arithmetic",
      "A train leaves at 09:15 and the trip takes 2 hours and 30 minutes.",
      "At what time does the train arrive? Reply with only the time in HH:MM format.", 16,
      [{ type: "exact", value: "11:45" }]),
    readTask("read-transitive", "Two-step inference",
      "Ada is taller than Ben. Ben is taller than Cal.",
      "Who is the shortest? Reply with only the name.", 16, [{ type: "oneOf", values: ["cal"] }]),
    readTask("read-main-idea", "Main idea",
      "Cities that collect food scraps separately send less waste to landfills. The scraps are turned into compost, which farmers use to enrich soil.",
      "What is the passage mainly about?\nA) How food scraps can become compost instead of landfill waste\nB) Why farmers prefer cities\nC) How landfills are built\nAnswer with only the letter.",
      16, [{ type: "choice", value: "a" }]),
    readTask("read-distractor", "Close distractor",
      "The red kite has a deeply forked tail. The black kite has a shallower fork. Both are birds of prey.",
      "Which kite has the shallower fork? Reply with only the color.", 16, [{ type: "oneOf", values: ["black"] }]),
    readTask("read-unanswerable", "Abstain when absent",
      "The bakery opens at 7 a.m. and sells bread and cakes.",
      "What is the baker's name? If the passage does not say, reply with exactly: unknown", 16,
      [{ type: "oneOf", values: ["unknown"] }]),
    readTask("read-count", "Count from a passage",
      "Ana has 3 red boats and 2 blue boats. She gives one red boat to her sister.",
      "How many boats does Ana have left? Reply with only the number.", 16,
      [{ type: "oneOf", values: ["4", "four"] }]),
    readTask("read-before", "Temporal negation",
      "The bell rings at 8. The train leaves only after the bell rings.",
      "Did the train leave before 8? Reply with only yes or no.", 16,
      [{ type: "exact", value: "no" }]),
  ];
}


function recallTask(id, label, prompt, maxTokens, checks) {
  return { id, label, category: "recall", prompt, maxTokens, checks };
}

function recallPrompts() {
  const lookup = (number) =>
    `Here is the locker register.\n${LOCKER_TABLE}\n\nWhat is the code for locker ${number}? Reply with only the code.`;
  const filler = FILLER.slice(0, 1200);
  return [
    recallTask("recall-locker-first", "Lookup at start", lookup(101), 16, [{ type: "exact", value: String(locker(101).code) }]),
    recallTask("recall-locker-second", "Second lookup", lookup(102), 16, [{ type: "exact", value: String(locker(102).code) }]),
    recallTask("recall-locker-middle", "Lookup in middle", lookup(115), 16, [{ type: "exact", value: String(locker(115).code) }]),
    recallTask("recall-locker-last", "Lookup at end", lookup(130), 16, [{ type: "exact", value: String(locker(130).code) }]),
    recallTask("recall-locker-owner", "Reverse field lookup",
      `Here is the locker register.\n${LOCKER_TABLE}\n\nWho owns locker 122? Reply with only the name.`, 16,
      [{ type: "oneOf", values: [locker(122).owner] }]),
    recallTask("recall-two-needles", "Two needles",
      `${filler}\nThe first password is RIVER-18.\n${filler}\nThe second password is STONE-92.\n${filler}\n\n` +
      "List both passwords, first then second, separated by a comma. Reply with only the list.",
      32, [{ type: "regex", pattern: "river-18\\s*,\\s*stone-92" }]),
    recallTask("recall-list-position", "Position in a list",
      "Here is a shopping list: apples, bread, cheese, dates, eggs, figs, grapes.\nWhat is the fifth item? Reply with only the item.",
      16, [{ type: "oneOf", values: ["eggs", "egg"] }]),
    recallTask("recall-updated-value", "Latest value wins",
      `The meeting is in room B12.\n${filler}\nUpdate: the meeting has moved to room C7.\n${filler}\n\n` +
      "Which room is the meeting in now? Reply with only the room.",
      16, [{ type: "oneOf", values: ["c7", "room c7"] }]),
  ];
}

function factTask(id, label, question, values, { contains = false } = {}) {
  return {
    id,
    label,
    category: "facts",
    prompt: question,
    maxTokens: 24,
    checks: [{ type: contains ? "containsAny" : "oneOf", values }],
  };
}

function factPrompts() {
  return [
    factTask("fact-capital-japan", "Capital of Japan", "What is the capital of Japan? Reply with only the city name.", ["tokyo"]),
    factTask("fact-capital-canada", "Capital of Canada", "What is the capital of Canada? Reply with only the city name.", ["ottawa"]),
    factTask("fact-capital-australia", "Capital of Australia", "What is the capital of Australia? Reply with only the city name.", ["canberra"]),
    factTask("fact-gold-symbol", "Chemical symbol", "What is the chemical symbol for gold? Reply with only the symbol.", ["au"]),
    factTask("fact-largest-planet", "Largest planet", "What is the largest planet in our solar system? Reply with only the name.", ["jupiter"]),
    factTask("fact-romeo-author", "Author", "Who wrote Romeo and Juliet? Reply with only the author's name.", ["shakespeare"], { contains: true }),
    factTask("fact-ww2-end", "Historical year", "In what year did World War II end? Reply with only the year.", ["1945"]),
    factTask("fact-water-boil", "Boiling point", "At sea level, at what temperature in degrees Celsius does water boil? Reply with only the number.", ["100", "100 °c", "100°c", "100 c"]),
    factTask("fact-continents", "Count of continents", "How many continents are there on Earth by the most common count? Reply with only the number.", ["7", "seven"]),
    factTask("fact-photosynthesis-gas", "Science concept", "Which gas do plants take in from the air for photosynthesis? Reply with only the gas name.", ["carbon dioxide", "co2"], { contains: true }),
    factTask("fact-capital-italy", "Capital of Italy", "What is the capital of Italy? Reply with only the city name.", ["rome"]),
  ];
}

/**
 * A small cross-family subset for variants that only change speed (threads,
 * batch, mmap, sequences): quality barely moves there, so the full suite would
 * spend most of the run re-measuring the same answers.
 */
export const SMOKE_PROMPT_IDS = Object.freeze([
  "needle", "context-code",
  "recall-locker-first", "recall-locker-middle", "recall-two-needles",
  "javascript", "code-palindrome", "code-fibonacci", "bug-sum-to", "bug-max-of", "repo-cart-total",
  "read-sumTo-1", "read-clamp-1", "read-factorial-1", "read-repeatWord-1", "read-isEven-1",
]);

export function stripFence(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```[\w-]*\s*\n?([\s\S]*?)\n?```$/);
  return fence ? fence[1].trim() : trimmed;
}

export function normalizeAnswer(text) {
  return stripFence(text)
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!]+$/g, "")
    .trim();
}

export function extractJson(text) {
  const cleaned = stripFence(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Text without Markdown emphasis, inline code marks or list and quote markers (ADR-052). */
function plainText(text) {
  return stripFence(String(text ?? ""))
    .replace(/[*_`]+/g, "")
    .replace(/^\s*(?:[-+>]|\d+\.)\s+/gm, "")
    .trim();
}

const LEAD_IN = /^(?:the\s+)?(?:final\s+|correct\s+)?answer(?:\s+is)?\s*[:\-]?\s*/i;

/**
 * The places a person would look for a short answer: the whole reply, its first and last
 * line and any "Answer:" line, each also without an "Answer is" lead-in, a short "Label:"
 * or a short "The X is" sentence start. Never "contains anywhere", so a hedge such as
 * "3546 or 4596" is not read as either (ADR-052).
 */
function answerCandidates(text) {
  const plain = plainText(text);
  const lines = plain.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const places = [plain, lines[0], lines.at(-1), ...lines.filter((line) => /^(?:final\s+)?answer\b/i.test(line))].filter(Boolean);
  const candidates = new Set();
  for (const place of places) {
    candidates.add(place);
    const lead = place.replace(LEAD_IN, "");
    candidates.add(lead);
    const label = lead.match(/^[\w\s'-]{1,30}:\s*(.+)$/)?.[1];
    if (label) candidates.add(label);
    const sentence = lead.match(/^(?:the\s+)?[\w\s'-]{1,40}?\s+(?:is|was|are)\s+(.+)$/i)?.[1];
    if (sentence) candidates.add(sentence).add(sentence.replace(/^(?:in|at|on|from|by)\s+/i, ""));
  }
  return [...candidates].map(normalizeAnswer);
}

/** The option letter a reply chooses, or null: "B", "(B)", "B)", "Answer: B", "Option B", "the answer is (B)"; a hedge such as "B or C" chooses none. */
function chosenLetter(text) {
  const plain = plainText(text);
  if (/\b[a-h]\s+or\s+\(?[a-h]\b/i.test(plain) && plain.length < 40) return null;
  const named = [...plain.matchAll(/\b(?:answer|option|choice)(?:\s+is)?\s*[:\-]?\s*\(?([a-h])\)?(?![a-z])/gi)].at(-1)?.[1];
  if (named) return named.toLowerCase();
  return plain.match(/^\(?([a-h])(?:\)|[.:]|$)/im)?.[1]?.toLowerCase() ?? null;
}

/** The number a reply gives: the one after its last "Answer", else its last number (thousands separators and currency allowed). */
function givenNumber(text) {
  const plain = plainText(text).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const marked = [...plain.matchAll(/answer(?:\s+is)?\s*[:=]?\s*[$€£]?\s*(-?\d+(?:\.\d+)?)/gi)].at(-1)?.[1];
  if (marked !== undefined) return Number(marked);
  const numbers = [...plain.matchAll(/-?\d+(?:\.\d+)?/g)];
  return numbers.length ? Number(numbers.at(-1)[0]) : null;
}

export function evaluateTextCheck(check, text) {
  if (check.type === "exact") {
    const wanted = normalizeAnswer(check.value);
    return { passed: answerCandidates(text).includes(wanted), unreadable: false, detail: "answer read from the reply" };
  }
  if (check.type === "choice") {
    const choice = chosenLetter(text);
    return { passed: choice === check.value.toLowerCase(), unreadable: choice === null, detail: `choice: ${choice ?? "none"}` };
  }
  if (check.type === "number") {
    const found = givenNumber(text);
    return { passed: found !== null && Math.abs(found - Number(check.value)) < 1e-9, unreadable: found === null, detail: `number: ${found ?? "none"}` };
  }
  if (check.type === "oneOf") {
    const candidates = answerCandidates(text);
    return { passed: check.values.some((value) => candidates.includes(normalizeAnswer(value))), unreadable: false, detail: `answer: ${candidates[0]?.slice(0, 40) ?? ""}` };
  }
  if (check.type === "bulletCount") {
    const bullets = stripFence(text).split("\n").filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
    return { passed: bullets === check.count, detail: `${bullets} bullets` };
  }
  if (check.type === "maxWords") {
    const words = stripFence(text).split(/\s+/).filter(Boolean).length;
    return { passed: words <= check.count, detail: `${words} words` };
  }
  if (check.type === "containsAll") {
    const lower = stripFence(text).toLowerCase();
    const missing = check.values.filter((value) => !lower.includes(value.toLowerCase()));
    return { passed: missing.length === 0, detail: missing.length ? `missing ${missing.join(", ")}` : "contains all" };
  }
  if (check.type === "containsAny") {
    const lower = stripFence(text).toLowerCase();
    return { passed: check.values.some((value) => lower.includes(value.toLowerCase())), detail: `contains one of ${check.values.join("/")}` };
  }
  if (check.type === "notContains") {
    return { passed: !stripFence(text).toLowerCase().includes(check.value.toLowerCase()), detail: `does not contain ${check.value}` };
  }
  if (check.type === "contains") {
    return {
      passed: stripFence(text).toLowerCase().includes(check.value.toLowerCase()),
      detail: `contains ${check.value}`,
    };
  }
  if (check.type === "regex") {
    return { passed: new RegExp(check.pattern, check.flags ?? "i").test(stripFence(text)), detail: check.pattern };
  }
  if (check.type === "noUppercase") {
    return { passed: !/[A-Z]/.test(stripFence(text)), detail: "contains uppercase" };
  }
  if (check.type === "commaCount") {
    const items = stripFence(text)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return { passed: items.length === check.count, detail: `${items.length} items` };
  }
  if (check.type === "json") {
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { passed: false, detail: "not a JSON object" };
    }
    const fieldNames = Object.keys(parsed).sort();
    return {
      passed: JSON.stringify(fieldNames) === JSON.stringify([...check.keys].sort()),
      detail: `keys: ${fieldNames.join(", ") || "none"}`,
    };
  }
  if (check.type === "jsonValue") {
    const parsed = extractJson(text);
    return {
      passed: Boolean(parsed) && parsed[check.key] === check.value,
      detail: parsed ? `value: ${JSON.stringify(parsed[check.key])}` : "not JSON",
    };
  }
  return { passed: false, detail: `unknown check ${check.type}` };
}

export async function checkJavaScriptSyntax(text) {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "modelduck-bench-"));
  const file = path.join(directory, "answer.js");
  try {
    await writeFile(file, stripFence(text), "utf8");
    await new Promise((resolve, reject) => {
      execFile(process.execPath, ["--check", file], { timeout: 5000 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return { passed: true, detail: "node --check" };
  } catch {
    return { passed: false, detail: "syntax error" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The first fenced block anywhere in the reply, else the whole reply. */
/** The code to test: the last fenced block that defines `entry`, else the first block, else the reply (ADR-052). */
export function extractCode(text, entry = null) {
  const blocks = [...String(text ?? "").matchAll(/```[\w-]*\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const defines = entry ? new RegExp(`\\bfunction\\s+${entry}\\b|\\b(?:const|let|var)\\s+${entry}\\s*=`) : null;
  const chosen = (defines && blocks.filter((block) => defines.test(block)).at(-1)) ?? blocks[0];
  return (chosen ?? stripFence(String(text ?? ""))).trim();
}

/** Every fenced code block of a reply in order, or the whole reply when it has none. */
export function allCode(text) {
  const blocks = [...String(text ?? "").matchAll(/```[\w-]*\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  return (blocks.length ? blocks.join("\n;\n") : stripFence(String(text ?? ""))).trim();
}

const DEFINES_ANY = /\bfunction\s+\w+|\b(?:const|let|var)\s+\w+\s*=/;

const RESULT_MARKER = "__MODELDUCK_TEST_RESULTS__";

/**
 * Runs generated JavaScript against test cases in a child process started with
 * `node --permission` and no allow flags: file, child-process, worker and
 * network access are all denied, and a timeout kills runaway code. Returns one
 * check per case so a partly correct function earns partial credit.
 */
export async function runJavaScriptTests(text, check, { timeoutMs = 5000 } = {}) {
  const { execFile } = await import("node:child_process");
  const cases = check.cases ?? [];
  // A change that may touch several functions keeps every code block and runs through a hidden scenario (ADR-061).
  const code = check.harness ? allCode(text) : extractCode(text, check.entry);
  const named = check.harness ? DEFINES_ANY.test(code) : new RegExp(`\\b${check.entry}\\b`).test(code);
  const harness = [
    // The rest of a codebase item's files; the answer comes after, so its functions replace theirs.
    check.setup ?? "",
    ";",
    // `-e` runs CommonJS, so ESM export keywords would be a syntax error.
    code.replace(/^\s*export\s+(default\s+)?/gm, ""),
    ";",
    check.harness ?? "",
    ";",
    `const __cases = ${JSON.stringify(cases)};`,
    `const __fn = typeof ${check.entry} === "function" ? ${check.entry} : null;`,
    "const __results = __cases.map((c) => {",
    "  if (!__fn) return { ok: false, detail: 'function not found' };",
    "  try {",
    "    const out = __fn(...c.args);",
    "    const ok = JSON.stringify(out) === JSON.stringify(c.expect);",
    "    return { ok, detail: ok ? 'ok' : 'got ' + JSON.stringify(out) };",
    "  } catch (error) { return { ok: false, detail: 'threw ' + String(error && error.message) }; }",
    "});",
    `process.stdout.write("\\n${RESULT_MARKER}" + JSON.stringify(__results));`,
  ].join("\n");
  const outcome = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--permission", "-e", harness],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ error, stdout: String(stdout ?? "") }),
    );
  });
  const marker = outcome.stdout.lastIndexOf(RESULT_MARKER);
  let results = null;
  if (marker >= 0) {
    try {
      results = JSON.parse(outcome.stdout.slice(marker + RESULT_MARKER.length));
    } catch {
      results = null;
    }
  }
  const failure = outcome.error?.killed ? "timed out" : outcome.error ? "did not run (syntax or runtime error)" : "no results";
  return cases.map((testCase, index) => ({
    type: "jsTests",
    passed: Boolean(results?.[index]?.ok),
    // No function of that name in the reply: a format problem, not a wrong function (ADR-052).
    unreadable: !named,
    detail: `${check.entry}(${JSON.stringify(testCase.args).slice(1, -1)}): ${results?.[index]?.detail ?? failure}`,
  }));
}

export async function evaluateResponse(prompt, text) {
  const checks = [];
  for (const check of prompt.checks) {
    if (check.type === "jsTests") {
      checks.push(...(await runJavaScriptTests(text, check)));
      continue;
    }
    checks.push({
      type: check.type,
      ...(check.type === "jsSyntax"
        ? await checkJavaScriptSyntax(text)
        : evaluateTextCheck(check, text)),
    });
  }
  const passed = checks.filter((check) => check.passed).length;
  // Nothing readable where a check looked: counted apart from wrong answers.
  const unreadable = passed < checks.length && checks.some((check) => !check.passed && check.unreadable);
  return { passed, total: checks.length, unreadable, checks };
}

/** Number of checks a prompt produces; jsTests counts one per case. */
export function checkCount(prompt) {
  return prompt.checks.reduce((sum, check) => sum + (check.type === "jsTests" ? check.cases.length : 1), 0);
}
