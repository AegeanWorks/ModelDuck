import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AppError } from "./errors.js";
import { assertDiskSpace, ensureDirectory, formatBytes } from "./fs-atomic.js";
import { inspectGgufHeader } from "./gguf-guard.js";
import { kvShapeFromMetadata } from "./memory-fit.js";

const MAX_SCAN_DEPTH = 6;
const MODEL_EXTENSION = ".gguf";

async function defaultReadMetadata(file) {
  await inspectGgufHeader(file);
  const module = await import("node-llama-cpp");
  return module.readGgufFileInfo(file, {
    readTensorInfo: true,
    logWarnings: false,
    spliceSplitFiles: false,
  });
}

function safeNumber(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

function parameterCount(info) {
  let total = 0n;
  for (const tensor of info?.tensorInfo ?? []) {
    let elements = 1n;
    for (const dimension of tensor.dimensions ?? []) {
      elements *= BigInt(dimension);
    }
    total += elements;
  }
  return total;
}

function formatParameters(count) {
  if (!count) return "?";
  if (count >= 1_000_000_000n) return `${(Number(count) / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000n) return `${Math.round(Number(count) / 1_000_000)}M`;
  return `${count}`;
}

function quantFromName(name) {
  const match = String(name).match(
    /(IQ\d+_[A-Z0-9_]+|Q\d+_K_[SML]|Q\d+_[01]|Q\d+_K|BF16|F16|F32)/i,
  );
  return match ? match[0].toUpperCase() : "GGUF";
}

function nameFromFile(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashId(relativePath) {
  return createHash("sha1")
    .update(relativePath.replaceAll("\\", "/").toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

async function hasGgufMagic(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && buffer.toString("latin1") === "GGUF";
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function walkGgufFiles(directory, depth = 0, found = []) {
  if (depth > MAX_SCAN_DEPTH) return found;
  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkGgufFiles(full, depth + 1, found);
    } else if (
      // IDEA-1070: symlinked models count. The link itself must live in the
      // library; its target is resolved at stat time, and deletes remove the
      // link (deleteById already refuses paths outside the models folder).
      // Symlinked directories are never recursed into, so a link loop cannot
      // trap the scan.
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.toLowerCase().endsWith(MODEL_EXTENSION) &&
      !entry.name.toLowerCase().endsWith(`${MODEL_EXTENSION}.part`)
    ) {
      found.push(full);
    }
  }
  return found;
}

function summarize(info, file, stats) {
  const relative = path.basename(file);
  const general = info?.metadata?.general ?? {};
  const architecture = typeof general.architecture === "string" ? general.architecture : "unknown";
  const architectureMetadata = info?.architectureMetadata ?? info?.metadata?.[architecture] ?? {};
  const contextLength = safeNumber(architectureMetadata.context_length) || null;
  const count = parameterCount(info);
  const declaredSize = typeof general.size_label === "string" ? general.size_label.trim() : "";
  const chatTemplate = info?.metadata?.tokenizer?.chat_template;
  const chatTemplateText = typeof chatTemplate === "string" ? chatTemplate : "";
  return {
    name:
      typeof general.name === "string" && general.name.trim()
        ? general.name.trim()
        : nameFromFile(file),
    fileName: relative,
    size: stats.size,
    sizeLabel: formatBytes(stats.size),
    quant: quantFromName(relative),
    params: declaredSize || formatParameters(count),
    architecture,
    contextLength,
    kvShape: kvShapeFromMetadata(architectureMetadata),
    chatTemplate: Boolean(chatTemplateText.trim()),
    chatTemplateHash: chatTemplateText.trim()
      ? createHash("sha256").update(chatTemplateText).digest("hex").slice(0, 16)
      : null,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
  };
}

export function createModelRegistry({
  modelsDir,
  readMetadata = defaultReadMetadata,
  logger = console,
}) {
  const cache = new Map();
  let entries = new Map();

  async function scan() {
    await ensureDirectory(modelsDir);
    const files = await walkGgufFiles(modelsDir);
    const nextEntries = new Map();
    const nextCache = new Map();

    for (const file of files) {
      let stats;
      try {
        stats = await fs.promises.stat(file);
      } catch {
        continue;
      }
      if (!stats.isFile() || stats.size < 8) continue;
      if (!(await hasGgufMagic(file))) continue;

      const cacheKey = `${file}|${stats.size}|${stats.mtimeMs}`;
      let summary = cache.get(cacheKey);
      if (!summary) {
        try {
          const info = await readMetadata(file);
          summary = summarize(info, file, stats);
        } catch (error) {
          logger.warn?.(`[modelduck] Could not read GGUF metadata from ${file}: ${error.message}`);
          summary = {
            name: nameFromFile(file),
            fileName: path.basename(file),
            size: stats.size,
            sizeLabel: formatBytes(stats.size),
            quant: quantFromName(file),
            params: "?",
            architecture: "unknown",
            contextLength: null,
            chatTemplate: false,
            chatTemplateHash: null,
            modifiedAt: new Date(stats.mtimeMs).toISOString(),
            unreadable: true,
            ...(error?.code === "gguf_header_rejected"
              ? { blocked: true, blockedReason: error.why }
              : {}),
          };
        }
      }

      const relativePath = path.relative(modelsDir, file);
      const id = hashId(relativePath);
      const entry = { id, path: file, ...summary };
      nextEntries.set(id, entry);
      nextCache.set(cacheKey, summary);
    }

    entries = nextEntries;
    cache.clear();
    for (const [key, value] of nextCache) cache.set(key, value);
    return listPublic();
  }

  function publicEntry(entry) {
    if (!entry) return null;
    const { path: _path, ...rest } = entry;
    return { ...rest };
  }

  function listPublic() {
    return [...entries.values()]
      .map(publicEntry)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function findById(id) {
    return entries.get(id) ?? null;
  }

  async function importFromPath(sourcePath) {
    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      throw new AppError("Choose a GGUF file first", {
        code: "missing_path",
        why: "No file path was supplied.",
        fix: "Paste the full path to a .gguf file, then click Import.",
      });
    }

    const source = path.resolve(sourcePath.trim().replace(/^"|"$/g, ""));
    let stats;
    try {
      stats = await fs.promises.stat(source);
    } catch {
      throw new AppError("That file was not found", {
        code: "model_not_found",
        why: `ModelDuck could not find ${source}.`,
        fix: "Check the path, or use Open models folder and copy the GGUF file there.",
      });
    }
    if (!stats.isFile()) {
      throw new AppError("That path is not a file", {
        code: "invalid_model_path",
        why: `${source} is not a regular file.`,
        fix: "Choose a single .gguf file.",
      });
    }
    if (!source.toLowerCase().endsWith(MODEL_EXTENSION)) {
      throw new AppError("That is not a GGUF model", {
        code: "invalid_model_type",
        why: "ModelDuck runs .gguf files only.",
        fix: "Pick a file whose name ends in .gguf.",
      });
    }
    if (!(await hasGgufMagic(source))) {
      throw new AppError("That file is not a valid GGUF", {
        code: "invalid_gguf",
        why: "The file does not begin with the GGUF signature.",
        fix: "Re-download the model, or choose a different GGUF file.",
      });
    }

    await ensureDirectory(modelsDir);
    const sourceInsideModels = path.resolve(source).startsWith(`${path.resolve(modelsDir)}${path.sep}`);
    if (sourceInsideModels) {
      await scan();
      const existing = [...entries.values()].find((entry) => path.resolve(entry.path) === source);
      if (existing) return publicEntry(existing);
    }

    await assertDiskSpace(modelsDir, stats.size);
    const base = path.basename(source).replace(/[^\w.\- ()]/g, "_");
    let target = path.join(modelsDir, base || "model.gguf");
    let suffix = 1;
    while (true) {
      try {
        await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        suffix += 1;
        const extension = path.extname(base);
        const stem = path.basename(base, extension);
        target = path.join(modelsDir, `${stem}-${suffix}${extension}`);
      }
    }

    await scan();
    const imported = [...entries.values()].find((entry) => path.resolve(entry.path) === target);
    if (imported?.blocked) {
      await fs.promises.unlink(target).catch(() => {});
      await scan();
      throw new AppError("This GGUF file was blocked", {
        code: "gguf_header_rejected",
        status: 422,
        why: imported.blockedReason,
        fix: "Download the model again from a source you trust.",
      });
    }
    if (!imported) {
      throw new AppError("The model was copied but could not be read", {
        code: "model_unreadable",
        why: "The GGUF header could not be parsed after copying.",
        fix: "Try another GGUF file, or restart ModelDuck and refresh the model list.",
      });
    }
    return publicEntry(imported);
  }

  async function deleteById(id, { loadedId = null } = {}) {
    const entry = entries.get(id);
    if (!entry) {
      throw new AppError("Model not found", {
        code: "model_not_found",
        status: 404,
        why: "That model is no longer in the library.",
        fix: "Refresh the model list.",
      });
    }
    if (loadedId && loadedId === id) {
      throw new AppError("Unload the model first", {
        code: "model_in_use",
        status: 409,
        why: "A running model cannot be deleted.",
        fix: "Click Unload, then delete the file.",
      });
    }
    const root = path.resolve(modelsDir);
    const target = path.resolve(entry.path);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new AppError("Refusing to delete outside the models folder", {
        code: "unsafe_path",
        status: 403,
        why: "The model path is outside ModelDuck's models folder.",
        fix: "Delete that file manually if you are sure.",
      });
    }
    await fs.promises.unlink(target);
    await fs.promises.unlink(`${target}.part`).catch(() => {});
    entries.delete(id);
    return publicEntry(entry);
  }

  return {
    modelsDir,
    scan,
    listPublic,
    findById,
    importFromPath,
    deleteById,
    get size() {
      return entries.size;
    },
  };
}
