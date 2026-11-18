import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/errors.js";
import { resolveHuggingFaceReference } from "../src/hf-reference.js";

// hygiene: allow the one host every fixture below is built from; the resolver never fetches
const HF = "https://huggingface.co";
const PLAIN = HF.replace("https:", "http:");
const WWW = HF.replace("//", "//www.");
const ELSEWHERE = HF.replace("huggingface.co", "example.com");
const SHORT_HOST = HF.replace("huggingface.co", "hf.co");

const refuse = (reference, pattern) =>
  assert.throws(
    () => resolveHuggingFaceReference(reference),
    (error) =>
      error instanceof AppError &&
      error.code === "invalid_hf_reference" &&
      error.status === 400 &&
      pattern.test(`${error.message} ${error.why}`),
  );

test("an hf: reference becomes the canonical resolve URL", () => {
  assert.deepEqual(resolveHuggingFaceReference("hf:org/repo/model.gguf"), {
    repo: "org/repo",
    revision: "main",
    filePath: "model.gguf",
    fileName: "model.gguf",
    name: "model",
    url: `${HF}/org/repo/resolve/main/model.gguf`,
  });
});

test("a pin and a subfolder survive in the resolve URL", () => {
  const parsed = resolveHuggingFaceReference("hf:org/repo@v1.2/folder/model.Q4_K_M.GGUF");
  assert.equal(parsed.revision, "v1.2");
  assert.equal(parsed.filePath, "folder/model.Q4_K_M.GGUF");
  assert.equal(parsed.fileName, "model.Q4_K_M.GGUF");
  assert.equal(parsed.name, "model.Q4_K_M");
  assert.equal(parsed.url, `${HF}/org/repo/resolve/v1.2/folder/model.Q4_K_M.GGUF`);
});

test("a file page or resolve link is accepted and normalized to resolve", () => {
  const expected = {
    repo: "org/repo",
    revision: "main",
    filePath: "model.gguf",
    fileName: "model.gguf",
    name: "model",
    url: `${HF}/org/repo/resolve/main/model.gguf`,
  };
  assert.deepEqual(resolveHuggingFaceReference(`${HF}/org/repo/resolve/main/model.gguf`), expected);
  assert.deepEqual(resolveHuggingFaceReference(`${WWW}/org/repo/blob/main/model.gguf`), expected);
});

test("percent-encoded text is decoded once and the URL re-encoded", () => {
  const parsed = resolveHuggingFaceReference(`${HF}/org/repo/resolve/main/folder/a%20b.gguf`);
  assert.equal(parsed.filePath, "folder/a b.gguf");
  assert.equal(parsed.url, `${HF}/org/repo/resolve/main/folder/a%20b.gguf`);
});

test("anything that is not one plain GGUF on Hugging Face is refused", () => {
  refuse("", /empty/);
  refuse("   ", /empty/);
  refuse("hf:org/repo", /owner, a repository and a \.gguf file/);
  refuse("hf:org/repo/readme.md", /does not end in \.gguf/);
  refuse("hf:org/repo/.gguf", /not a plain/);
  refuse("hf:-org/repo/model.gguf", /not an owner\/repo/);
  refuse("hf:org/-repo/model.gguf", /not an owner\/repo/);
  refuse("hf:org/repo/../model.gguf", /not a plain path segment/);
  refuse("hf:org/repo@../model.gguf", /branch, tag or commit id/);
  refuse(`${PLAIN}/org/repo/resolve/main/model.gguf`, /https/);
  refuse(`${ELSEWHERE}/org/repo/resolve/main/model.gguf`, /not huggingface\.co/);
  refuse(`${SHORT_HOST}/org/repo/resolve/main/model.gguf`, /not huggingface\.co/);
  refuse(HF.replace("huggingface.co", "user:pass@huggingface.co") + "/org/repo/resolve/main/model.gguf", /credentials/);
  refuse(HF.replace("huggingface.co", "huggingface.co:8443") + "/org/repo/resolve/main/model.gguf", /credentials or a port/);
  refuse(`${HF}/org/repo/resolve/main/model.gguf?download=true`, /query or a fragment/);
  refuse(`${HF}/org/repo/download/main/model.gguf`, /does not point at a file/);
  refuse(`${HF}/org/repo/resolve/main/bad%2Fname.gguf`, /not a plain path segment/);
  refuse(`${HF}/org/repo/resolve/main/bad%2e%2e`, /not a plain path segment|does not end in \.gguf/);
  refuse(`hf:org/repo/${"x".repeat(2100)}.gguf`, /too long/);
});
