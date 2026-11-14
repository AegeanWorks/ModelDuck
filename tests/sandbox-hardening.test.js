import assert from "node:assert/strict";
import test from "node:test";

import { networkDenied, sandboxEnv, sandboxFlag } from "../benchmarks/sandbox.mjs";
import { resetJavaScriptTestCache, runJavaScriptTests } from "../benchmarks/suite.mjs";

const CHECK = { type: "jsTests", entry: "double", cases: [{ args: [1], expect: 2 }, { args: [5], expect: 10 }] };
const fence = (code) => `\`\`\`js\n${code}\n\`\`\``;
const passedOf = async (code, check = CHECK) => {
  resetJavaScriptTestCache();
  return (await runJavaScriptTests(fence(code), check)).filter((result) => result.passed).length;
};

// --- the permission flag and what it can deny, by Node version -----------------------

test("the sandbox flag follows the Node version that knows it", () => {
  assert.equal(sandboxFlag("20.18.1"), "--experimental-permission");
  assert.equal(sandboxFlag("22.12.0"), "--experimental-permission");
  assert.equal(sandboxFlag("22.13.0"), "--permission");
  assert.equal(sandboxFlag("23.4.0"), "--experimental-permission");
  assert.equal(sandboxFlag("23.5.0"), "--permission");
  assert.equal(sandboxFlag("26.9.0"), "--permission");
});

test("network access is denied only from Node 25", () => {
  assert.equal(networkDenied("24.11.0"), false);
  assert.equal(networkDenied("25.0.0"), true);
  assert.equal(networkDenied("26.9.0"), true);
});

test("the child gets no token, user name or path; Windows' required variables are neutral", () => {
  const env = sandboxEnv({ PATH: "C:\\bin", HF_TOKEN: "secret", USERNAME: "me", USERPROFILE: "C:\\Users\\me", SystemRoot: "C:\\Windows" }, "win32");
  assert.equal(env.HF_TOKEN, undefined);
  assert.equal(env.USERNAME, "sandbox");
  assert.equal(env.PATH, "sandbox");
  assert.equal(env.USERPROFILE, "sandbox");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.ok(!Object.values(env).some((value) => value.includes("me")), "nothing of the user's survives");
  assert.deepEqual(sandboxEnv({ PATH: "x", HOME: "/home/me" }, "linux"), {});
});

// --- an answer cannot forge its own result ----------------------------------------------

test("an honest answer still scores as before", async () => {
  assert.equal(await passedOf("function double(n) { return n * 2; }"), 2);
  assert.equal(await passedOf("function double(n) { return n + 2; }"), 0);
  assert.equal(await passedOf("const double = (n) => n * 2;\nmodule.exports = { double };"), 2, "module.exports still works");
});

test("printing a fake result marker and exiting does not pass", async () => {
  const forged = 'function double() { return 0; }\nprocess.stdout.write("\\n__MODELDUCK_TEST_RESULTS__" + JSON.stringify([{ ok: true, detail: "ok" }, { ok: true, detail: "ok" }]));\nprocess.exit(0);';
  assert.equal(await passedOf(forged), 0);
});

test("rewriting the harness output on its way out does not pass", async () => {
  const forged = [
    "function double() { return 0; }",
    "const write = process.stdout.write.bind(process.stdout);",
    'process.stdout.write = (text, ...rest) => write(String(text).replace(/\\[\\{.*\\}\\]/, JSON.stringify([{ ok: true, detail: "ok" }, { ok: true, detail: "ok" }])), ...rest);',
  ].join("\n");
  assert.equal(await passedOf(forged), 0);
});

test("polluting toJSON so every value serializes alike does not pass", async () => {
  // JSON.stringify consults toJSON on objects and arrays, so an array expectation is the target.
  const check = { type: "jsTests", entry: "pair", cases: [{ args: [1], expect: [1, 2] }, { args: [3], expect: [3, 4] }] };
  // Only number arrays collapse, so the harness's own result line still serializes.
  const forged = 'Array.prototype.toJSON = function () { return typeof this[0] === "number" ? "same" : this; };\nfunction pair() { return [0]; }';
  assert.equal(await passedOf(forged, check), 0);
});

test("an answer cannot reach the harness through its caller", async () => {
  const check = { type: "jsTests", entry: "peek", cases: [{ args: [], expect: true }] };
  assert.equal(await passedOf("function peek() { return peek.caller === null; }", check), 1);
});

test("the child sees no real user name, profile path or token", async () => {
  const check = { type: "jsTests", entry: "leak", cases: [{ args: [], expect: false }] };
  const real = [process.env.USERNAME, process.env.USERPROFILE, process.env.HOME, process.env.PATH].filter((value) => value && value.length > 3);
  const code = `function leak() { const seen = Object.values(process.env).join("|"); return ${JSON.stringify(real)}.some((value) => seen.includes(value)) || "HF_TOKEN" in process.env; }`;
  assert.equal(await passedOf(code, check), 1);
});

test("a function name with $ is found and its result counts", async () => {
  resetJavaScriptTestCache();
  const [result] = await runJavaScriptTests(fence("function a$(n) { return n * 2; }"), { type: "jsTests", entry: "a$", cases: [{ args: [2], expect: 4 }] });
  assert.equal(result.passed, true);
  assert.equal(result.unreadable, false);
});

// --- review of the first hardening: the judge shares a process with the answer -----------
// An answer runs in the same process as the code that judged it, so it can read the
// script (process._eval) and the per-run id in it. These attacks all worked.

