import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");

test("help and version do not load the server, engine and tuner graph", () => {
  for (const module of ["benchmark-runner", "tuned-settings", "tune-scheduler", "downloader",
    "drain", "engine-catalog", "engine-listing", "engine-router", "inference-engines",
    "engine", "jit", "model-registry", "server", "server-settings", "settings"]) {
    assert.doesNotMatch(source, new RegExp(`^import .* ".*/${module}\\.js";`, "m"),
      `${module} must be loaded only when the app starts`);
    assert.match(source, new RegExp(`import\\("./${module}\\.js"\\)`),
      `${module} must still be loaded on the start path`);
  }
});
