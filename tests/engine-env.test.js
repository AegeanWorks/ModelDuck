import assert from "node:assert/strict";
import test from "node:test";

import { cleanPath, locateBinary, parseLlamaVersion } from "../src/engine-env.js";

test("on Windows the Git for Windows usr and mingw folders leave PATH, every other entry stays in order", () => {
  const dirty = [String.raw`C:\Program Files\Git\usr\bin`, String.raw`C:\Windows`, String.raw`C:\Program Files\Git\mingw64\bin`, String.raw`D:\tools`, "C:/Program Files/Git/usr/bin"].join(";");
  assert.equal(cleanPath(dirty, "win32"), String.raw`C:\Windows;D:\tools`);
  const kept = String.raw`C:\Git\cmd;C:\Gitlab\usr`;
  assert.equal(cleanPath(kept, "win32"), kept, "only the usr and mingw folders under a Git folder are removed");
  assert.equal(cleanPath(undefined, "win32"), "");
});

test("on other systems PATH is returned untouched", () => {
  const value = "/usr/bin:/Git/usr/bin";
  assert.equal(cleanPath(value, "linux"), value);
  assert.equal(cleanPath(value, "darwin"), value);
});

test("a llama.cpp version line becomes version and commit, and anything else is null", () => {
  assert.equal(parseLlamaVersion("version: 0.8.0-dev (build 1, commit cd8427d)"), "0.8.0-dev (cd8427d)");
  assert.equal(parseLlamaVersion("version: b6200"), "b6200");
  assert.equal(parseLlamaVersion("no such line"), null);
  assert.equal(parseLlamaVersion(undefined), null);
});

test("the first candidate that exists is used, empty candidates are skipped, none gives null", () => {
  const present = new Set(["/b", "/c"]);
  assert.equal(locateBinary(["", null, "/a", "/b", "/c"], (file) => present.has(file)), "/b");
  assert.equal(locateBinary(["/a"], () => false), null);
  assert.equal(locateBinary([], () => true), null);
});
