import { createHash } from "node:crypto";

/**
 * Multistep chains: one conversation, several dependent steps. Each step asks
 * for code that changes or builds on what the model wrote before, and is
 * checked by executable tests with that earlier code loaded first. A step that
 * says "you do not need to repeat" only passes if the chain really carries
 * state; a step that changes behaviour fails if the model resends its old code.
 *
 * Opt-in and separate from the tuned suite: these chains are not in PROMPTS,
 * TASKS, the test hash or the task-subset hash, so no gated identity changes.
 * Every chain carries `reference` replies; tests prove each reference passes
 * its step, each earlier reply fails a step that changes behaviour, and each
 * step that builds on earlier code fails without it.
 */

/** The version of these chains; bump it when a prompt, check or reference changes. */
export const MULTISTEP_VERSION = 1;

const block = (code) => `\`\`\`js\n${code.trim()}\n\`\`\``;
const ONE_BLOCK = "Reply with the code in one fenced block.";
const NO_REPEAT = (names) => `Reply with the code in one fenced block; you do not need to repeat ${names}.`;
const WHOLE = (name) => `Reply with the whole updated \`${name}\` in one fenced block.`;

// --- counter: an API that grows, every method kept working ---------------------

const COUNTER_SCENARIO = `function scenario(ops) {
  let counter = createCounter();
  return ops.map((op) => (op === "new" ? ((counter = createCounter()), "new") : counter[op]()));
}`;

const COUNTER = {
  id: "multistep-counter",
  label: "Counter that grows a method at a time",
  kind: "evolving API",
  steps: [
    {
      prompt: `Write a JavaScript function \`createCounter()\` that returns an object with two methods: \`inc()\` adds 1 to the count and returns the new count, and \`value()\` returns the current count. A new counter starts at 0, and each counter has its own count. ${ONE_BLOCK}`,
      check: { type: "jsTests", entry: "scenario", harness: COUNTER_SCENARIO, cases: [
        { args: [["value"]], expect: [0] },
        { args: [["inc", "inc", "value"]], expect: [1, 2, 2] },
        { args: [["inc", "inc", "new", "value"]], expect: [1, 2, "new", 0] },
      ] },
      reference: block(`
function createCounter() {
  let count = 0;
  return {
    inc() { count += 1; return count; },
    value() { return count; },
  };
}`),
    },
    {
      prompt: `Extend your \`createCounter\` with \`dec()\`, which subtracts 1 and returns the new count but never goes below 0, and \`reset()\`, which sets the count back to 0 and returns 0. Keep \`inc()\` and \`value()\` working. ${WHOLE("createCounter")}`,
      check: { type: "jsTests", entry: "scenario", harness: COUNTER_SCENARIO, cases: [
        { args: [["inc", "inc", "dec", "value"]], expect: [1, 2, 1, 1] },
        { args: [["dec", "value"]], expect: [0, 0] },
        { args: [["inc", "inc", "reset", "inc"]], expect: [1, 2, 0, 1] },
        { args: [["inc", "dec", "dec", "inc"]], expect: [1, 0, 0, 1] },
      ] },
      reference: block(`
function createCounter() {
  let count = 0;
  return {
    inc() { count += 1; return count; },
    dec() { count = Math.max(0, count - 1); return count; },
    reset() { count = 0; return count; },
    value() { return count; },
  };
}`),
    },
    {
      prompt: `Add \`history()\` to your counter: it returns an array of the count after every \`inc\`, \`dec\` and \`reset\` call so far, oldest first; a new counter's history is empty. Calls to \`value()\` and \`history()\` are not recorded. ${WHOLE("createCounter")}`,
      check: { type: "jsTests", entry: "scenario", harness: COUNTER_SCENARIO, cases: [
        { args: [["history"]], expect: [[]] },
        { args: [["inc", "inc", "dec", "history"]], expect: [1, 2, 1, [1, 2, 1]] },
        { args: [["dec", "reset", "inc", "history"]], expect: [0, 0, 1, [0, 0, 1]] },
        { args: [["inc", "value", "history"]], expect: [1, 1, [1]] },
      ] },
      reference: block(`
function createCounter() {
  let count = 0;
  const seen = [];
  const record = () => { seen.push(count); return count; };
  return {
    inc() { count += 1; return record(); },
    dec() { count = Math.max(0, count - 1); return record(); },
    reset() { count = 0; return record(); },
    value() { return count; },
    history() { return [...seen]; },
  };
}`),
    },
  ],
};

// --- csv: each function is built on the one before -----------------------------

