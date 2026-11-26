/**
 * A deliberately narrow pure-expression judge.
 *
 * The sandbox remains the authority for every answer except one required
 * function whose body is a single return expression. The expression is
 * tokenized and checked against small whitelists before `new Function` is
 * called; no property lookup, call or string form outside those whitelists is
 * allowed. Returns null for anything else so the caller uses the sandbox.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*/y;
const NUMBER = /^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y;
const OPERATOR = /^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|\*\*|<<|>>>|>>|[+\-*/%<>&|^~!?:.()])/y;
const SIMPLE_PARAMETER = /^[A-Za-z_$][\w$]*$/;
const JUDGE_BINDING = /^__(?:emit|s|a|call)_[\da-f]{24}$/;
const SIGNATURE = /^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{\s*return\s+([^{};]+);\s*\}\s*$/;

const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
const GLOBAL_CALLS = new Set(["Number", "String", "Boolean", "parseInt", "parseFloat"]);
// These are pure on the JSON-only arguments the judge supplies. Methods that
// take callbacks or build unbounded values are intentionally absent.
const MATH_METHODS = new Set([
  "abs", "ceil", "floor", "round", "sign", "sqrt", "cbrt", "min", "max", "pow", "trunc",
  "fround", "log", "log2", "log10", "log1p", "exp", "expm1", "hypot", "imul", "clz32",
  "atan2", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
]);
const MATH_CONSTANTS = new Set(["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"]);
const METHODS = new Set([
  "split", "join", "reverse", "slice", "includes", "indexOf", "charAt", "charCodeAt",
  "substring", "substr", "replace", "trim", "toLowerCase", "toUpperCase", "sort", "concat",
  "at", "startsWith", "endsWith", "toString",
]);
const PROPERTIES = new Set(["length"]);

function tokenize(expression) {
  const tokens = [];
  let at = 0;
  while (at < expression.length) {
    const rest = expression.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      // Quotes without escapes keep the literal's runtime value unambiguous.
      const end = rest.indexOf(rest[0], 1);
      if (end < 1 || rest.slice(1, end).includes("\\")) return null;
      tokens.push({ type: "string", value: rest.slice(1, end) });
      at += end + 1;
      continue;
    }
    IDENTIFIER.lastIndex = 0;
    const identifier = IDENTIFIER.exec(rest);
    if (identifier) {
      tokens.push({ type: "id", value: identifier[0] });
      at += identifier[0].length;
      continue;
    }
    NUMBER.lastIndex = 0;
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      at += number[0].length;
      continue;
    }
    OPERATOR.lastIndex = 0;
    const operator = OPERATOR.exec(rest);
    if (!operator) return null;
    tokens.push({ type: "op", value: operator[0] });
    at += operator[0].length;
  }
  return tokens;
}

function validate(tokens, parameters) {
  const names = new Set([
    ...parameters, ...LITERALS, ...GLOBAL_CALLS, "Math",
    ...MATH_METHODS, ...MATH_CONSTANTS, ...METHODS, ...PROPERTIES,
  ]);
  const calls = [];
  const allowedCalls = new Set();
  let memberAllowed = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "id") {
      if (!names.has(token.value)) return false;
      const next = tokens[index + 1];
      if (next?.type === "op" && next.value === "(") {
        const callable = GLOBAL_CALLS.has(token.value) || MATH_METHODS.has(token.value) || METHODS.has(token.value);
        if (!callable) return false;
        allowedCalls.add(index + 1);
        memberAllowed = false;
      } else if (token.value === "Math" && next?.type === "op" && next.value === ".") {
        const name = tokens[index + 2];
        if (name?.type !== "id" || (!MATH_METHODS.has(name.value) && !MATH_CONSTANTS.has(name.value))) return false;
        if (MATH_METHODS.has(name.value) && tokens[index + 3]?.value !== "(") return false;
        if (MATH_METHODS.has(name.value)) allowedCalls.add(index + 3);
        memberAllowed = false;
      } else if (next?.type === "op" && next.value === "." && (memberAllowed || parameters.includes(token.value))) {
        const name = tokens[index + 2];
        if (name?.type !== "id" || (!METHODS.has(name.value) && !PROPERTIES.has(name.value))) return false;
        if (METHODS.has(name.value) && tokens[index + 3]?.value !== "(") return false;
        if (METHODS.has(name.value)) allowedCalls.add(index + 3);
        memberAllowed = false;
      } else {
        memberAllowed = false;
      }
    } else if (token.type === "op") {
      if (token.value === "(") calls.push(allowedCalls.has(index));
      else if (token.value === ")") memberAllowed = calls.pop() === true;
      else if (token.value === "=" || token.value === "," || token.value === "[" || token.value === "]") return false;
    }
  }
  return calls.length === 0;
}

