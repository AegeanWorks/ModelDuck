import path from "node:path";

import { AppError } from "./errors.js";

/**
 * IDEA-0995: a Hugging Face model reference that resolves to exactly one GGUF
 * file. The resolver is the guardrail: only huggingface.co over https, only
 * plain path segments, only a .gguf file, and one canonical resolve URL. It
 * never fetches anything, so a bad reference costs no network request.
 */

const HOST = "huggingface.co";
const MAX_REFERENCE_CHARS = 2048;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const FOLDER = /^[A-Za-z0-9._-][A-Za-z0-9._ -]{0,127}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,190}\.gguf$/i;
// Hugging Face split GGUFs are named model-00001-of-00002.gguf; one part alone
// cannot load, so it is refused before a multi-GB download (ADR-143).
const SPLIT_PART = /-\d{5}-of-\d{5}\.gguf$/i;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIX = "Paste a link like hf:org/repo/file.gguf, or the file's resolve link from Hugging Face.";

function refuse(message, why, fix = FIX) {
  throw new AppError(message, { code: "invalid_hf_reference", status: 400, why, fix });
}

function decode(segment, what) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return refuse(`The ${what} is not valid URL text`, `"${segment}" is not percent-encoded text this server can read.`);
  }
}

export function resolveHuggingFaceReference(reference) {
  const text = String(reference ?? "").trim();
  if (!text) refuse("A Hugging Face reference is required", "The address is empty.");
  if (text.length > MAX_REFERENCE_CHARS) {
    refuse("The Hugging Face reference is too long", `It has ${text.length} characters; the limit is ${MAX_REFERENCE_CHARS}.`);
  }

  let owner;
  let repo;
  let revision = "main";
  let fileSegments;
  if (text.toLowerCase().startsWith("hf:")) {
    const parts = text.slice(3).split("/");
    if (parts.length < 3) refuse("The hf: reference is incomplete", "It needs an owner, a repository and a .gguf file.");
    owner = parts[0];
    let head = parts[1];
    const at = head.lastIndexOf("@");
    if (at >= 0) {
      revision = head.slice(at + 1);
      head = head.slice(0, at);
    }
    repo = head;
    fileSegments = parts.slice(2);
  } else {
    let url;
    try {
      url = new URL(text);
    } catch {
      return refuse("The address is not a URL", "It does not parse as a web address.");
    }
    if (url.protocol !== "https:") refuse("Only https addresses are accepted", `"${url.protocol}" would send the download in the clear.`);
    const host = url.hostname.toLowerCase();
    if (host !== HOST && host !== `www.${HOST}`) refuse("Only Hugging Face links are accepted", `${url.hostname} is not huggingface.co.`);
    if (url.port || url.username || url.password) refuse("The link carries credentials or a port", "Paste the plain model file link from Hugging Face.");
    if (url.search || url.hash) refuse("The link has a query or a fragment", "Keep only the path to the .gguf file.");
    const parts = url.pathname.split("/").filter(Boolean).map((segment) => decode(segment, "path"));
    if (parts.length < 5) refuse("The Hugging Face link is incomplete", "It needs /owner/repo/resolve/<revision>/<file.gguf>.");
    const [linkOwner, linkRepo, kind, linkRevision, ...rest] = parts;
    if (kind !== "resolve" && kind !== "blob") {
      refuse("The Hugging Face link does not point at a file", `"${kind}" must be "resolve" or "blob".`);
    }
    owner = linkOwner;
    repo = linkRepo;
    revision = linkRevision;
    fileSegments = rest;
  }

  if (!NAME.test(owner) || !NAME.test(repo)) refuse("The repository name is not valid", `"${owner}/${repo}" is not an owner/repo pair.`);
  if (revision.includes("..") || !REVISION.test(revision)) {
    refuse("The revision is not valid", `"${revision}" is not a branch, tag or commit id.`);
  }
  const files = fileSegments.map((segment) => decode(segment, "file path"));
  for (const segment of files) {
    if (segment === "." || segment === ".." || !FOLDER.test(segment)) {
      refuse("The file path is not valid", `"${segment}" is not a plain path segment.`);
    }
  }
  const fileName = files.at(-1);
  if (SPLIT_PART.test(fileName)) {
    refuse(
      "That is one part of a split model",
      `"${fileName}" is a shard, and ModelDuck loads a model from a single .gguf file.`,
      "Open the repository's Files tab and pick a single-file quantization (one .gguf without -00001-of-...), or use ModelDuck's catalog.",
    );
  }
  if (!FILE.test(fileName)) {
    const endsWithGguf = /\.gguf$/i.test(fileName);
    refuse(
      endsWithGguf ? "The file name is not valid" : "The file is not a GGUF model",
      endsWithGguf ? `"${fileName}" is not a plain .gguf file name.` : `"${fileName}" does not end in .gguf.`,
      "Open the repository's Files tab and copy the .gguf file, not the README or a split part.",
    );
  }
  if (path.basename(fileName) !== fileName) refuse("The file name is not valid", `"${fileName}" is not a plain file name.`);

  const encoded = [owner, repo, "resolve", revision, ...files].map((segment) => encodeURIComponent(segment)).join("/");
  // hygiene: allow the one host a user-chosen model may be downloaded from
  const url = `https://${HOST}/${encoded}`;
  return Object.freeze({
    repo: `${owner}/${repo}`,
    revision,
    filePath: files.join("/"),
    fileName,
    name: fileName.replace(/\.gguf$/i, ""),
    url,
  });
}
