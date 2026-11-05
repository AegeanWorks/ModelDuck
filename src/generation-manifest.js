import { createHash } from "node:crypto";

export const PROMPT_FINGERPRINT_VERSION = 1;
export const MAX_HISTORY_CHARS = 48_000;
export const MAX_HISTORY_MESSAGES = 40;

/**
 * SHA-256 over a JSON snapshot. Callers pass plain objects whose key order is
 * deterministic (the manifest builder constructs them field by field).
 * IDEA-1323: NFC-normalize first so canonically identical text hashes
 * identically no matter how it was encoded on ingest.
 */
export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value).normalize("NFC")).digest("hex");
}

/**
 * The exact system prompt the engine sends. Keeping this helper next to the
 * manifest means the fingerprint and the generation cannot drift apart.
 */
export function buildSystemPrompt(systemPrompt, reasoning) {
  const base = String(systemPrompt ?? "").trim();
  if (reasoning === "off") return base;
  const directive =
    reasoning === "deep"
      ? "Think through the problem step by step in a few short sentences, then give the final answer on its own line (code answers: in one final fenced block)."
      : "Reason carefully before answering. Keep the final answer concise.";
  return base ? `${base}\n\n${directive}` : directive;
}

/**
 * The exact history handed to LlamaChatSession: newest-first selection bounded
 * by 40 messages / 48k characters, then reversed and trimmed so it starts with
 * a user turn. Pass the messages *before* the current prompt.
 */
export function buildChatHistory(messages) {
  const usable = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    characters += message.content.length;
    if (usable.length >= MAX_HISTORY_MESSAGES || characters > MAX_HISTORY_CHARS) break;
    usable.push(message);
  }
  usable.reverse();
  while (usable.length && usable[0].role !== "user") usable.shift();
  return usable.map((message) =>
    message.role === "user"
      ? { type: "user", text: message.content }
      : { type: "model", response: [message.content] },
  );
}

export function repeatPrompt(text, count = 1) {
  const repeats = Math.max(1, Math.min(3, Number(count) || 1));
  return repeats > 1
    ? Array.from({ length: repeats }, () => String(text ?? "")).join("\n\n")
    : String(text ?? "");
}

/**
 * A session can only be reused when it holds exactly the prior conversation and
 * that conversation was not truncated by the history budget.
 */
export function canReuseSession(record, { signature, priorCount, historyComplete }) {
  return Boolean(
    record &&
      historyComplete &&
      record.signature === signature &&
      record.historyLength === priorCount,
  );
}

/**
 * After a completed turn the session holds the prior messages plus the current
 * user turn and the model reply, so the next prior count is messageCount + 1.
 * Truncated history is never marked reusable.
 */
export function nextSessionHistoryLength(messageCount, historyComplete) {
  return historyComplete ? messageCount + 1 : null;
}

function historyTruncated(priorMessages, history) {
  if (history.length < priorMessages.length) return true;
  return history.some((message, index) => {
    const source = priorMessages[index];
    if (!source) return true;
    return message.type === "user"
      ? source.role !== "user" || message.text !== source.content
      : source.role === "user" || message.response?.[0] !== source.content;
  });
}

/**
 * IDEA-1164: loop detection over the reply tail. A unit of minUnit+ characters
 * repeating consecutively repeats+ times is a degenerate loop, not emphasis.
 * Bounded to the tail so long honest answers never pay for the check.
 */
export function detectLoop(text, { minUnit = 12, repeats = 3, tail = 2000 } = {}) {
  const tailText = String(text ?? "").slice(-Math.max(1, tail));
  for (let unit = minUnit; unit <= Math.floor(tailText.length / repeats); unit += 1) {
    const end = tailText.slice(-unit);
    let count = 1;
    let index = tailText.length - unit * 2;
    while (index >= 0 && tailText.slice(index, index + unit) === end) {
      count += 1;
      if (count >= repeats) return { loop: true, unit: end };
      index -= unit;
    }
  }
  return { loop: false, unit: null };
}

/**
 * A generation manifest describes what the model actually sees for one reply.
 * It is independent from the benchmark test hash: the test hash describes the
 * experiment, while this manifest describes the generation that ran.
 */