/** A compiled function, or null when the answer must use the sandbox. */
export function compilePureExpression(code, entry, cases) {
  if (typeof entry !== "string" || entry === "__os" || JUDGE_BINDING.test(entry)) return null;
  const match = code.match(SIGNATURE);
  if (!match || match[1] !== entry) return null;
  const parameters = match[2].split(",").map((value) => value.trim()).filter(Boolean);
  const expression = match[3];
  if (parameters.length > 8 || expression.length > 1024 || !parameters.every((name) => SIMPLE_PARAMETER.test(name))) return null;
  if (expression.includes("++") || expression.includes("--")) return null;
  if (parameters.some((name) => name === "__os" || JUDGE_BINDING.test(name))) return null;
  if (!Array.isArray(cases) || cases.length > 32) return null;
  let argumentBytes = 0;
  for (const testCase of cases) {
    if (!Array.isArray(testCase.args)) return null;
    let text;
    try { text = JSON.stringify(testCase.args); } catch { return null; }
    if (text === undefined) return null;
    argumentBytes += text.length;
  }
  if (argumentBytes > 65536) return null;
  const tokens = tokenize(expression);
  if (!tokens || !validate(tokens, parameters)) return null;
  try {
    return new Function(...parameters, `return (${expression});`);
  } catch {
    return null;
  }
}

function judgeCase(reported, expect) {
  if (!Array.isArray(reported) || typeof reported[0] !== "string" || typeof reported[1] !== "string") return null;
  const [kind, text] = reported;
  if (kind === "n") return { passed: false, detail: "function not found" };
  if (kind === "u") return { passed: false, detail: "got undefined" };
  if (kind === "t") return { passed: false, detail: `threw ${text}` };
  if (kind !== "v") return null;
  const wanted = JSON.stringify(expect);
  const passed = wanted !== undefined && text === wanted;
  return { passed, detail: passed ? "ok" : `got ${text}` };
}

/**
 * The same check rows the sandbox judge builds. `limitBytes` is the caller's
 * output cap; when a result could cross it, null sends the answer back to the
 * sandbox so it reports "output too large" exactly as before.
 */
export function pureExpressionVerdicts(check, fn, limitBytes) {
  const cases = check.cases ?? [];
  const checked = [];
  let outputBytes = 0;
  for (const testCase of cases) {
    let reported;
    try {
      // The child parses stringified JSON arguments, so clone them the same way.
      const args = JSON.parse(JSON.stringify(testCase.args));
      const got = JSON.stringify(fn(...args));
      reported = got === undefined ? ["u", ""] : ["v", got];
      if (got !== undefined) outputBytes += got.length;
    } catch (error) {
      reported = ["t", String(error && error.message)];
    }
    const verdict = judgeCase(reported, testCase.expect);
    checked.push({
      type: "jsTests",
      passed: Boolean(verdict?.passed),
      unreadable: false,
      detail: `${check.entry}(${JSON.stringify(testCase.args).slice(1, -1)}): ${verdict ? verdict.detail : "no results"}`,
    });
  }
  return outputBytes + 1024 <= limitBytes ? checked : null;
}
