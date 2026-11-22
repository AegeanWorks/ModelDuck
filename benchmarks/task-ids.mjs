/**
 * The static task vocabulary, kept separate from `tasks.mjs` so the HTTP
 * server can validate a tune request without loading the whole prompt suite
 * (and its item modules) at startup. `tasks.mjs` re-exports this same array.
 */
export const TASKS = Object.freeze([
  Object.freeze({ id: "code", label: "Code", categories: Object.freeze(["code", "code-long", "code-repo", "bugfix", "bugfix-long", "bugfix-repo", "public-code"]) }),
  Object.freeze({ id: "comprehension", label: "Code comprehension", categories: Object.freeze(["code-comprehension"]) }),
  Object.freeze({ id: "recall", label: "Long context", categories: Object.freeze(["context", "recall"]) }),
]);
