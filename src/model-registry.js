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

/**
 * IDEA-1093/1228: resolve which chat template an entry will use and flag
 * compat risks. A missing template falls back to the model default; an
 * underscore-prefixed file follows the private-HF convention where a rename
 * may have detached the weights from the template they were tuned with.
 */
export function templateCompat(entry) {
  const warnings = [];
  const fileName = String(entry?.fileName ?? "");
  if (!entry?.chatTemplate) warnings.push("This model has no chat template; replies use the runtime default.");
  if (/^_/.test(fileName)) warnings.push("This file follows the private naming convention; confirm the template matches the weights.");
  return { status: entry?.chatTemplate ? "model" : "fallback", warnings };
}

/**
 * IDEA-1675: per-model stops/sampling registry. The chat template hash is
 * stored per model but sampling was global-only, so one model's fence stop
 * could bleed into another model's generation. Overrides are keyed by model
 * id and fall back to the global settings when a model has none.
 */
export const MODEL_SAMPLING_KEYS = Object.freeze([
  "temperature",
  "topP",
  "topK",
  "minP",
  "repeatPenalty",
  "repeatPenaltyTokens",
  "penalizeNewLine",
  "dryStrength",
  "dryBase",
  "dryAllowedLength",
  "responsePrefix",
  "customStopTriggers",
]);

export function fenceModelSamplingPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const fenced = {};
  for (const key of MODEL_SAMPLING_KEYS) {
    if (Object.hasOwn(patch, key)) fenced[key] = patch[key];
  }
  return fenced;
}

/**
 * Merge a per-model sampling patch over global settings. Overrides are
 * keyed by model id and fall back to the global settings when a model has
 * none, so one model's fence stop cannot bleed into another model's
 * generation. Unknown keys are fenced out; the stops array is copied so
 * later mutation cannot alias the stored override.
 */
export function resolveModelSettings(globalSettings, override) {
  const base = globalSettings && typeof globalSettings === "object" ? globalSettings : {};
  const patch = fenceModelSamplingPatch(override);
  if (!Object.keys(patch).length) return { ...base };
  const merged = { ...base, ...patch };
  if (Array.isArray(patch.customStopTriggers)) {
    merged.customStopTriggers = [...patch.customStopTriggers];
  }
  return merged;
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
    } else if (
      // IDEA-1072: Hugging Face cache blobs have no extension; a symlink to
      // one still counts when the target carries the GGUF magic. Read-only:
      // the scan never writes to the cache, and deletes remove the link.
      entry.isSymbolicLink()
    ) {
      try {
        if (await hasGgufMagic(full)) found.push(full);
      } catch {
        // Not a GGUF target; ignore it.
      }
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
  const summary = {
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
      // IDEA-1323: NFC identity so the same template hashes the same everywhere.
      ? createHash("sha256").update(chatTemplateText.normalize("NFC")).digest("hex").slice(0, 16)
      : null,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
  };
  summary.compat = templateCompat(summary);
  return summary;
}

export function createModelRegistry({
  modelsDir,
  readMetadata = defaultReadMetadata,
  logger = console,
}) {
  const cache = new Map();
  let entries = new Map();
  const samplingOverrides = new Map();
  let lastScanAt = 0;
  let lastDirStamp = null;
  let scanHits = 0;
  let scanMisses = 0;
  const scanStats = () => ({ hits: scanHits, misses: scanMisses });

  async function dirStamp() {
    try {
      const info = await fs.promises.stat(modelsDir);
      return `${info.mtimeMs}:${info.size ?? ""}`;
    } catch {
      return "missing";
    }
  }

  async function scan({ force = false } = {}) {
    await ensureDirectory(modelsDir);
    // /api/state polls this. Reuse a scan for one second when the directory
    // stamp has not moved; import/delete pass force, and the TTL still catches
    // an in-place file change.
    const stamp = await dirStamp();
    if (!force && stamp === lastDirStamp && Date.now() - lastScanAt < 1000) {
      scanHits += 1;
      return listPublic();
    }
    scanMisses += 1;
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
            // A file that failed for a reason other than the header guard still
            // needs to say why: the UI shows it and hides Load.
            unreadableReason: error?.why || error?.message || "The GGUF header could not be read.",
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
    // Overrides keyed by a model that no longer exists would attach to a
    // future model reusing the folder: prune them on every scan.
    for (const id of [...samplingOverrides.keys()]) {
      if (!entries.has(id)) samplingOverrides.delete(id);
    }
    lastScanAt = Date.now();
    lastDirStamp = await dirStamp();
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
      await scan({ force: true });
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

    await scan({ force: true });
    const imported = [...entries.values()].find((entry) => path.resolve(entry.path) === target);
    if (imported?.blocked) {
      await fs.promises.unlink(target).catch(() => {});
      await scan({ force: true });
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
    await fs.promises.unlink(`${target}.receipt.json`).catch(() => {});
    await fs.promises.unlink(`${target}.part.resume.json`).catch(() => {});
    entries.delete(id);
    samplingOverrides.delete(id);
    return publicEntry(entry);
  }

  function setModelSampling(modelId, patch) {
    if (typeof modelId !== "string" || !modelId) return {};
    const fenced = fenceModelSamplingPatch(patch);
    if (!Object.keys(fenced).length) {
      samplingOverrides.delete(modelId);
      return {};
    }
    const copy = { ...fenced };
    if (Array.isArray(fenced.customStopTriggers)) copy.customStopTriggers = [...fenced.customStopTriggers];
    samplingOverrides.set(modelId, copy);
    return { ...copy };
  }

  function getModelSampling(modelId) {
    const stored = samplingOverrides.get(modelId);
    if (!stored) return null;
    const copy = { ...stored };
    if (Array.isArray(stored.customStopTriggers)) copy.customStopTriggers = [...stored.customStopTriggers];
    return copy;
  }

  function clearModelSampling(modelId) {
    return samplingOverrides.delete(modelId);
  }

  function resolveModelSettingsForId(modelId, globalSettings) {
    return resolveModelSettings(globalSettings, samplingOverrides.get(modelId) ?? null);
  }

  return {
    modelsDir,
    scan,
    scanStats,
    listPublic,
    findById,
    importFromPath,
    deleteById,
    setModelSampling,
    getModelSampling,
    clearModelSampling,
    resolveModelSettings: resolveModelSettingsForId,
    get size() {
      return entries.size;
    },
  };
}

