import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createMcpServer, serveStdio } from "../src/mcp-server.js";

const TESTS = { entry: "add", cases: [{ args: [1, 2], expect: 3 }] };

/** A fetch stand-in that records the request and answers with `reply`. */
function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { fetch, calls };
}

const call = (server, method, params, id = 1) => server.handle({ jsonrpc: "2.0", id, method, ...(params && { params }) });

test("initialize answers with the tools capability and the client's protocol version when supported", async () => {
  const server = createMcpServer({ fetch: fakeFetch({ status: 200, body: {} }).fetch });
  const reply = await call(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kiro", version: "1" } });
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, "2025-06-18");
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result.serverInfo.name, "modelduck");
  const old = await call(server, "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(old.result.protocolVersion, "2025-06-18", "an unknown version gets the newest supported one");
});

test("notifications get no reply, ping gets an empty result, unknown methods get -32601", async () => {
  const server = createMcpServer({ fetch: fakeFetch({ status: 200, body: {} }).fetch });
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await call(server, "ping")).result, {});
  assert.equal((await call(server, "resources/list")).error.code, -32601);
});

test("tools/list offers verified_code with a schema that requires a prompt and tests", async () => {
  const server = createMcpServer({ fetch: fakeFetch({ status: 200, body: {} }).fetch });
  const { tools } = (await call(server, "tools/list")).result;
  assert.deepEqual(tools.map((tool) => tool.name), ["verified_code"]);
  assert.deepEqual(tools[0].inputSchema.required, ["prompt", "tests"]);
  assert.deepEqual(tools[0].inputSchema.properties.tests.required, ["entry", "cases"]);
});

test("verified_code forwards to the loopback verify route and returns the passing code", async () => {
  const { fetch, calls } = fakeFetch({ status: 200, body: { model: "coder", passed: true, attempt: 2, code: "function add(a, b) { return a + b; }", tests: [{ passed: true }], attempts: [{}, {}] } });
  const server = createMcpServer({ fetch, baseUrl: "http://127.0.0.1:4141" });
  const reply = await call(server, "tools/call", { name: "verified_code", arguments: { prompt: "Write add(a, b).", tests: TESTS, attempts: 3 } });
  assert.equal(calls[0].url, "http://127.0.0.1:4141/api/code/verify");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].body, { prompt: "Write add(a, b).", tests: TESTS, attempts: 3 });
  const result = reply.result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.passed, true);
  assert.equal(result.structuredContent.attempt, 2);
  assert.match(result.content[0].text, /Passed 1 of 1 tests on try 2 of 2/);
  assert.match(result.content[0].text, /function add/);
});

test("a failing answer is a result, not a tool error, and says how many tests passed", async () => {
  const { fetch } = fakeFetch({ status: 200, body: { passed: false, attempt: 1, code: "x", tests: [{ passed: true }, { passed: false, detail: "expected 3" }], attempts: [{}, {}, {}, {}] } });
  const result = (await call(createMcpServer({ fetch }), "tools/call", { name: "verified_code", arguments: { prompt: "p", tests: TESTS } })).result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.passed, false);
  assert.match(result.content[0].text, /No answer passed every test in 4 tries; the best passed 1 of 2/);
  assert.match(result.content[0].text, /expected 3/);
});

test("a server error passes its message, Why and Fix to the agent", async () => {
  const { fetch } = fakeFetch({ status: 409, body: { error: { code: "model_not_loaded", message: "No model is loaded", why: "It needs a model.", fix: "Load one." } } });
  const result = (await call(createMcpServer({ fetch }), "tools/call", { name: "verified_code", arguments: { prompt: "p", tests: TESTS } })).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No model is loaded \(model_not_loaded\)\. Why: It needs a model\. Fix: Load one\./);
});

test("an app that is not running gives a Fix to start it", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const result = (await call(createMcpServer({ fetch: fakeFetch(refused).fetch, baseUrl: "http://127.0.0.1:4141" }), "tools/call", { name: "verified_code", arguments: { prompt: "p", tests: TESTS } })).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ModelDuck is not running at http:\/\/127\.0\.0\.1:4141/);
  assert.match(result.content[0].text, /Fix: Start it with npm start/);
});

test("bad calls are protocol errors: unknown tool and missing arguments", async () => {
  const server = createMcpServer({ fetch: fakeFetch({ status: 200, body: {} }).fetch });
  assert.equal((await call(server, "tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  assert.equal((await call(server, "tools/call", { name: "verified_code", arguments: { prompt: "p" } })).error.code, -32602);
});

test("the stdio transport reads one JSON message per line and writes one reply per request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createMcpServer({ fetch: fakeFetch({ status: 200, body: {} }).fetch });
  const done = serveStdio({ input, output, server });
  const lines = [];
  output.on("data", (chunk) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("not json\n");
  input.end();
  await done;
  const replies = lines.map((line) => JSON.parse(line));
  assert.equal(replies.length, 2, "the notification gets no reply");
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[1].id, null);
});

test("npm run mcp speaks MCP on stdin and stdout and logs nothing to stdout", { timeout: 5000 }, async (t) => {
  const entry = fileURLToPath(new URL("../src/mcp-server.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "--port", "1"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  const exited = new Promise((resolve) => child.on("close", resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.end();
  assert.equal(await exited, 0, "the server exits cleanly when its input ends");
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((message) => message.id), [1, 2]);
  assert.equal(replies[1].result.tools[0].name, "verified_code");
});
