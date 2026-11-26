/**
 * Lean GGUF header reader for the model scan.
 *
 * node-llama-cpp decodes every string of a model's 150k-entry vocabulary and
 * merge list for each file it reads, which cost about 110 ms per model and a lot
 * of garbage. The scan needs only the scalar metadata, the chat template and the
 * tensor shapes. This reader decodes those and walks over the large arrays by
 * their length prefixes without decoding them.
 *
 * It returns the same `{ metadata, architectureMetadata, tensorInfo }` shape the
 * scan reads from node-llama-cpp, and throws on anything it does not understand
 * (version 1, big-endian, unknown value types, truncation), so the caller can fall
 * back to the library for exactly those files.
 */
import fs from "node:fs/promises";

const CHUNK = 1 << 20;
/** Arrays longer than this are skipped; the scan reads none of them. */
const MAX_KEPT_ARRAY = 256;
const FIXED_SIZE = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
const STRING = 8;
const ARRAY = 9;
const MAX_STRING = 16 * 1024 * 1024;

class HeaderReader {
  #handle;
  #buffer = Buffer.alloc(0);
  #start = 0;
  offset = 0;

  constructor(handle) {
    this.#handle = handle;
  }

  /** Make `length` bytes at the current offset readable and return the buffer position of the first. */
  async window(length) {
    const end = this.#start + this.#buffer.length;
    if (this.offset < this.#start || this.offset + length > end) {
      const wanted = Math.max(length, CHUNK);
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await this.#handle.read(buffer, 0, wanted, this.offset);
      if (bytesRead < length) throw new Error("GGUF header is truncated");
      this.#buffer = buffer.subarray(0, bytesRead);
      this.#start = this.offset;
    }
    return this.offset - this.#start;
  }

  get buffer() {
    return this.#buffer;
  }

  /** Step over `count` length-prefixed strings without decoding them, a buffer at a time. */
  async skipStrings(count) {
    let remaining = count;
    while (remaining > 0) {
      let at = await this.window(8);
      const buffer = this.#buffer;
      const base = this.#start;
      let position = base + at;
      while (remaining > 0 && position - base + 8 <= buffer.length) {
        // Two 32-bit reads: a BigInt per string made this loop the slowest part of a scan.
        const low = buffer.readUInt32LE(position - base);
        if (low > MAX_STRING || buffer.readUInt32LE(position - base + 4) !== 0) throw new Error("GGUF string is implausibly long");
        position += 8 + low;
        remaining -= 1;
      }
      this.offset = position;
    }
  }

  async u32() {
    const at = await this.window(4);
    this.offset += 4;
    return this.#buffer.readUInt32LE(at);
  }

  async u64() {
    const at = await this.window(8);
    this.offset += 8;
    const value = this.#buffer.readBigUInt64LE(at);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
}

async function readString(reader, keep) {
  const length = await reader.u64();
  if (typeof length !== "number" || length > MAX_STRING) throw new Error("GGUF string is implausibly long");
  if (!keep) {
    reader.offset += length;
    return null;
  }
  const at = await reader.window(length);
  reader.offset += length;
  return reader.buffer.toString("utf8", at, at + length);
}

async function readScalar(reader, type) {
  const size = FIXED_SIZE[type];
  const at = await reader.window(size);
  reader.offset += size;
  const b = reader.buffer;
  switch (type) {
    case 0: return b.readUInt8(at);
    case 1: return b.readInt8(at);
    case 2: return b.readUInt16LE(at);
    case 3: return b.readInt16LE(at);
    case 4: return b.readUInt32LE(at);
    case 5: return b.readInt32LE(at);
    case 6: return b.readFloatLE(at);
    case 7: return b.readUInt8(at) !== 0;
    case 10: {
      const value = b.readBigUInt64LE(at);
      return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    case 11: {
      const value = b.readBigInt64LE(at);
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    case 12: return b.readDoubleLE(at);
    default: throw new Error(`GGUF value type ${type} is not known`);
  }
}

async function readValue(reader, type) {
  if (type === STRING) return readString(reader, true);
  if (type !== ARRAY) return readScalar(reader, type);
  const elementType = await reader.u32();
  const count = await reader.u64();
  if (typeof count !== "number") throw new Error("GGUF array is implausibly long");
  const keep = count <= MAX_KEPT_ARRAY;
  if (elementType === ARRAY) throw new Error("GGUF nested arrays are not read");
  if (elementType !== STRING) {
    const size = FIXED_SIZE[elementType];
    if (!size) throw new Error(`GGUF value type ${elementType} is not known`);
    if (!keep) {
      reader.offset += size * count;
      return undefined;
    }
  }
  if (!keep && elementType === STRING) {
    await reader.skipStrings(count);
    return undefined;
  }
  const values = keep ? [] : null;
  for (let index = 0; index < count; index += 1) {
    const value = elementType === STRING ? await readString(reader, keep) : await readScalar(reader, elementType);
    if (keep) values.push(value);
  }
  return values ?? undefined;
}

function place(root, key, value) {
  const path = key.split(".");
  let node = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const next = node[path[index]];
    if (next === undefined) node = node[path[index]] = {};
    else if (next !== null && typeof next === "object" && !Array.isArray(next)) node = next;
    else return;
  }
  const last = path[path.length - 1];
  if (!(last in node)) node[last] = value;
}

/** Read the scan's view of a GGUF file: nested metadata and tensor shapes. */
export async function readGgufSummary(file) {
  const handle = await fs.open(file, "r");
  try {
    const reader = new HeaderReader(handle);
    const at = await reader.window(24);
    if (reader.buffer.toString("latin1", at, at + 4) !== "GGUF") throw new Error("not a GGUF file");
    const version = reader.buffer.readUInt32LE(at + 4);
    if (version < 2 || version > 3) throw new Error(`GGUF version ${version} is read by the library`);
    reader.offset = 8;
    const tensorCount = await reader.u64();
    const kvCount = await reader.u64();
    if (typeof tensorCount !== "number" || typeof kvCount !== "number" || tensorCount > 1e6 || kvCount > 1e6) {
      throw new Error("GGUF counts are implausible");
    }
    const metadata = {};
    for (let index = 0; index < kvCount; index += 1) {
      const key = await readString(reader, true);
      const value = await readValue(reader, await reader.u32());
      if (value !== undefined) place(metadata, key, value);
    }
    const tensorInfo = [];
    for (let index = 0; index < tensorCount; index += 1) {
      const name = await readString(reader, true);
      const dimensionCount = await reader.u32();
      if (dimensionCount > 8) throw new Error("GGUF tensor has too many dimensions");
      const dimensions = [];
      for (let dimension = 0; dimension < dimensionCount; dimension += 1) dimensions.push(await reader.u64());
      const ggmlType = await reader.u32();
      await reader.u64();
      tensorInfo.push({ name, dimensions, ggmlType });
    }
    const architecture = metadata.general?.architecture;
    return { version, tensorCount, metadata, architectureMetadata: typeof architecture === "string" ? metadata[architecture] ?? {} : {}, tensorInfo };
  } finally {
    await handle.close();
  }
}
