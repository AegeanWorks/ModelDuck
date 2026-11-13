/**
 * Suite v18 (ADR-100/IDEA-1787): paraphrase probes.
 *
 * Each probe mirrors one base suite item: the same checked contract (checks
 * verbatim, same answer budget), asked in words the search never tuned on.
 * The 1-, 2- and 3-sentence strata cover request shapes from terse to
 * conversational, two probes per stratum per lane, so a preset that leaned on
 * the base items' fixed phrasing fails probes the search cannot see coming.
 * They are held back wholly (`paraphrase: true` routes them into the holdout,
 * never the search rungs), so every tune's held-back check - and the gate's
 * informational probe - reads them as phrasing-unseen evidence. Tests pin each
 * probe's checks to its base item, so a suite edit cannot silently drift them
 * apart.
 */

import { COMPREHENSION_BANK } from "./comprehension-items.mjs";

const CODE_MAX_TOKENS = 256;
const READ_MAX_TOKENS = 32;

/** Checks copied from the base items in suite.mjs's codingPrompts; benchmark-suite-paraphrase.test.js pins them equal. */
const PALINDROME_CHECKS = [
  { args: ["Racecar"], expect: true },
  { args: ["A man, a plan, a canal: Panama"], expect: true },
  { args: ["duck"], expect: false },
  { args: [""], expect: true },
];
const REVERSE_WORDS_CHECKS = [
  { args: ["the quick duck"], expect: "duck quick the" },
  { args: ["one"], expect: "one" },
  { args: ["a b c"], expect: "c b a" },
];
const FIZZBUZZ_CHECKS = [
  { args: [3], expect: "Fizz" },
  { args: [5], expect: "Buzz" },
  { args: [15], expect: "FizzBuzz" },
  { args: [7], expect: "7" },
];
const COUNT_VOWELS_CHECKS = [
  { args: ["Duck"], expect: 1 },
  { args: ["AEIOU"], expect: 5 },
  { args: ["rhythm"], expect: 0 },
  { args: ["Hello World"], expect: 3 },
];
const UNIQUE_SORTED_CHECKS = [
  { args: [[3, 1, 3, 2]], expect: [1, 2, 3] },
  { args: [[]], expect: [] },
  { args: [[5, 5, 5]], expect: [5] },
  { args: [[-1, 10, 2, -1]], expect: [-1, 2, 10] },
];
const TITLE_CASE_CHECKS = [
  { args: ["hello duck"], expect: "Hello Duck" },
  { args: ["mODEL dUCK"], expect: "Model Duck" },
  { args: ["a"], expect: "A" },
];

/** The base items' jsTests contract, verbatim shape: one check, entry plus its pinned cases. */
const codeChecks = (entry, cases) => [{ type: "jsTests", entry, cases }];

const probe = (id, label, baseId, category, prompt, maxTokens, checks) => ({
  id,
  label,
  baseId,
  category,
  paraphrase: true,
  group: "paraphrase",
  prompt,
  maxTokens,
  checks,
});

/** One comprehension probe: the bank's verbatim code and expected value, a differently worded question. */
const readProbe = (id, label, baseName, caseIndex, prose) => {
  const entry = COMPREHENSION_BANK.find((item) => item.name === baseName);
  if (!entry) throw new Error(`paraphrase bank miss: ${baseName}`);
  const values = entry.cases[caseIndex];
  return probe(
    id,
    label,
    `read-${baseName}-${caseIndex + 1}`,
    "code-comprehension",
    `${prose.replace("{CODE}", "```js\n" + entry.code + "\n```")}`,
    READ_MAX_TOKENS,
    [{ type: "exact", value: String(entry.run(...values)) }],
  );
};