const CSV = {
  id: "multistep-csv",
  label: "CSV pipeline built on earlier functions",
  kind: "builds on earlier code",
  steps: [
    {
      prompt: `Write a JavaScript function \`parseCsvLine(line)\` that splits one line of comma-separated values into an array of strings, trimming spaces around each value. Empty values stay as empty strings. There are no quotes. ${ONE_BLOCK}`,
      check: { type: "jsTests", entry: "parseCsvLine", cases: [
        { args: ["a,b,c"], expect: ["a", "b", "c"] },
        { args: [" x , y "], expect: ["x", "y"] },
        { args: ["1,,3"], expect: ["1", "", "3"] },
        { args: ["solo"], expect: ["solo"] },
      ] },
      reference: block(`
function parseCsvLine(line) {
  return line.split(",").map((value) => value.trim());
}`),
    },
    {
      prompt: `Using your \`parseCsvLine\`, write \`parseCsv(text)\`: lines are separated by "\\n", the first non-blank line holds the column names, and every later non-blank line becomes an object mapping each column name to its value. Blank lines are skipped. ${NO_REPEAT("`parseCsvLine`")}`,
      check: { type: "jsTests", entry: "parseCsv", cases: [
        { args: ["name,age\nAda,36\nAlan,41"], expect: [{ name: "Ada", age: "36" }, { name: "Alan", age: "41" }] },
        { args: ["\nid, v \n\n1, a\n"], expect: [{ id: "1", v: "a" }] },
        { args: ["h\n"], expect: [] },
      ] },
      buildsOnEarlier: true,
      reference: block(`
function parseCsv(text) {
  const lines = text.split("\\n").filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((name, index) => { row[name] = values[index] ?? ""; });
    return row;
  });
}`),
    },
    {
      prompt: `Using your \`parseCsv\`, write \`totalBy(text, keyColumn, valueColumn)\` that sums the numeric values of \`valueColumn\` for each distinct value of \`keyColumn\` and returns an object such as \`{ north: 30, south: 5 }\`, with keys in the order they are first seen. ${NO_REPEAT("the earlier functions")}`,
      check: { type: "jsTests", entry: "totalBy", cases: [
        { args: ["region,sales\nnorth,10\nsouth,5\nnorth,20", "region", "sales"], expect: { north: 30, south: 5 } },
        { args: ["k,v\na,1.5\nb,2\na,0.5", "k", "v"], expect: { a: 2, b: 2 } },
        { args: ["k,v", "k", "v"], expect: {} },
      ] },
      buildsOnEarlier: true,
      reference: block(`
function totalBy(text, keyColumn, valueColumn) {
  const totals = {};
  for (const row of parseCsv(text)) {
    const key = row[keyColumn];
    totals[key] = (totals[key] ?? 0) + Number(row[valueColumn]);
  }
  return totals;
}`),
    },
  ],
};

// --- median: a fix after feedback, then new code on the fixed function ---------

const UNCHANGED = (call) => `function scenario(xs) {
  const before = JSON.stringify(xs);
  const out = ${call};
  return [out, JSON.stringify(xs) === before];
}`;

const MEDIAN = {
  id: "multistep-median",
  label: "Median fixed after feedback, then reused",
  kind: "fix after feedback",
  steps: [
    {
      prompt: `Write a JavaScript function \`median(numbers)\` that returns the median of a non-empty array of numbers: the middle value after sorting, or the average of the two middle values when the length is even. ${ONE_BLOCK}`,
      check: { type: "jsTests", entry: "median", cases: [
        { args: [[3, 1, 2]], expect: 2 },
        { args: [[4, 1, 3, 2]], expect: 2.5 },
        { args: [[7]], expect: 7 },
        { args: [[10, 2, 38, 23, 38, 23, 21]], expect: 23 },
        { args: [[1, 10, 2]], expect: 2 },
      ] },
      // Sorting in place passes this step; the next one is the feedback that it must not.
      reference: block(`
function median(numbers) {
  numbers.sort((a, b) => a - b);
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}`),
    },
    {
      prompt: `Your \`median\` is called on arrays the caller keeps using. Make sure it does not change the array it is given: after \`const xs = [3, 1, 2]; median(xs)\`, \`xs\` must still be \`[3, 1, 2]\`. ${WHOLE("median")}`,
      check: { type: "jsTests", entry: "scenario", harness: UNCHANGED("median(xs)"), cases: [
        { args: [[3, 1, 2]], expect: [2, true] },
        { args: [[5, 4, 1, 2]], expect: [3, true] },
        { args: [[1, 10, 2]], expect: [2, true] },
      ] },
      reference: block(`
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}`),
    },
    {
      prompt: `Write the JavaScript functions \`mode(numbers)\` that returns the value that appears most often (the smallest one on a tie), and \`summary(numbers)\` that returns \`{ median, mode }\` using your two functions. Neither may change the array it is given. ${NO_REPEAT("`median`")}`,
      check: { type: "jsTests", entry: "scenario", harness: UNCHANGED("(() => { const s = summary(xs); return [s.median, s.mode]; })()"), cases: [
        { args: [[3, 1, 2, 3]], expect: [[2.5, 3], true] },
        { args: [[1, 2, 2, 1]], expect: [[1.5, 1], true] },
        { args: [[5]], expect: [[5, 5], true] },
      ] },
      buildsOnEarlier: true,
      reference: block(`
function mode(numbers) {
  const counts = new Map();
  for (const n of numbers) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = null;
  for (const [n, count] of counts) {
    if (best === null || count > counts.get(best) || (count === counts.get(best) && n < best)) best = n;
  }
  return best;
}

function summary(numbers) {
  return { median: median(numbers), mode: mode(numbers) };
}`),
    },
  ],
};

