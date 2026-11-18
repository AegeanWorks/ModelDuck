import assert from "node:assert/strict";

import { normalizeSettings } from "../src/config.js";

/**
 * The conformance check for an engine backend (ADR-160). Anyone adding an
 * engine runs this against their backend with fake I/O; if it passes, the
 * tuner, the app and the assessment can use the engine without further code.
 *
 * A backend has: start({ entry, load }), generate({ messages, settings, signal, onToken }),
 * complete({ prompt, settings, signal, onToken }), stop(), and optionally
 * unsupported(settings) -> string[] of settings it cannot honour.
 * generate and complete resolve to { text, stopReason, promptTokens, outputTokens, tokensPerSecond, firstTokenMs }
 * where stopReason is "maxTokens" or "eogToken", and call onToken with the pieces of text as they arrive.
 */
export async function checkBackendContract(backend, { entry = { id: "m1", fileName: "tiny.gguf", path: "tiny.gguf" } } = {}) {
  for (const method of ["start", "generate", "complete", "stop"]) {
    assert.equal(typeof backend[method], "function", `a backend needs ${method}()`);
  }
  const settings = normalizeSettings({ maxTokens: 16, temperature: 0 });
  if (backend.unsupported) {
    const reasons = backend.unsupported(settings);
    assert.ok(Array.isArray(reasons), "unsupported(settings) returns a list");
    assert.deepEqual(reasons, [], "default settings are always supported");
    assert.ok(Array.isArray(backend.unsupported({ ...settings, responsePrefix: "{" })), "a refusal is still a list");
  }
  await backend.start({ entry, load: { contextSize: 2048, threads: 2, batchSize: 256, sequences: 1, gpuBackend: "cpu", gpuLayers: 0 } });
  try {
    for (const [name, run] of [
      ["generate", (onToken) => backend.generate({ messages: [{ role: "user", content: "hi" }], settings, onToken })],
      ["complete", (onToken) => backend.complete({ prompt: "Once upon a time", settings, onToken })],
    ]) {
      const pieces = [];
      const result = await run((piece) => pieces.push(piece));
      assert.equal(typeof result.text, "string", `${name} returns text`);
      assert.equal(pieces.join(""), result.text, `${name} streams exactly the text it returns`);
      assert.ok(["maxTokens", "eogToken"].includes(result.stopReason), `${name} says why it stopped`);
      for (const field of ["promptTokens", "outputTokens", "tokensPerSecond", "firstTokenMs"]) {
        assert.ok(field in result, `${name} reports ${field} (null when the engine cannot tell)`);
        assert.ok(result[field] === null || Number.isFinite(result[field]), `${name} ${field} is a number or null`);
      }
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => backend.generate({ messages: [{ role: "user", content: "hi" }], settings, signal: controller.signal }), "an already-cancelled request does not run");
  } finally {
    await backend.stop();
  }
}
