import assert from "node:assert/strict";
import test from "node:test";

import { MULTISTEP_CHAINS, multistepHash, multistepSummary } from "../benchmarks/multistep-items.mjs";
import { carryAfter, relaxTopLevel, runChain, scoreChain, scoreStep, summarizeChains } from "../benchmarks/multistep-evaluate.mjs";
import { chainLine, selectChains, summaryLine } from "../benchmarks/multistep-run.mjs";
import { PROMPTS, SUITE_VERSION } from "../benchmarks/suite.mjs";
import { TASKS, taskSubsetHash } from "../benchmarks/tasks.mjs";

// --- the chains are real: references pass, old code fails, state is needed ----

/** The code every reference before step `index` leaves behind. */
const carriedBefore = (chain, index) => chain.steps.slice(0, index).reduce((carried, step) => carryAfter(carried, step.reference), "");

for (const chain of MULTISTEP_CHAINS) {
  test(`${chain.id}: each reference passes its step, with the earlier references loaded`, async () => {
    for (const [index, step] of chain.steps.entries()) {
      const scored = await scoreStep(step, step.reference, carriedBefore(chain, index));
      assert.equal(scored.passed, scored.total, `step ${index + 1}: ${scored.checks.filter((check) => !check.passed).map((check) => check.detail).join("; ")}`);
      assert.equal(scored.total, step.check.cases.length);
    }
  });

  test(`${chain.id}: resending the previous answer fails every later step, and earlier code is needed where a step builds on it`, async () => {
    for (const [index, step] of chain.steps.entries()) {
      if (index === 0) continue;
      const old = await scoreStep(step, chain.steps[index - 1].reference, carriedBefore(chain, index));
      assert.ok(old.passed < old.total, `step ${index + 1} must ask for something the previous answer does not do`);
      if (step.buildsOnEarlier) {
        const alone = await scoreStep(step, step.reference, "");
        assert.ok(alone.passed < alone.total, `step ${index + 1} must need the code of earlier steps`);
      }
    }
  });
}

test("the chains are opt-in: no gated item, task, version or hash includes them", () => {
  const ids = new Set(PROMPTS.map((prompt) => prompt.id));
  for (const chain of MULTISTEP_CHAINS) assert.equal(ids.has(chain.id), false);
  assert.equal(PROMPTS.length, 277, "the tuned suite is unchanged");
  assert.equal(SUITE_VERSION, 18);
  assert.deepEqual(TASKS.map((task) => task.id), ["code", "comprehension", "recall"]);
  assert.match(taskSubsetHash(), /^[a-f0-9]{16}$/);
  assert.equal(new Set(MULTISTEP_CHAINS.map((chain) => chain.id)).size, MULTISTEP_CHAINS.length, "unique chain ids");
});

test("the summary counts chains, steps and checks, and the hash follows prompts and checks only", () => {
  const summary = multistepSummary();
  assert.equal(summary.id, "multistep");
  assert.equal(summary.optIn, true);
  assert.equal(summary.chains.length, 5);
  assert.equal(summary.steps, 15);
  assert.equal(summary.checks, 59);
  assert.equal(summary.hash, multistepHash());
  const edited = MULTISTEP_CHAINS.map((chain, index) => (index === 0 ? { ...chain, steps: chain.steps.map((step, at) => (at === 0 ? { ...step, prompt: `${step.prompt} ` } : step)) } : chain));
  assert.notEqual(multistepHash(edited), multistepHash(), "a prompt edit changes the hash");
  const reworded = MULTISTEP_CHAINS.map((chain) => ({ ...chain, steps: chain.steps.map((step) => ({ ...step, reference: "x" })) }));
  assert.equal(multistepHash(reworded), multistepHash(), "references are proof, not identity");
});

// --- carrying code between steps ----------------------------------------------

test("only unindented const and let become var, so redeclaring a carried name is not a syntax error", () => {
  assert.equal(relaxTopLevel("const median = (xs) => 1;\nlet total = 0;"), "var median = (xs) => 1;\nvar total = 0;");
  const inside = "function f() {\n  const x = 1;\n  for (let i = 0; i < 2; i += 1) {}\n}";
  assert.equal(relaxTopLevel(inside), inside, "scoping inside a function is untouched");
});

test("a step scores a reply that redeclares a carried const", async () => {
  const step = MULTISTEP_CHAINS.find((chain) => chain.id === "multistep-median").steps[1];
  const first = "```js\nconst median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];\n```";
  const second = "```js\nconst median = (numbers) => {\n  const s = [...numbers].sort((a, b) => a - b);\n  const m = Math.floor(s.length / 2);\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n};\n```";
  const scored = await scoreStep(step, second, carryAfter("", first));
  assert.equal(scored.passed, scored.total);
});

// --- running a chain as one conversation ----------------------------------------