// --- shipping: rules given once, applied again two turns later -------------------

const SHIPPING = {
  id: "multistep-shipping",
  label: "Shipping rules given once, used two turns later",
  kind: "recall then act",
  steps: [
    {
      prompt: `Shipping rules for a shop: up to 1 kg costs 4 euros; above 1 kg and up to 5 kg costs 9 euros; above 5 kg costs 9 euros plus 2 euros for every started kilogram above 5 kg (so 6.2 kg costs 9 + 2 × 2 = 13). Write a JavaScript function \`shippingCost(weightKg)\` that returns the cost in euros. ${ONE_BLOCK}`,
      check: { type: "jsTests", entry: "shippingCost", cases: [
        { args: [0.5], expect: 4 },
        { args: [1], expect: 4 },
        { args: [1.01], expect: 9 },
        { args: [5], expect: 9 },
        { args: [6], expect: 11 },
        { args: [6.2], expect: 13 },
      ] },
      reference: block(`
function shippingCost(weightKg) {
  if (weightKg <= 1) return 4;
  if (weightKg <= 5) return 9;
  return 9 + 2 * Math.ceil(weightKg - 5);
}`),
    },
    {
      prompt: `Orders heavier than 30 kg cannot be shipped: \`shippingCost\` must now throw an Error for them; everything else stays as it was. ${WHOLE("shippingCost")}`,
      check: { type: "jsTests", entry: "scenario", harness: `function scenario(weightKg) {
  try { return shippingCost(weightKg); } catch (error) { return error instanceof Error ? "refused" : "threw a non-Error"; }
}`, cases: [
        { args: [30], expect: 59 },
        { args: [30.5], expect: "refused" },
        { args: [2], expect: 9 },
        { args: [100], expect: "refused" },
      ] },
      reference: block(`
function shippingCost(weightKg) {
  if (weightKg > 30) throw new Error("Parcels above 30 kg cannot be shipped.");
  if (weightKg <= 1) return 4;
  if (weightKg <= 5) return 9;
  return 9 + 2 * Math.ceil(weightKg - 5);
}`),
    },
    {
      prompt: `Write a JavaScript function \`quote(items)\` where \`items\` is an array of \`{ name, weightKg }\`. All items ship together in one parcel, so the cost is \`shippingCost\` of their total weight; return \`{ weightKg, cost }\`, or \`{ weightKg, cost: null }\` when the parcel cannot be shipped. ${NO_REPEAT("`shippingCost`")}`,
      check: { type: "jsTests", entry: "scenario", harness: `function scenario(items) {
  const q = quote(items);
  return [q.weightKg, q.cost];
}`, cases: [
        { args: [[{ name: "a", weightKg: 0.4 }, { name: "b", weightKg: 0.5 }]], expect: [0.9, 4] },
        { args: [[{ name: "a", weightKg: 3 }, { name: "b", weightKg: 3 }]], expect: [6, 11] },
        { args: [[{ name: "a", weightKg: 20 }, { name: "b", weightKg: 15 }]], expect: [35, null] },
        { args: [[{ name: "x", weightKg: 5 }]], expect: [5, 9] },
      ] },
      buildsOnEarlier: true,
      reference: block(`
function quote(items) {
  const weightKg = items.reduce((sum, item) => sum + item.weightKg, 0);
  try {
    return { weightKg, cost: shippingCost(weightKg) };
  } catch {
    return { weightKg, cost: null };
  }
}`),
    },
  ],
};

