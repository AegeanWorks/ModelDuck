import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT } from "./config.js";

/**
 * A stdio MCP server (Model Context Protocol) with one tool, `verified_code`
 * (ADR-126). It forwards to the running app's loopback `POST /api/code/verify`
 * (ADR-106), so coding agents get test-checked code from the local model: the
 * one coding lever ModelDuck measured (60.4% to 73.1% in four tries on Qwen2.5
 * Coder 1.5B). Validation, the sandbox, the tuned code preset and engine
 * locking all stay in the app; this process only translates.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin and stdout. Logs go to
 * stderr, because stdout carries only protocol messages.
 */

const SUPPORTED_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
// The verify route stops itself after 5 minutes and returns its best try, so
// the client waits a little longer to receive that answer instead of cutting it off.
const DEFAULT_TIMEOUT_MS = 6 * 60_000;
const SERVER_INFO = Object.freeze({ name: "modelduck", version: "0.1.0" });

const VERIFIED_CODE_TOOL = Object.freeze({
  name: "verified_code",
  title: "Verified code from the local model",
  description:
    "Ask the model loaded in ModelDuck for a JavaScript function, run your test cases on each answer in a sandbox, " +
    "and retry until an answer passes. Returns the first passing code, or the answer that passed the most cases. " +
    "Use it when you can state the function's name and a few input/output examples.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the function must do. Name the function the same as tests.entry." },
      tests: {
        type: "object",
        properties: {
          entry: { type: "string", description: "The function to call, for example \"parseCsv\"." },
          cases: {
            type: "array",
            description: "1 to 50 cases. Each calls entry(...args) and compares the result with expect (deep equality).",
            items: {
              type: "object",
              properties: { args: { type: "array" }, expect: {} },
              required: ["args", "expect"],
            },
          },
          setup: { type: "string", description: "Optional code run before the answer, such as helper definitions." },
        },
        required: ["entry", "cases"],
      },
      attempts: { type: "integer", minimum: 1, maximum: 8, description: "Answers to try, default 4." },
      retry_temperature: { type: "number", exclusiveMinimum: 0, maximum: 2, description: "Temperature of the retries, default 0.7." },
      max_tokens: { type: "integer", minimum: 16, maximum: 8192, description: "Answer length cap per try." },
    },
    required: ["prompt", "tests"],
  },
});

const FORWARDED = ["prompt", "tests", "attempts", "retry_temperature", "max_tokens"];

const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolText = (text, { isError = false, structured = null } = {}) => ({
  content: [{ type: "text", text }],
  ...(structured && { structuredContent: structured }),
  isError,
});

function summarize(body) {
  const tests = Array.isArray(body.tests) ? body.tests : [];
  const passed = tests.filter((item) => item?.passed).length;
  const tries = Array.isArray(body.attempts) ? body.attempts.length : body.attempt ?? 0;
  const lines = [body.passed
    ? `Passed ${passed} of ${tests.length} tests on try ${body.attempt} of ${tries}.`
    : `No answer passed every test in ${tries} tries; the best passed ${passed} of ${tests.length}.`];
  if (body.stopped) lines.push(`Stopped early: ${body.stopped}.`);
  for (const item of tests.filter((entry) => !entry?.passed).slice(0, 5)) {
    if (item?.detail) lines.push(`Failed: ${item.detail}`);
  }
  if (body.code) lines.push("", "```javascript", body.code, "```");
  return lines.join("\n");
}

function invalidArguments(args) {
  if (!args || typeof args !== "object") return "arguments must be an object.";
  if (typeof args.prompt !== "string" || !args.prompt.trim()) return "prompt must be a non-empty string.";
  if (!args.tests || typeof args.tests !== "object") return "tests must be an object with entry and cases.";
  return null;
}

