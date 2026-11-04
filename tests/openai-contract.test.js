import assert from "node:assert/strict";
import test from "node:test";

import { finishReasonFrom, rejectedParam } from "../src/openai.js";
import { makeHarness } from "./helpers.js";

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
