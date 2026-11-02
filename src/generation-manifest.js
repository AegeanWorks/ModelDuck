import { createHash } from "node:crypto";

export const PROMPT_FINGERPRINT_VERSION = 1;
export const MAX_HISTORY_CHARS = 48_000;
export const MAX_HISTORY_MESSAGES = 40;

/**
 * SHA-256 over a JSON snapshot. Callers pass plain objects whose key order is
 * deterministic (the manifest builder constructs them field by field).
 */
export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  };
  const manifest = {
    fingerprintVersion: PROMPT_FINGERPRINT_VERSION,
    runtime: {
      nodeLlamaCpp: runtimeVersion ?? "unknown",
    },
    model: {
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
      truncated: historyTruncated(priorMessages, historyJson),
      digest: digest(historyJson),
    },
    prompt: {
      text: prompt,
      repeat: promptRepeat,
      digest: digest(prompt),
    },
    settings: settingsIdentity,
  };
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
  };
}