// --- slug: a signature that grows, then a function on top ----------------------

const SLUG = {
  id: "multistep-slug",
  label: "Slug with a new option, then unique slugs",
  kind: "extend then build on",
  steps: [
    {
      prompt: `Write a JavaScript function \`slugify(title)\`: lowercase the title, replace every run of characters that are not a-z or 0-9 with a single \`-\`, and remove \`-\` from both ends. ${ONE_BLOCK}`,
      check: { type: "jsTests", entry: "slugify", cases: [
        { args: ["Hello World"], expect: "hello-world" },
        { args: ["  Ready, Set, Go!  "], expect: "ready-set-go" },
        { args: ["C++ & Rust 2026"], expect: "c-rust-2026" },
        { args: ["---"], expect: "" },
      ] },
      reference: block(`
function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}`),
    },
    {
      prompt: `Add an optional second parameter \`maxLength\` to \`slugify\`: when it is given, cut the slug to at most \`maxLength\` characters and then remove any \`-\` left at the end. Without it, nothing changes. ${WHOLE("slugify")}`,
      check: { type: "jsTests", entry: "slugify", cases: [
        { args: ["Hello World", 5], expect: "hello" },
        { args: ["Hello World", 6], expect: "hello" },
        { args: ["Hello World"], expect: "hello-world" },
        { args: ["a b c d", 3], expect: "a-b" },
        { args: ["Hello World", 50], expect: "hello-world" },
      ] },
      reference: block(`
function slugify(title, maxLength) {
  let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (maxLength !== undefined) slug = slug.slice(0, maxLength).replace(/-+$/, "");
  return slug;
}`),
    },
    {
      prompt: `Write a JavaScript function \`uniqueSlug(title, taken)\`: return \`slugify(title)\` unless that slug is in the array \`taken\`; then append \`-2\`, \`-3\` and so on, and return the first one not in \`taken\`. ${NO_REPEAT("`slugify`")}`,
      check: { type: "jsTests", entry: "uniqueSlug", cases: [
        { args: ["Hello World", []], expect: "hello-world" },
        { args: ["Hello World", ["hello-world"]], expect: "hello-world-2" },
        { args: ["Hello World", ["hello-world", "hello-world-2"]], expect: "hello-world-3" },
        { args: ["Hi", ["hello-world"]], expect: "hi" },
      ] },
      buildsOnEarlier: true,
      reference: block(`
function uniqueSlug(title, taken) {
  const base = slugify(title);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(\`\${base}-\${n}\`)) n += 1;
  return \`\${base}-\${n}\`;
}`),
    },
  ],
};

const freeze = (chain) => Object.freeze({ ...chain, steps: Object.freeze(chain.steps.map((step) => Object.freeze({ maxTokens: 512, buildsOnEarlier: false, ...step }))) });

/** Every multistep chain, in a fixed order. */
export const MULTISTEP_CHAINS = Object.freeze([COUNTER, CSV, MEDIAN, SHIPPING, SLUG].map(freeze));

/** Identity of the chains (prompts and checks, not references), for result stamps. */
export function multistepHash(chains = MULTISTEP_CHAINS) {
  const shape = chains.map((chain) => ({ id: chain.id, steps: chain.steps.map(({ prompt, check, maxTokens }) => ({ prompt, check, maxTokens })) }));
  return createHash("sha256").update(JSON.stringify({ version: MULTISTEP_VERSION, shape })).digest("hex").slice(0, 16);
}

/** What GET /api/benchmarks/suite and the Bench page say about the opt-in multistep evaluation. */
export function multistepSummary(chains = MULTISTEP_CHAINS) {
  const checks = chains.reduce((sum, chain) => sum + chain.steps.reduce((inner, step) => inner + step.check.cases.length, 0), 0);
  return {
    id: "multistep",
    label: "Multistep",
    optIn: true,
    version: MULTISTEP_VERSION,
    hash: multistepHash(chains),
    chains: chains.map((chain) => ({ id: chain.id, label: chain.label, kind: chain.kind, steps: chain.steps.length })),
    steps: chains.reduce((sum, chain) => sum + chain.steps.length, 0),
    checks,
    command: "npm run bench:multistep -- --model <id>",
    description: "One conversation per chain; each step changes or builds on the code the model wrote before and is checked with that code loaded. Not part of the tune or the gate.",
  };
}
