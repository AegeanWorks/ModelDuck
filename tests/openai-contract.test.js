import assert from "node:assert/strict";
import test from "node:test";

import { finishReasonFrom, rejectedParam } from "../src/openai.js";
import { FakeEngine, makeHarness } from "./helpers.js";

// IDEA-1085: one taxonomy everywhere.
test("finishReasonFrom maps maxTokens to length and everything else to stop", () => {
  assert.equal(finishReasonFrom("maxTokens"), "length");
  assert.equal(finishReasonFrom("eogToken"), "stop");
  assert.equal(finishReasonFrom("abort"), "stop");
  assert.equal(finishReasonFrom(undefined), "stop");
});

// IDEA-1264: unsupported params are refused, never faked.
test("rejectedParam names logit_bias, tools and functions", () => {
  assert.equal(rejectedParam({ logit_bias: {} }), "logit_bias");
  assert.equal(rejectedParam({ tools: [] }), "tools");
  assert.equal(rejectedParam({ functions: [] }), "functions");
  assert.equal(rejectedParam({ temperature: 0.5 }), null);
});

// IDEA-1080: stop sequences are accepted and passed through, not dropped.
test("stop parameter is accepted", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fake-model",
      messages: [{ role: "user", content: "hello" }],
      stop: ["Quack"],
    }),
  });
  assert.equal(response.status, 200);
});
test("logit_bias is refused with 400", async (t) => {
  const harness = await makeHarness(t);
  const response = await fetch(`${harness.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fake-model",
      messages: [{ role: "user", content: "hello" }],
      logit_bias: { 1: 2 },
    }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "unsupported_parameter");
});

// IDEA-1074: the two-phase stream failure contract. A failed stream always ends with a
// final error frame plus [DONE], and the frame carries the partial output the client
// already rendered, the failure phase and a retryable classification.
class FailingStreamEngine extends FakeEngine {
  constructor({ tokens, error }) {
    super();
    this.streamTokens = tokens;
    this.streamError = error;
  }

  async #emit(onToken) {
    for (const token of this.streamTokens) {
      onToken(token);
    }
    throw this.streamError;
  }

  async complete({ onToken }) {
    return this.#emit(onToken);
  }

  async chat({ onToken }) {
    return this.#emit(onToken);
  }
}

async function streamBody(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.text();
}

function sseEvents(body) {
  return body.trim().split("\n\n").map((event) => event.replace(/^data: /, ""));
}

test("chat stream failure sends partial output, retryable and [DONE]", async (t) => {
  const engine = new FailingStreamEngine({
    tokens: ["Quack"],
    error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  });
  const harness = await makeHarness(t, { engine });
  const body = await streamBody(`${harness.base}/v1/chat/completions`, {
    model: "fake-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  const events = sseEvents(body);
  assert.equal(events.at(-1), "[DONE]");
  const failure = JSON.parse(events.at(-2));
  assert.equal(failure.error.partial, "Quack");
  assert.equal(failure.error.phase, "mid_stream");
  assert.equal(failure.error.retryable, true);
  assert.equal(failure.error.code, "ECONNRESET");
  const tokenChunk = JSON.parse(events[1]);
  assert.equal(tokenChunk.choices[0].delta.content, "Quack");
});

test("completions stream failure is terminal for model errors", async (t) => {
  const engine = new FailingStreamEngine({
    tokens: ["Quack"],
    error: Object.assign(new Error("eval failed"), { code: "generation_failed" }),
  });
  const harness = await makeHarness(t, { engine });
  const body = await streamBody(`${harness.base}/v1/completions`, {
    model: "fake-model",
    prompt: "hello",
    stream: true,
  });
  const events = sseEvents(body);
  assert.equal(events.at(-1), "[DONE]");
  const failure = JSON.parse(events.at(-2));
  assert.equal(failure.error.partial, "Quack");
  assert.equal(failure.error.phase, "mid_stream");
  assert.equal(failure.error.retryable, false);
  assert.equal(failure.error.code, "generation_failed");
});

test("stream failure before any token reports before_first_token", async (t) => {
  const engine = new FailingStreamEngine({
    tokens: [],
    error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
  });
  const harness = await makeHarness(t, { engine });
  const body = await streamBody(`${harness.base}/v1/chat/completions`, {
    model: "fake-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  const events = sseEvents(body);
  assert.equal(events.at(-1), "[DONE]");
  const failure = JSON.parse(events.at(-2));
  assert.equal(failure.error.partial, "");
  assert.equal(failure.error.phase, "before_first_token");
  assert.equal(failure.error.retryable, true);
});
