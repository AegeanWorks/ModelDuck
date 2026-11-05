import { createHash } from "node:crypto";

import { PROMPT_FINGERPRINT_VERSION } from "../src/generation-manifest.js";

/**
 * Hash every input that changes what the benchmark asks the model to do.
 * Runtime and model-template identity are recorded separately: they describe
 * the environment, not the test definition.
 */
export function benchmarkTestHash({ suiteVersion, phase, prompts, matrix, systemPrompt }) {
  const definition = {
    suiteVersion,
    phase,
    systemPrompt,
    generationManifestVersion: PROMPT_FINGERPRINT_VERSION,
    prompts,
    matrix: matrix.map((variant) => ({
      id: variant.id,
      fileName: variant.fileName,
      quant: variant.quant,
      preset: variant.preset,
      kvCache: variant.kvCache,
      contextSize: variant.contextSize,
      threads: variant.threads,
      maxThreads: variant.maxThreads,
      batchSize: variant.batchSize,
      // A batch-1 repro run measures differently than the speed default, so
      // the repro flag is part of the test definition. It is only hashed when
      // set: normal matrices keep their existing hash and baseline.
      ...(variant.deterministicRepro
        ? { deterministicRepro: true, reproRuns: variant.reproRuns ?? 1 }
        : {}),
      sequences: variant.sequences,
      flashAttention: variant.flashAttention,
      useMmap: variant.useMmap,
      gpuLayers: variant.gpuLayers,
      gpuBackend: variant.gpuBackend,
      checkpoints: variant.checkpoints,
      checkpointInterval: variant.checkpointInterval ?? 8192,
      checkpointMax: variant.checkpointMax ?? 32,
      temperature: variant.temperature,
      topP: variant.topP,
      topK: variant.topK,
      minP: variant.minP,
      repeatPenalty: variant.repeatPenalty,
      promptRepeat: variant.promptRepeat ?? 1,
      reasoning: variant.reasoning ?? "off",
      structuredOutput: variant.structuredOutput ?? "none",
      jsonSchema: variant.jsonSchema ?? "",
      seed: variant.seed,
      contextOverflow: variant.contextOverflow ?? "shift",
      systemPrompt: variant.systemPrompt ?? systemPrompt,
      promptIds: variant.promptIds ?? null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
}

/**
 * Compare a baseline's model identities with the currently installed files.
 * A changed chat template or file size changes what the model sees even when
 * the prompt definitions are identical.
 */
export function modelIdentityChanges(baselineModels, currentModels) {
  const changes = [];
  for (const current of currentModels) {
    const previous = (baselineModels ?? []).find((model) => model.variantId === current.variantId);
    if (!previous) continue;
    const templateChanged =
      (previous.chatTemplateHash ?? null) !== (current.chatTemplateHash ?? null);
    const fileChanged = (previous.size ?? null) !== (current.size ?? null);
    if (templateChanged || fileChanged) {
      changes.push({
        variantId: current.variantId,
        previousTemplate: previous.chatTemplateHash ?? null,
        currentTemplate: current.chatTemplateHash ?? null,
        previousSize: previous.size ?? null,
        currentSize: current.size ?? null,
      });
    }
  }
  return changes;
}
