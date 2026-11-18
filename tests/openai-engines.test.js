import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { OpenAICompatBackend, parseOpenAiSpec } from "../src/external-engines.js";
import { OpenAICompatAdapter } from "../src/inference-engine-adapters.js";
import { externalSetFrom } from "../src/inference-engines.js";

const REGISTRY = { findById: () => null };

// An OpenAI-compatible server (vLLM, koboldcpp, mistral.rs...) as the tuner meets it: models, a version, and an SSE stream.
function openAiServer({ models = ["tiny-q4"], finish = "stop", chunks = ["Fo", "ur", "."], gapMs = 15, apiKey = null } = {}) {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
        if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
          res.writeHead(401).end("{}");
          return;
        }
        if (req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        } else if (req.url === "/version") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "0.11.2" }));
        } else if (req.url === "/v1/chat/completions") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const piece of chunks) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
            await new Promise((done) => setTimeout(done, gapMs));
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 3 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(404).end("{}");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
    }));
  });
}

test("an engine address is name=url with an optional model, and anything else is refused", () => {
  assert.deepEqual(parseOpenAiSpec("vllm=http://127.0.0.1:8000/v1"), { name: "vllm", baseUrl: "http://127.0.0.1:8000/v1", model: null });
  assert.deepEqual(parseOpenAiSpec("kobold=http://localhost:5001/v1/#tiny-q4"), { name: "kobold", baseUrl: "http://localhost:5001/v1", model: "tiny-q4" });
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  for (const bad of ["vllm", "=http://x/v1", "a=ftp://x", "a b=http://x", ""]) {
    assert.throws(() => parseOpenAiSpec(bad), (error) => error.code === "bad_option" && /name=url/.test(error.why), bad);
  }
});

test("an attached server is streamed: tokens/s from the stream, prompt time from the first token, usage for the counts", async () => {
  const server = await openAiServer();
  try {
    const backend = new OpenAICompatBackend({ baseUrl: `${server.base}/v1` });
    await backend.start({ entry: { fileName: "tiny-q4.gguf" } });
    const result = await backend.generate({ messages: [{ role: "user", content: "2+2?" }], settings: { maxTokens: 32, temperature: 0, topP: 1, topK: 40, minP: 0.05, repeatPenalty: 1.1, seed: 5 } });
    assert.equal(result.text, "Four.");
    assert.equal(result.stopReason, "eogToken");
    assert.equal(result.promptTokens, 40);
    assert.equal(result.outputTokens, 3);
    assert.ok(result.tokensPerSecond > 10 && result.tokensPerSecond < 400, `two gaps of about 15 ms: ${result.tokensPerSecond}`);
    assert.ok(result.firstTokenMs >= 0);
    const sent = server.seen.find((request) => request.url === "/v1/chat/completions").body;
    assert.equal(sent.model, "tiny-q4", "the one model the server lists");
    assert.deepEqual([sent.stream, sent.stream_options, sent.max_tokens, sent.seed], [true, { include_usage: true }, 32, 5]);
    assert.equal(sent.repetition_penalty, 1.1, "vLLM's name for the penalty");
    assert.equal(sent.repeat_penalty, 1.1, "llama.cpp's name for it");
  } finally {
    await server.close();
  }
});

test("a length finish is the token cap, and a missing model or unreachable server refuses with a Why and a Fix", async () => {
  const server = await openAiServer({ models: ["a", "b"], finish: "length" });
  try {
    const backend = new OpenAICompatBackend({ baseUrl: `${server.base}/v1`, model: "b" });
    await backend.start({ entry: { fileName: "whatever.gguf" } });
    assert.equal((await backend.generate({ messages: [], settings: {} })).stopReason, "maxTokens");
    await assert.rejects(
      () => new OpenAICompatBackend({ baseUrl: `${server.base}/v1` }).start({ entry: { fileName: "zzz.gguf" } }),
      (error) => /lists 2 models/.test(error.why) && /#model-id/.test(error.fix),
    );
  } finally {
    await server.close();
  }
  await assert.rejects(
    () => new OpenAICompatBackend({ baseUrl: "http://127.0.0.1:1/v1" }).start({ entry: { fileName: "x.gguf" } }),
    (error) => error.code === "engine_start_failed" && /did not answer/.test(error.why) && Boolean(error.fix),
  );
});

test("the attached server's version and speed are assessed, and the key is sent when one is given", async () => {
  const server = await openAiServer({ apiKey: "sekret" });
  try {
    const adapter = new OpenAICompatAdapter({ spec: { name: "vllm", baseUrl: `${server.base}/v1`, model: null }, apiKey: "sekret" });
    assert.equal(adapter.id, "openai:vllm");
    const found = await adapter.detect();
    assert.deepEqual([found.available, found.version, found.location], [true, "0.11.2", `${server.base}/v1`]);
    const measured = await adapter.measure({ entry: { fileName: "tiny-q4.gguf" }, runs: 2 });
    assert.ok(measured.genTps > 0);
    assert.ok(measured.promptTps > 0);
    assert.equal(server.seen.filter((request) => request.url === "/v1/chat/completions").length, 3, "one warm-up and two counted");
    assert.ok(server.seen.every((request) => request.auth === "Bearer sekret"));
    const noKey = await new OpenAICompatAdapter({ spec: { name: "x", baseUrl: `${server.base}/v1`, model: null } }).detect();
    assert.equal(noKey.available, false, "a refused key is reported, not guessed around");
    assert.match(noKey.reason, /HTTP 401/);
  } finally {
    await server.close();
  }
  const down = await new OpenAICompatAdapter({ spec: { name: "gone", baseUrl: "http://127.0.0.1:1/v1", model: null } }).detect();
  assert.equal(down.available, false);
  assert.match(down.reason, /is the server running/);
});

test("the tuner uses each installed llama-server variant and each attached server as its own engine", () => {
  const assessment = {
    results: [
      { id: "llama-server:cpu", ok: true, location: "C:\\e\\cpu\\llama-server.exe", backends: ["cpu"] },
      { id: "llama-server:vulkan", ok: true, location: "C:\\e\\vk\\llama-server.exe", backends: ["vulkan"] },
      { id: "llama-server:cuda", ok: false, location: "C:\\e\\cu\\llama-server.exe", backends: ["cuda"] },
      // hygiene: allow a fixture address: fetch is injected, nothing is loaded
      { id: "openai:vllm", ok: true, location: "http://h:8000/v1" },
      // hygiene: allow a fixture address: fetch is injected, nothing is loaded
      { id: "openai:unlisted", ok: true, location: "http://h:9/v1" },
    ],
  };
  // hygiene: allow a fixture address: fetch is injected, nothing is loaded
  const { engines, candidates } = externalSetFrom(assessment, { registry: REGISTRY, openai: ["vllm=http://h:8000/v1#m"] });
  assert.deepEqual(Object.keys(engines).sort(), ["llama-server:cpu", "llama-server:vulkan", "openai:vllm"], "a variant that did not measure, and a server nobody attached, are not offered");
  assert.deepEqual(candidates, [
    { engine: "llama-server:cpu", gpuBackend: "cpu", gpuLayers: 0 },
    { engine: "llama-server:vulkan", gpuBackend: "vulkan", gpuLayers: "max" },
    { engine: "openai:vllm", gpuBackend: "cpu", gpuLayers: 0 },
  ]);
});
