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
