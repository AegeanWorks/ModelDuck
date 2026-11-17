import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/errors.js";
import { finishReasonFrom, rejectedParam, responseFormatSettings } from "../src/openai.js";
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

// IDEA-0859: a request's response_format becomes that request's grammar, and
// the saved settings stay untouched.
class RecordingEngine extends FakeEngine {
  constructor() {
    super();
    this.requests = [];
  }

  async chat(args) {
    this.requests.push(args.settings);
    return super.chat(args);
  }

  async complete(args) {
    this.requests.push(args.settings);
    return super.complete(args);
  }
}

function chatBody(extra = {}) {
  return {
    model: "fake-model",
    messages: [{ role: "user", content: "hello" }],
    ...extra,
  };
}

async function postOpenAi(harness, path, body) {
  return fetch(`${harness.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("responseFormatSettings maps text, json_object and json_schema", () => {
  assert.equal(responseFormatSettings({}), null);
  assert.deepEqual(responseFormatSettings({ response_format: { type: "text" } }), {
    structuredOutput: "none",
    jsonSchema: "",
  });
  assert.deepEqual(responseFormatSettings({ response_format: { type: "json_object" } }), {
    structuredOutput: "json_object",
    jsonSchema: "",
  });
  const schema = { type: "object", properties: { quack: { type: "string" } }, required: ["quack"] };
  assert.deepEqual(
    responseFormatSettings({ response_format: { type: "json_schema", json_schema: { name: "quack", schema } } }),
    { structuredOutput: "json_schema", jsonSchema: JSON.stringify(schema) },
  );
});

test("responseFormatSettings refuses an unknown type or a missing schema", () => {
  assert.throws(
    () => responseFormatSettings({ response_format: { type: "xml" } }),
    (error) => error instanceof AppError && error.code === "invalid_response_format" && error.status === 400,
  );
  assert.throws(
    () => responseFormatSettings({ response_format: { type: "json_schema" } }),
    (error) => error instanceof AppError && error.code === "invalid_json_schema" && error.status === 400,
  );
  assert.throws(
    () => responseFormatSettings({ response_format: { type: "json_schema", json_schema: { schema: [] } } }),
    (error) => error instanceof AppError && error.code === "invalid_json_schema",
  );
  const huge = { type: "object", properties: { text: { type: "string", description: "x".repeat(12001) } } };
  assert.throws(
    () => responseFormatSettings({ response_format: { type: "json_schema", json_schema: { schema: huge } } }),
    (error) => error instanceof AppError && error.code === "invalid_response_format",
  );
});

test("a chat request's response_format sets that request's grammar only", async (t) => {
  const engine = new RecordingEngine();
  const harness = await makeHarness(t, { engine });

  const response = await postOpenAi(harness, "/v1/chat/completions", chatBody({ response_format: { type: "json_object" } }));
  assert.equal(response.status, 200);
  assert.equal(engine.requests.at(-1).structuredOutput, "json_object");
  assert.equal(harness.settings.value.structuredOutput, "none", "saved settings are untouched");

  const schema = { type: "object", properties: { n: { type: "number" } } };
  const routed = await postOpenAi(
    harness,
    "/v1/chat/completions",
    chatBody({ response_format: { type: "json_schema", json_schema: { name: "n", schema } } }),
  );
  assert.equal(routed.status, 200);
  assert.equal(engine.requests.at(-1).structuredOutput, "json_schema");
  assert.equal(engine.requests.at(-1).jsonSchema, JSON.stringify(schema));
});

test("an explicit text format overrides a saved structured-output setting", async (t) => {
  const engine = new RecordingEngine();
  const harness = await makeHarness(t, { engine });
  await harness.settings.update({ structuredOutput: "json_object" });

  const plain = await postOpenAi(harness, "/v1/chat/completions", chatBody());
  assert.equal(plain.status, 200);
  assert.equal(engine.requests.at(-1).structuredOutput, "json_object", "no format keeps the saved default");

  const text = await postOpenAi(harness, "/v1/chat/completions", chatBody({ response_format: { type: "text" } }));
  assert.equal(text.status, 200);
  assert.equal(engine.requests.at(-1).structuredOutput, "none");
});

test("the completions route applies response_format too", async (t) => {
  const engine = new RecordingEngine();
  const harness = await makeHarness(t, { engine });

  const response = await postOpenAi(harness, "/v1/completions", {
    model: "fake-model",
    prompt: "hello",
    response_format: { type: "json_object" },
  });
  assert.equal(response.status, 200);
  assert.equal(engine.requests.at(-1).structuredOutput, "json_object");
  assert.equal(engine.requests.at(-1).promptRepeat, 1);
});

test("an unsupported response_format is a 400 and asks the model nothing", async (t) => {
  const engine = new RecordingEngine();
  const harness = await makeHarness(t, { engine });

  const response = await postOpenAi(harness, "/v1/chat/completions", chatBody({ response_format: { type: "xml" } }));
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.type, "invalid_request_error");
  assert.equal(payload.error.code, "invalid_response_format");
  assert.equal(engine.requests.length, 0);
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