/** An engine double that answers each step with the chain's reference and records every request. */
function scriptedEngine(replies) {
  const engine = { requests: [], dropped: [] };
  engine.chat = async (request) => {
    const { onToken: _onToken, signal: _signal, ...data } = request;
    engine.requests.push(structuredClone(data));
    const reply = replies[engine.requests.length - 1];
    if (reply instanceof Error) throw reply;
    return { text: reply, stats: { ms: 7, outputTokens: 3 } };
  };
  engine.dropSession = (id) => engine.dropped.push(id);
  return engine;
}

const COUNTER = MULTISTEP_CHAINS.find((chain) => chain.id === "multistep-counter");

test("a chain is one conversation that carries the model's own earlier replies", async () => {
  const engine = scriptedEngine(COUNTER.steps.map((step) => step.reference));
  const seen = [];
  const result = await runChain({ engine, chain: COUNTER, seed: 7, onStep: (row) => seen.push(row.step) });
  assert.equal(result.passed, result.total);
  assert.equal(result.allSteps, true);
  assert.equal(result.prefix, 3);
  assert.deepEqual(seen, [1, 2, 3]);
  const ids = new Set(engine.requests.map((request) => request.conversationId));
  assert.equal(ids.size, 1, "one conversation per chain");
  const last = engine.requests.at(-1).messages;
  assert.deepEqual(last.map((message) => message.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(last[1].content, COUNTER.steps[0].reference, "the model's first reply is in the third request");
  assert.equal(engine.requests[0].settings.temperature, 0, "greedy by default");
  assert.equal(engine.requests[0].settings.seed, 7);
  assert.deepEqual(engine.dropped, ["multistep-multistep-counter-7"], "the session is released");
});

test("a reply that resends old code scores low but keeps the chain going, and the prefix stops at the first miss", async () => {
  const engine = scriptedEngine([COUNTER.steps[0].reference, COUNTER.steps[0].reference, COUNTER.steps[2].reference]);
  const result = await runChain({ engine, chain: COUNTER });
  assert.equal(result.steps[0].passed, result.steps[0].total);
  assert.ok(result.steps[1].passed < result.steps[1].total, "step 2 asked for dec and reset");
  assert.equal(result.steps[2].passed, result.steps[2].total, "a correct later answer still counts");
  assert.equal(result.allSteps, false);
  assert.equal(result.prefix, 1);
});

test("an engine error scores its step as zero, records why and does not stop the chain", async () => {
  const engine = scriptedEngine([COUNTER.steps[0].reference, new Error("context full"), COUNTER.steps[2].reference]);
  const result = await runChain({ engine, chain: COUNTER, settings: { temperature: 0.3, maxTokens: 64 } });
  assert.equal(result.steps[1].error, "context full");
  assert.equal(result.steps[1].passed, 0);
  assert.equal(result.steps[1].total, COUNTER.steps[1].check.cases.length, "the total stays fixed");
  assert.equal(engine.requests.length, 3);
  assert.equal(engine.requests[2].messages[3].content, "", "the failed turn is an empty reply in the history");
  assert.equal(engine.requests[0].settings.temperature, 0.3, "a tuned preset replaces the greedy default");
  assert.equal(engine.requests[0].settings.maxTokens, 64);
});

test("the summary reports checks, fully solved chains and the rate at each depth", () => {
  const row = (passed, total) => ({ passed, total, error: null });
  const results = [
    scoreChain("a", 42, [row(3, 3), row(4, 4), row(4, 4)]),
    scoreChain("b", 42, [row(3, 3), row(2, 4), row(0, 4)]),
  ];
  const summary = summarizeChains(results);
  assert.deepEqual({ passed: summary.passed, total: summary.total, rate: summary.rate }, { passed: 16, total: 22, rate: 72.7 });
  assert.equal(summary.allSteps, 1);
  assert.equal(summary.allStepsRate, 50);
  assert.equal(summary.meanPrefix, 2);
  assert.deepEqual(summary.byStep.map((step) => step.rate), [100, 75, 50]);
  assert.deepEqual(summarizeChains([]).byStep, []);
});

// --- the CLI ---------------------------------------------------------------------

test("the CLI runs every chain by default, a chosen subset in suite order, and refuses an unknown id", () => {
  assert.equal(selectChains(null).length, 5);
  assert.deepEqual(selectChains(["multistep-slug", "multistep-counter"]).map((chain) => chain.id), ["multistep-counter", "multistep-slug"]);
  assert.throws(() => selectChains(["multistep-nope"]), (error) => error.code === "multistep_chain_unknown");
});

test("the CLI prints each step and the depth rates", () => {
  const result = scoreChain("multistep-counter", 42, [
    { step: 1, passed: 3, total: 3, error: null, unreadable: false },
    { step: 2, passed: 1, total: 4, error: null, unreadable: true },
    { step: 3, passed: 0, total: 4, error: "timed out", unreadable: false },
  ]);
  assert.equal(chainLine(result), "multistep-counter [seed 42] 1: 3/3 · 2: 1/4 (unreadable) · 3: 0/4 (error) → 4/11 (36.4%)");
  const summary = summarizeChains([result]);
  assert.equal(summaryLine(summary), "Multistep: 4/11 checks (36.4%) · 0/1 chains solved in every step · step 1 100% · step 2 25% · step 3 0% · 1 step errors");
});
