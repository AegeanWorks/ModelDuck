import assert from "node:assert/strict";
import test from "node:test";

import { ThinkSplitter, splitThinking } from "../src/thinking.js";
import { FakeEngine, makeHarness } from "./helpers.js";

test("IDEA-0997 splitThinking separates a leading think block from the answer", () => {
  assert.deepEqual(splitThinking("<think>\nstep one\n</think>\n\nThe answer is 4."), {
    reasoning: "step one",
    content: "The answer is 4.",
  });
});

test("IDEA-0997 splitThinking leaves text without a think block untouched", () => {
  assert.deepEqual(splitThinking("Just an answer with <b>markup</b>."), {
    reasoning: "",
    content: "Just an answer with <b>markup</b>.",
  });
});

test("IDEA-0997 splitThinking treats an unclosed block as all reasoning (cut off by the token limit)", () => {
  assert.deepEqual(splitThinking("<think>still thinking when the limit hit"), {
    reasoning: "still thinking when the limit hit",
    content: "",
  });
});

test("IDEA-0997 a think tag later in the answer is ordinary text", () => {
  const text = "Use the <think> tag like so.";
  assert.deepEqual(splitThinking(text), { reasoning: "", content: text });
});

function run(chunks) {
  const splitter = new ThinkSplitter();
  const out = { reasoning: "", content: "" };
  for (const chunk of [...chunks, null]) {
    for (const part of chunk === null ? splitter.flush() : splitter.push(chunk)) {
      out[part.kind] += part.text;
    }
  }
  return out;
}

test("IDEA-0997 ThinkSplitter matches splitThinking however the text is chunked", () => {
  const text = "<think>\nweigh it up\n</think>\n\nFinal: 42";
  const whole = splitThinking(text);
  for (let size = 1; size <= text.length; size += 1) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    assert.deepEqual(run(chunks), whole, `chunk size ${size}`);
  }
});

test("IDEA-0997 ThinkSplitter passes plain text through at once, holding back nothing it can decide", () => {
  const splitter = new ThinkSplitter();
  assert.deepEqual(splitter.push("Hello there"), [{ kind: "content", text: "Hello there" }]);
  assert.deepEqual(splitter.push(" and more <"), [{ kind: "content", text: " and more <" }]);
  assert.deepEqual(splitter.flush(), []);
});

test("IDEA-0997 ThinkSplitter flush releases a held partial tag as content", () => {
  const splitter = new ThinkSplitter();
  assert.deepEqual(splitter.push("<thi"), []);
  assert.deepEqual(splitter.flush(), [{ kind: "content", text: "<thi" }]);
});

// The HTTP surface: the answer stays clean and the thinking is reported apart.
class ThinkingEngine extends FakeEngine {
  async chat({ onToken }) {
    const tokens = ["<thi", "nk>\nweigh", " it\n</th", "ink>\n\n", "Four.", ""];
    for (const token of tokens) onToken(token);
    return { text: tokens.join(""), stats: { stopReason: "eogToken", promptTokens: 1, completionTokens: 2 }, manifest: this.manifest };
  }
}

const ask = (harness, extra = {}) =>
  fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "2+2?" }], ...extra }),
  });

test("IDEA-0997 a non-streaming reply carries reasoning_content apart from content", async (t) => {
  const harness = await makeHarness(t, { engine: new ThinkingEngine() });
  const payload = await (await ask(harness)).json();
  assert.equal(payload.choices[0].message.content, "Four.");
  assert.equal(payload.choices[0].message.reasoning_content, "weigh it");
});

test("IDEA-0997 a streamed reply sends reasoning_content deltas, then content deltas", async (t) => {
  const harness = await makeHarness(t, { engine: new ThinkingEngine() });
  const body = await (await ask(harness, { stream: true })).text();
  const deltas = body
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""))
    .filter((event) => event !== "[DONE]")
    .map((event) => JSON.parse(event).choices[0].delta);
  assert.equal(deltas.map((d) => d.reasoning_content ?? "").join(""), "weigh it");
  assert.equal(deltas.map((d) => d.content ?? "").join(""), "Four.");
  assert.equal(deltas.some((d) => d.content?.includes("think")), false);
});