export function paraphrasePrompts() {
  const code = [
    probe(
      "para-code-s1-palindrome",
      "Paraphrase of the palindrome check",
      "code-palindrome",
      "code",
      "Write one JavaScript function, replying with code only, named isPalindrome that returns true exactly when the given string reads the same forwards and backwards after dropping every character that is not a letter or digit and ignoring case.",
      CODE_MAX_TOKENS,
      codeChecks("isPalindrome", PALINDROME_CHECKS),
    ),
    probe(
      "para-code-s1-reverse-words",
      "Paraphrase of reverse words",
      "code-reverse-words",
      "code",
      "In JavaScript, write code only for a function named reverseWords that takes one string of single-space-separated words and hands back those words in reverse order, again separated by single spaces.",
      CODE_MAX_TOKENS,
      codeChecks("reverseWords", REVERSE_WORDS_CHECKS),
    ),
    probe(
      "para-code-s2-fizzbuzz",
      "Paraphrase of the FizzBuzz value",
      "code-fizzbuzz",
      "code",
      'Create a JavaScript function called fizzBuzz for the number game. For a given positive integer it must return "FizzBuzz" when divisible by both 3 and 5, "Fizz" when divisible by only 3, "Buzz" when divisible by only 5, and otherwise the number itself as a string, replying with code only.',
      CODE_MAX_TOKENS,
      codeChecks("fizzBuzz", FIZZBUZZ_CHECKS),
    ),
    probe(
      "para-code-s2-count-vowels",
      "Paraphrase of count vowels",
      "code-count-vowels",
      "code",
      "Build a JavaScript function named countVowels. It should take a string and return how many of its characters are the vowels a, e, i, o or u, ignoring case, and reply with code only.",
      CODE_MAX_TOKENS,
      codeChecks("countVowels", COUNT_VOWELS_CHECKS),
    ),
    probe(
      "para-code-s3-unique-sorted",
      "Paraphrase of unique sorted",
      "code-unique-sorted",
      "code",
      "I want a small JavaScript helper. Call it uniqueSorted and have it take an array of numbers. It must return a new array with duplicates removed, sorted in ascending numeric order, and reply with code only.",
      CODE_MAX_TOKENS,
      codeChecks("uniqueSorted", UNIQUE_SORTED_CHECKS),
    ),
    probe(
      "para-code-s3-title-case",
      "Paraphrase of title case",
      "code-title-case",
      "code",
      "Write me some JavaScript and reply with code only. The function is named titleCase and takes a string of words separated by single spaces. It returns the same string with the first letter of each word uppercase and the remaining letters lowercase.",
      CODE_MAX_TOKENS,
      codeChecks("titleCase", TITLE_CASE_CHECKS),
    ),
  ];
  const reads = [
    readProbe(
      "para-read-s1-clamp",
      "Paraphrase of Read clamp #1",
      "clamp",
      0,
      "Study the JavaScript below and state only the value that clamp(5, 0, 10) returns for this run:\n{CODE}\nSend the value alone.",
    ),
    readProbe(
      "para-read-s1-double",
      "Paraphrase of Read double #1",
      "double",
      0,
      "Read the next snippet and reply with nothing except the output of double(3) here:\n{CODE}\nGive the value by itself.",
    ),
    readProbe(
      "para-read-s2-factorial",
      "Paraphrase of Read factorial #1",
      "factorial",
      0,
      "Here is a short function.\n{CODE}\nWork out what factorial(0) evaluates to with that input, replying with only the value.",
    ),
    readProbe(
      "para-read-s2-is-odd",
      "Paraphrase of Read isOdd #2",
      "isOdd",
      1,
      "A small helper sits below.\n{CODE}\nDecide what isOdd(8) returns in this situation, with your reply containing only the value.",
    ),
    readProbe(
      "para-read-s3-reverse-text",
      "Paraphrase of Read reverseText #2",
      "reverseText",
      1,
      'Time to read some JavaScript.\n{CODE}\nThe input string here is "ModelDuck". Tell me what reverseText("ModelDuck") produces, and answer with the resulting value alone.',
    ),
    readProbe(
      "para-read-s3-max-of-three",
      "Paraphrase of Read maxOfThree #2",
      "maxOfThree",
      1,
      "Work through this function.\n{CODE}\nIts arguments are 5, 9 and 2 in this run. Give the exact value of maxOfThree(5, 9, 2) back, replying with nothing but that value.",
    ),
  ];
  return [...code, ...reads];
}
