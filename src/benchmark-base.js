import { readFile } from "node:fs/promises";
import path from "node:path";

import { AppError } from "./errors.js";
import { writeJsonAtomic } from "./fs-atomic.js";
import { getCatalogModel } from "./model-catalog.js";

export const CHAT_BASE_FILE = "chat-base.json";
export const CHAT_BASE_SCHEMA = 1;

const SETTING_KEYS = [
  "kvCache",
  "contextSize",
  "threads",
  "maxThreads",
  "batchSize",
  "sequences",
  "flashAttention",
  "useMmap",
  "gpuLayers",
  "gpuBackend",
  "checkpoints",
  "checkpointInterval",
  "checkpointMax",
];

function invalid(message, fix) {
  return new AppError("The chat benchmark base is invalid", {
    code: "chat_base_invalid",
    status: 422,
    why: message,
    fix,
  });
}

function settingsFromModel(model) {
  const settings = {};
  for (const key of SETTING_KEYS) {
    if (model[key] !== undefined && model[key] !== null) settings[key] = model[key];
  }
  if (model.requestedContextSize) settings.contextSize = model.requestedContextSize;
  return settings;
}

/** A model-phase result turned into the base the chat phase will load. */
export function selectionFromVariant(model) {
  if (!model?.catalogId) {
    throw invalid(
      "That model result does not name a catalog model.",
      "Run the model phase again, then choose one of its recommendation cards.",
    );
  }
  if (!getCatalogModel(model.catalogId)) {
    throw invalid(
      `The catalog no longer contains ${model.catalogId}.`,
      "Run the model phase with the current model catalog, then choose a result.",
    );
  }
  return {
    schema: CHAT_BASE_SCHEMA,
    selectedAt: new Date().toISOString(),
    variantId: model.variantId,
    label: model.label ?? model.variantId,
    fileName: model.fileName ?? null,
    catalogId: model.catalogId,
    family: model.key ?? model.catalogId,
    settings: settingsFromModel(model),
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw invalid(
      `${path.basename(file)} could not be read as JSON.`,
      "Pick a model-phase recommendation again, or delete benchmarks/chat-base.json.",
    );
  }
}

/** The latest model-phase result, falling back to the model baseline. */
export async function readLatestModelResult({ benchmarkDir }) {
  const latest = await readJson(path.join(benchmarkDir, "results", "latest-model.json"));
  if (latest) return latest;
  return readJson(path.join(benchmarkDir, "baseline-model.json"));
}

function validateSelection(value) {
  if (!value || typeof value !== "object" || value.schema !== CHAT_BASE_SCHEMA) {
    throw invalid(
      "The saved selection has an unknown format.",
      "Pick a model-phase recommendation again.",
    );
  }
  if (!value.catalogId || !value.settings || typeof value.settings !== "object") {
    throw invalid(
      "The saved selection is missing its model or settings.",
      "Pick a model-phase recommendation again.",
    );
  }
  if (!getCatalogModel(value.catalogId)) {
    throw invalid(
      `The catalog no longer contains ${value.catalogId}.`,
      "Pick a model-phase recommendation again.",
    );
  }
  return { ...value, settings: settingsFromModel(value.settings) };
}

/** Load the saved chat base, or null when the default base should be used. */
export async function loadChatBase({ benchmarkDir }) {
  const file = path.join(benchmarkDir, CHAT_BASE_FILE);
  const value = await readJson(file);
  return value ? validateSelection(value) : null;
}

/** The flat object `buildChatMatrix` spreads over its defaults. */
export function chatBaseSettings(selection) {
  if (!selection) return {};
  return {
    ...selection.settings,
    catalogId: selection.catalogId,
    family: selection.family,
    label: selection.label,
    fileName: selection.fileName,
  };
}

/** Resolve a variant id from the latest model result without writing anything. */
export async function resolveChatBase({ benchmarkDir, variantId }) {
  const result = await readLatestModelResult({ benchmarkDir });
  if (!result?.models?.length) {
    throw new AppError("No model phase result yet", {
      code: "model_benchmark_missing",
      status: 409,
      why: "The chat phase needs a model configuration measured by the model phase.",
      fix: "Run the model phase first, then choose a recommendation.",
    });
  }
  const model = result.models.find((item) => item.variantId === variantId);
  if (!model) {
    throw new AppError("That model configuration is not in the latest run", {
      code: "chat_base_variant_missing",
      status: 404,
      why: `${variantId ?? "The requested variant"} is not in the latest model-phase result.`,
      fix: "Choose a recommendation card from the latest model run.",
    });
  }
  if (model.error || !model.items) {
    throw invalid(
      "A failed model variant cannot become the chat base.",
      "Choose a variant that completed the model phase.",
    );
  }
  return selectionFromVariant(model);
}

/** Choose and persist the model configuration the next chat phase will load. */
export async function selectChatBase({ benchmarkDir, variantId }) {
  const selection = await resolveChatBase({ benchmarkDir, variantId });
  await writeJsonAtomic(path.join(benchmarkDir, CHAT_BASE_FILE), selection);
  return selection;
}