test("reading the judge's own script and writing a result line on exit does not pass", async () => {
  const forged = [
    "function double() { return 0; }",
    "const id = /__MODELDUCK_([0-9a-f]{24})__/.exec(String(process._eval))?.[1] ?? /__[a-z]+_([0-9a-f]{24})/.exec(String(process._eval))?.[1];",
    // A well-formed line in the judge's own [kind, text] shape, with its end marker, printed last so it
    // is the one the parent reads. It can only say what the function "returned".
    'process.on("exit", () => { const m = "__MODELDUCK_" + id + "__"; require("fs").writeSync(1, "\\n" + m + \'[["v","0"],["v","0"]]\' + m); });',
  ].join("\n");
  assert.equal(await passedOf(forged), 0, "forged results that are not the expected values do not pass");
});

// --- review findings from reforge run-1: how a result leaves the child ---------------------

test("a correct answer that prints on exit still scores", async () => {
  const code = 'function double(n) { return n * 2; }\nprocess.on("exit", () => console.log("bye"));';
  assert.equal(await passedOf(code), 2, "output after the result line must not break parsing");
});

test("correct results larger than the default output limit still pass", async () => {
  const size = 600 * 1024;
  const check = { type: "jsTests", entry: "big", cases: [{ args: [], expect: "x".repeat(size) }, { args: [], expect: "y".repeat(size) }] };
  const code = `function big() { big.calls = (big.calls ?? 0) + 1; return (big.calls === 1 ? "x" : "y").repeat(${size}); }`;
  assert.equal(await passedOf(code, check), 2, "1.2 MB of correct output in all");
});

test("a wrong answer that prints far more than the limit is reported as too large, not as a crash", async () => {
  resetJavaScriptTestCache();
  const check = { type: "jsTests", entry: "flood", cases: [{ args: [], expect: 1 }] };
  const [result] = await runJavaScriptTests(fence('function flood() { return "z".repeat(3 * 1024 * 1024); }'), check);
  assert.equal(result.passed, false);
  assert.match(result.detail, /output too large/);
});

test("the expected values never reach the child, so no answer can read them", async () => {
  const check = { type: "jsTests", entry: "secret", cases: [{ args: [], expect: "ZEBRA-4417-EXPECTED" }] };
  // Built at run time: the answer's own text must not contain the whole value, or it would find itself.
  const code = 'function secret() { return String(process._eval).includes("ZEBRA-" + "4417-EXPECTED") ? "leaked" : "clean"; }';
  resetJavaScriptTestCache();
  const [result] = await runJavaScriptTests(fence(code), check);
  assert.equal(result.passed, false);
  assert.match(result.detail, /clean/, "the child's script holds no expected value");
});

test("a hardcoded answer to a known test is the only way to pass it, and still needs the right value", async () => {
  // Overfitting to visible cases is not forgery; the judge compares what the function returns.
  assert.equal(await passedOf("function double(n) { return n === 1 ? 2 : n === 5 ? 10 : 0; }"), 2);
  assert.equal(await passedOf("function double(n) { return n === 1 ? 2 : 0; }"), 1);
});

test("an answer cannot signal another process", async () => {
  const check = { type: "jsTests", entry: "signal", cases: [{ args: [], expect: "blocked" }] };
  const code = [
    "function signal() {",
    "  const kill = process.kill ?? process._kill;",
    '  if (typeof kill !== "function") return "blocked";',
    '  try { kill(process.ppid, 0); return "reached"; } catch { return "blocked"; }',
    "}",
  ].join("\n");
  assert.equal(await passedOf(code, check), 1, "the parent is out of reach");
});

test("the child does not report the real user, host or working directory", async () => {
  const os = await import("node:os");
  const real = [os.userInfo().username, os.hostname(), process.cwd()].filter((value) => value && value.length > 3);
  const check = { type: "jsTests", entry: "who", cases: [{ args: [], expect: false }] };
  const code = `function who() { const os = require("os"); const seen = [os.userInfo().username, os.hostname(), process.cwd()].join("|"); return ${JSON.stringify(real)}.some((value) => seen.includes(value)); }`;
  assert.equal(await passedOf(code, check), 1);
});

test("a function that returns undefined, throws, or cannot be serialized fails with a reason, as before", async () => {
  resetJavaScriptTestCache();
  const check = { type: "jsTests", entry: "f", cases: [{ args: [0], expect: 1 }, { args: [1], expect: 1 }, { args: [2], expect: 1 }] };
  const code = "function f(n) { if (n === 0) return undefined; if (n === 1) throw new Error('boom'); const loop = {}; loop.self = loop; return loop; }";
  const results = await runJavaScriptTests(fence(code), check);
  assert.deepEqual(results.map((result) => result.passed), [false, false, false]);
  assert.match(results[0].detail, /got undefined/);
  assert.match(results[1].detail, /threw boom/);
  assert.match(results[2].detail, /threw/);
});

test("a result that is a string, object or array is compared by its JSON text, as before", async () => {
  const check = { type: "jsTests", entry: "shape", cases: [{ args: [], expect: { a: [1, "x"], b: null } }, { args: [], expect: "text" }] };
  resetJavaScriptTestCache();
  const results = await runJavaScriptTests(fence('function shape() { return shape.calls = (shape.calls ?? 0) + 1, shape.calls === 1 ? { a: [1, "x"], b: null } : "text"; }'), check);
  assert.deepEqual(results.map((result) => result.passed), [true, true]);
});
