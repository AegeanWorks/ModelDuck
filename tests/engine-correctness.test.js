import assert from "node:assert/strict";
import test from "node:test";

import {
  assertJsonSchemaSupported,
  countTokensWith,
  grammarSignatureFor,
  replyBudget,
} from "../src/engine.js";

// IDEA-1200: token counting must fail loudly, never silently return 0.
test("countTokensWith throws a typed error when tokenize fails", () => {
  const badModel = { tokenize: () => { throw new Error("native boom"); } };
  assert.throws(() => countTokensWith(badModel, "hello"), (error) => error.code === "token_count_failed");
  assert.equal(countTokensWith(null, "hello"), 0);
  assert.equal(countTokensWith(badModel, ""), 0);
});

// IDEA-1163: grammar cache key must include the model.
test("grammarSignatureFor differs per model", () => {
  const a = grammarSignatureFor("model-a", { structuredOutput: "json_object", jsonSchema: "" });
  const b = grammarSignatureFor("model-b", { structuredOutput: "json_object", jsonSchema: "" });
  assert.notEqual(a, b);
});

// IDEA-1160: reply budget clamps impossible requests.
test("replyBudget clamps to remaining context and reports zero when full", () => {
  assert.equal(replyBudget(100, 2048, 512), 512);
  assert.equal(replyBudget(2000, 2048, 512), 48);
  assert.equal(replyBudget(2048, 2048, 512), 0);
  assert.equal(replyBudget(3000, 2048, 512), 0);
});

// IDEA-1162: schema preflight rejects unsupported shapes with a typed error.
test("assertJsonSchemaSupported accepts plain schemas and rejects junk", () => {
  assert.doesNotThrow(() => assertJsonSchemaSupported({ type: "object" }));
  assert.doesNotThrow(() => assertJsonSchemaSupported({ anyOf: [{ type: "string" }] }));
  assert.throws(() => assertJsonSchemaSupported(null), (error) => error.code === "invalid_json_schema");
  assert.throws(() => assertJsonSchemaSupported({ type: "nonsense" }), (error) => error.code === "unsupported_json_schema");
});