/** The protocol logic, without a transport: `handle(message)` resolves to the reply, or null for a notification. */
export function createMcpServer({ fetch = globalThis.fetch, baseUrl = `http://127.0.0.1:${DEFAULT_PORT}`, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function verifiedCode(args) {
    const body = Object.fromEntries(FORWARDED.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    let response;
    try {
      response = await fetch(`${baseUrl}/api/code/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.cause?.code === "ECONNREFUSED") {
        return toolText(`ModelDuck is not running at ${baseUrl}. Why: verified_code asks the model loaded in the running app. ` +
          "Fix: Start it with npm start in the ModelDuck folder, load a model, then call the tool again.", { isError: true });
      }
      if (error?.name === "TimeoutError") {
        return toolText(`ModelDuck did not answer within ${Math.round(timeoutMs / 1000)} s. Fix: ask for fewer attempts or a shorter max_tokens.`, { isError: true });
      }
      return toolText(`Could not reach ModelDuck at ${baseUrl}: ${error?.message ?? error}.`, { isError: true });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A non-JSON reply is reported by status below.
    }
    if (!response.ok) {
      const problem = payload?.error;
      const text = problem
        ? `${problem.message} (${problem.code}). Why: ${problem.why} Fix: ${problem.fix}`
        : `ModelDuck answered HTTP ${response.status}.`;
      return toolText(text, { isError: true });
    }
    return toolText(summarize(payload ?? {}), { structured: payload ?? {} });
  }

  async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return failure(message?.id ?? null, -32600, "Invalid request: send one JSON-RPC 2.0 object with a method.");
    }
    const { id, method, params = {} } = message;
    // A notification (no id) never gets a reply, whatever its method.
    if (id === undefined) return null;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: "verified_code needs the ModelDuck app running on this computer with a model loaded.",
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: [VERIFIED_CODE_TOOL] });
    if (method === "tools/call") {
      if (params?.name !== VERIFIED_CODE_TOOL.name) return failure(id, -32602, `Unknown tool: ${params?.name}. The only tool is verified_code.`);
      const problem = invalidArguments(params.arguments);
      if (problem) return failure(id, -32602, `Invalid arguments for verified_code: ${problem}`);
      return reply(id, await verifiedCode(params.arguments));
    }
    return failure(id, -32601, `Method not found: ${method}.`);
  }

  return { handle };
}

/**
 * Newline-delimited JSON-RPC over two streams. Requests are answered in the
 * order they arrive, one at a time: the app runs one verify at a time anyway.
 * Resolves when the input ends and every reply is written.
 */
export async function serveStdio({ input = process.stdin, output = process.stdout, server = createMcpServer() } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(failure(null, -32700, "Parse error: each line must be one JSON object."));
      continue;
    }
    const answer = await server.handle(message).catch((error) => failure(message?.id ?? null, -32603, `Internal error: ${error?.message ?? error}`));
    if (answer) write(answer);
  }
}

function parseCli(argv) {
  let port = DEFAULT_PORT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") {
      port = Number(argv[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        process.stderr.write("Invalid --port.\nWhy: it must be the port ModelDuck listens on, a whole number from 1 to 65535.\nFix: omit it for the default 4141, or pass the port shown when ModelDuck starts.\n");
        process.exit(2);
      }
    } else if (argv[index] === "--help" || argv[index] === "-h") {
      process.stdout.write("Usage: npm run mcp [-- --port <port>]\nA stdio MCP server with one tool, verified_code, that forwards to ModelDuck on 127.0.0.1.\n");
      process.exit(0);
    } else {
      process.stderr.write(`Unknown option ${argv[index]}.\nFix: use --port <port> or --help.\n`);
      process.exit(2);
    }
  }
  return { port };
}

// A CLI, not a library: importing this module must not take over stdin.
const invokedDirectly = (() => {
  try {
    return process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const { port } = parseCli(process.argv.slice(2));
  serveStdio({ server: createMcpServer({ baseUrl: `http://127.0.0.1:${port}` }) }).catch((error) => {
    process.stderr.write(`ModelDuck MCP server stopped: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