export function buildGenerationManifest({
  model,
  originalSystemPrompt,
  effectiveSystemPrompt,
  messages,
  history,
  promptText,
  settings,
  runtimeVersion,
  chatTemplateHash,
  allocation = null,
  // Truncation decided outside the history budget (e.g. IDEA-1082 dropping
  // old turns) still marks the manifest; the digest covers it, so a dropped
  // history never shares a key with a complete one.
  forceHistoryTruncated = false,
  // Same for a truncated completion prompt: marked only when truncated, so
  // complete prompts that fit keep their existing digest.
  forcePromptTruncated = false,
}) {
  const priorMessages = messages ?? [];
  const historyJson = history ?? buildChatHistory(priorMessages);
  const effective = effectiveSystemPrompt ?? buildSystemPrompt(originalSystemPrompt, settings?.reasoning);
  const prompt = String(promptText ?? "");
  const promptRepeat = Math.max(1, Math.min(3, Number(settings?.promptRepeat) || 1));
  const modelIdentity = {
    id: model?.id ?? null,
    fileName: model?.fileName ?? null,
    size: model?.size ?? null,
    quant: model?.quant ?? null,
    architecture: model?.architecture ?? null,
    chatTemplateHash: chatTemplateHash ?? model?.chatTemplateHash ?? null,
  };
  const settingsIdentity = {
    temperature: settings?.temperature ?? null,
    topP: settings?.topP ?? null,
    topK: settings?.topK ?? null,
    minP: settings?.minP ?? null,
    repeatPenalty: settings?.repeatPenalty ?? null,
    promptRepeat,
    maxTokens: settings?.maxTokens ?? null,
    contextSize: settings?.contextSize ?? null,
    seed: settings?.seed ?? null,
    reasoning: settings?.reasoning ?? "off",
    structuredOutput: settings?.structuredOutput ?? "none",
    jsonSchema: settings?.jsonSchema ?? "",
    contextOverflow: settings?.contextOverflow ?? "shift",
    // IDEA-1076: stops and the chat prefix change what comes out, so they
    // are part of the exact-repeat cache key. Different stops must never
    // share a cached answer.
    customStopTriggers: Array.isArray(settings?.customStopTriggers) ? [...settings.customStopTriggers] : [],
    responsePrefix: settings?.responsePrefix ?? "",
  };
  const manifest = {
    fingerprintVersion: PROMPT_FINGERPRINT_VERSION,
    runtime: {
      nodeLlamaCpp: runtimeVersion ?? "unknown",
    },    model: {
      ...modelIdentity,
      digest: digest(modelIdentity),
    },
    systemPrompt: {
      original: String(originalSystemPrompt ?? ""),
      effective,
      digest: digest(effective),
    },
    history: {
      count: historyJson.length,
      truncated: historyTruncated(priorMessages, historyJson) || Boolean(forceHistoryTruncated),
      digest: digest(historyJson),
    },
    prompt: {
      text: prompt,
      repeat: promptRepeat,
      digest: digest(prompt),
    },
    settings: settingsIdentity,
    // IDEA-1164: the full sampler stack is attested, not just the classic
    // repeat penalty. (XTC has no prompt-level knob in this runtime, so the
    // manifest records DRY; a future sampler key extends this block.)
    sampler: {
      repeatPenalty: settings?.repeatPenalty ?? null,
      repeatPenaltyTokens: settings?.repeatPenaltyTokens ?? null,
      penalizeNewLine: settings?.penalizeNewLine ?? null,
      dryStrength: settings?.dryStrength ?? null,
      dryBase: settings?.dryBase ?? null,
      dryAllowedLength: settings?.dryAllowedLength ?? null,
    },
    // IDEA-1229: what the engine actually allocated for this reply, so the
    // manifest attests the context, backend and fallback instead of the ask.
    allocation: allocation
      ? {
          allocatedContext: allocation.allocatedContext ?? null,
          requestedContext: allocation.requestedContext ?? null,
          backend: allocation.backend ?? null,
          gpuLayers: allocation.gpuLayers ?? null,
          fallback: allocation.fallback ?? null,
        }
      : null,
  };
  if (forcePromptTruncated) manifest.prompt.truncated = true;
  manifest.digest = digest(manifest);
  manifest.shortDigest = manifest.digest.slice(0, 16);
  return manifest;
}

/** A compact, storage-safe projection of a manifest. */
export function manifestSummary(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  return {
    fingerprintVersion: manifest.fingerprintVersion ?? null,
    digest: manifest.digest ?? null,
    shortDigest: manifest.shortDigest ?? null,
    runtimeVersion: manifest.runtime?.nodeLlamaCpp ?? null,
    modelDigest: manifest.model?.digest ?? null,
    chatTemplateHash: manifest.model?.chatTemplateHash ?? null,
    systemPromptDigest: manifest.systemPrompt?.digest ?? null,
    historyDigest: manifest.history?.digest ?? null,
    historyLength: manifest.history?.count ?? null,
    historyTruncated: manifest.history?.truncated ?? false,
    promptDigest: manifest.prompt?.digest ?? null,
    promptRepeat: manifest.prompt?.repeat ?? 1,
    allocatedContext: manifest.allocation?.allocatedContext ?? null,
    // IDEA-1229: the summary keeps the ask beside the grant, so a clipped
    // context is visible without opening the full manifest.
    requestedContext: manifest.allocation?.requestedContext ?? null,
    allocationBackend: manifest.allocation?.backend ?? null,
    allocationGpuLayers: manifest.allocation?.gpuLayers ?? null,
    allocationFallback: manifest.allocation?.fallback ?? null,
  };
}
