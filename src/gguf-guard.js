import fs from "node:fs";

import { AppError } from "./errors.js";
import { estimateLoad, FIT_LIMIT_RATIO, fitVerdict } from "./memory-fit.js";

/**
 * Walks a GGUF header with every count and length bounded by the file size
 * before node-llama-cpp or llama.cpp parse it. Their readers trust the header:
 * a 100-byte file claiming 2^62 tensors exhausts the heap and one claiming 2^62
 * metadata entries never returns, so a planted file could crash every scan.
 */

const SUPPORTED_VERSIONS = new Set([2, 3]);
const STRING = 8;
const ARRAY = 9;
const SCALAR_BYTES = new Map([
  [0, 1], [1, 1], [2, 2], [3, 2], [4, 4], [5, 4], [6, 4], [7, 1], [10, 8], [11, 8], [12, 8],
]);
const MAX_ARRAY_DEPTH = 1;
const MAX_TENSOR_DIMS = 4; // GGML_MAX_DIMS
const MIN_KV_BYTES = 8n + 4n + 1n; // key length, value type, smallest value
const MIN_TENSOR_BYTES = 8n + 4n + 8n + 4n + 8n; // name length, dims, one dim, type, offset
const MIN_ARRAY_BYTES = 4n + 8n; // element type, count
const CHUNK_BYTES = 1 << 20;

function reject(why) {
  return new AppError("This GGUF file was blocked", {
    code: "gguf_header_rejected",
    status: 422,
    why,
    fix: "Delete the file and download the model again from a source you trust.",
  });
}

class BoundedReader {
  #handle;
  #size;
  #buffer = Buffer.alloc(0);
  #bufferStart = 0;
  position = 0;

  constructor(handle, size) {
    this.#handle = handle;
    this.#size = size;
  }

  get remaining() {
    return BigInt(this.#size - this.position);
  }

  async #need(bytes, what) {
    if (this.position + bytes > this.#size) throw reject(`The header ends inside ${what}.`);
    const end = this.#bufferStart + this.#buffer.length;
    if (this.position >= this.#bufferStart && this.position + bytes <= end) return;
    const length = Math.min(Math.max(bytes, CHUNK_BYTES), this.#size - this.position);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await this.#handle.read(buffer, 0, length, this.position);
    this.#buffer = buffer.subarray(0, bytesRead);
    this.#bufferStart = this.position;
    if (bytesRead < bytes) throw reject(`The header ends inside ${what}.`);
  }

  async u32(what) {
    await this.#need(4, what);
    const value = this.#buffer.readUInt32LE(this.position - this.#bufferStart);
    this.position += 4;
    return value;
  }

  async u64(what) {
    await this.#need(8, what);
    const value = this.#buffer.readBigUInt64LE(this.position - this.#bufferStart);
    this.position += 8;
    return value;
  }

  /** Skips `bytes` (a BigInt) only when they lie inside the file. */
  skip(bytes, what) {
    if (bytes > this.remaining) throw reject(`${what} claims ${bytes} bytes but the file has ${this.remaining} left.`);
    this.position += Number(bytes);
  }

  /** Refuses `count` items when even their smallest encoding cannot fit. */
  bound(count, minBytes, what) {
    if (count * minBytes > this.remaining) {
      throw reject(`The header claims ${count} ${what}, more than the file could hold.`);
    }
  }
}

async function skipString(reader, what) {
  reader.skip(await reader.u64(`the length of ${what}`), what);
}

async function skipValue(reader, type, depth, key) {
  const scalar = SCALAR_BYTES.get(type);
  if (scalar !== undefined) return reader.skip(BigInt(scalar), `the value of ${key}`);
  if (type === STRING) return skipString(reader, `the value of ${key}`);
  if (type !== ARRAY) throw reject(`Metadata key ${key} has unknown value type ${type}.`);
  if (depth >= MAX_ARRAY_DEPTH) throw reject(`Metadata key ${key} nests arrays inside arrays.`);

  const elementType = await reader.u32(`the array type of ${key}`);
  const count = await reader.u64(`the array length of ${key}`);
  const elementBytes = SCALAR_BYTES.get(elementType);
  if (elementBytes !== undefined) return reader.skip(count * BigInt(elementBytes), `the array ${key}`);
  if (elementType === STRING) {
    reader.bound(count, 8n, `strings in ${key}`);
    for (let index = 0n; index < count; index += 1n) await skipString(reader, `a string in ${key}`);
    return undefined;
  }
  reader.bound(count, MIN_ARRAY_BYTES, `elements in ${key}`);
  for (let index = 0n; index < count; index += 1n) await skipValue(reader, elementType, depth + 1, key);
  return undefined;
}

export async function inspectGgufHeader(file) {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const reader = new BoundedReader(handle, size);
    const magic = await reader.u32("the signature");
    if (magic !== 0x46554747) throw reject("The file does not begin with the GGUF signature.");
    const version = await reader.u32("the version");
    if (!SUPPORTED_VERSIONS.has(version)) throw reject(`GGUF version ${version} is not supported; ModelDuck reads versions 2 and 3.`);

    const tensorCount = await reader.u64("the tensor count");
    const kvCount = await reader.u64("the metadata count");
    reader.bound(kvCount, MIN_KV_BYTES, "metadata entries");
    reader.bound(tensorCount, MIN_TENSOR_BYTES, "tensors");

    for (let index = 0n; index < kvCount; index += 1n) {
      const key = `entry ${index}`;
      await skipString(reader, `metadata key ${index}`);
      await skipValue(reader, await reader.u32(`the value type of ${key}`), 0, key);
    }
    reader.bound(tensorCount, MIN_TENSOR_BYTES, "tensors");
    for (let index = 0n; index < tensorCount; index += 1n) {
      await skipString(reader, `the name of tensor ${index}`);
      const dims = await reader.u32(`the dimensions of tensor ${index}`);
      if (dims < 1 || dims > MAX_TENSOR_DIMS) throw reject(`Tensor ${index} claims ${dims} dimensions; GGUF allows 1 to ${MAX_TENSOR_DIMS}.`);
      reader.skip(BigInt(dims) * 8n + 4n, `the shape of tensor ${index}`);
      const offset = await reader.u64(`the offset of tensor ${index}`);
      if (offset >= BigInt(size)) throw reject(`Tensor ${index} points past the end of the file.`);
    }
    return { version, tensorCount: Number(tensorCount), kvCount: Number(kvCount) };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * IDEA-1637: pre-download fit glue. Links the bounded header walk above to
 * the memory-fit estimator, so a download that cannot fit is refused before
 * any byte is fetched, with an actionable remedy instead of a mid-load swap.
 * `shape` is null when the KV shape is unknown (pre-download): the verdict
 * is then weights + runtime reserve only, which still refuses the hopeless.
 */
export function checkDownloadFit({ modelBytes, shape = null, contextSize = 2048, kvCache = "f16", availableBytes = null } = {}) {
  const estimate = estimateLoad({ modelBytes, shape, contextSize, kvCache });
  const verdict = fitVerdict({ estimate, availableBytes, shape, modelBytes });
  // Pre-download the KV shape is unknown (verdict "unknown"): weights plus the
  // runtime reserve alone still refuse the hopeless (e.g. a 16 GiB file with
  // 1 GiB free), using the same 75 % wall as the load path.
  const unknownDoomed = verdict.verdict === "unknown" &&
    Number.isFinite(availableBytes) && availableBytes > 0 &&
    estimate.total > availableBytes * FIT_LIMIT_RATIO;
  if (verdict.verdict === "will_not_fit" || unknownDoomed) {
    const gib = (bytes) => `${(Number(bytes) / 1024 ** 3).toFixed(1)} GiB`;
    throw new AppError("This model will not fit in memory", {
      code: "download_would_not_fit",
      status: 507,
      why: `It needs about ${gib(estimate.total)} at ${estimate.contextSize} tokens, but only ${gib(availableBytes)} is free; downloading it would waste time before the load refuses it.`,
      fix: "Pick a smaller model or quantization, lower Context size to 2048 with the q8_0 KV cache, or close other programs and try again.",
    });
  }
  return { estimate, verdict };
}

/**
 * IDEA-1637: header + fit preflight for a GGUF file on disk. Validates the
 * header first (a hostile file is still blocked), then estimates the load
 * from the file's own byte size. Used after a download to confirm the file
 * before promotion, and in tests with a small fake header.
 */
export async function preflightGgufFile(file, { contextSize = 2048, kvCache = "f16", availableBytes = null, shape = null } = {}) {
  const header = await inspectGgufHeader(file);
  const { size } = await fs.promises.stat(file);
  const { estimate, verdict } = checkDownloadFit({
    modelBytes: size,
    shape,
    contextSize,
    kvCache,
    availableBytes,
  });
  return { header, estimate, verdict, size };
}
