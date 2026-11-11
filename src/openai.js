import { randomUUID } from "node:crypto";

import { AppError } from "./errors.js";
import { readJsonBody, sendJson, sseStart } from "./http.js";

function sseJson(res, value) {
  return res.write(`data: ${JSON.stringify(value)}\n\n`);
}

const RETRYABLE_STREAM_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);

// IDEA-1074: transport-level causes stay retryable even when wrapped in `cause`;
// model and validation errors (AppError codes) stay terminal.
function retryableStreamFailure(error) {
  if (!error) return false;
  if (String(error.name ?? "") === "AbortError") return true;
  if (RETRYABLE_STREAM_CODES.has(String(error.code ?? ""))) return true;
  return retryableStreamFailure(error.cause ?? null);
}

export function streamFailure(error, partial = "") {
  const text = String(partial ?? "");
  return {
    message: String(error?.message ?? "Stream failed"),
    type: "server_error",
    code: String(error?.code ?? "generation_failed"),
    phase: text ? "mid_stream" : "before_first_token",
    partial: text,
    retryable: retryableStreamFailure(error),
  };
}

export function endFailedStream(res, logger, failure) {
  if (!res.destroyed) {
    sseJson(res, { error: failure });
    res.write("data: [DONE]\n\n");
  }
  logger.warn?.(
    `[modelduck] OpenAI stream failed: ${failure.message} ` +
      `(code ${failure.code}, phase ${failure.phase}, partial ${failure.partial.length} chars, ` +
      `retryable ${failure.retryable})`,
  );
}

function contentText(content, role) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  throw new AppError(`Invalid content for ${role}`, {
    code: "invalid_request_error",
    why: "OpenAI-compatible messages must contain a string, or an array of text parts.",
    fix: "Send message content as plain text.",
  });
}

function openAiError(res, status, message, { type = "invalid_request_error", code = null } = {}) {
  sendJson(res, status, {
    error: {
      message,
      type,
      param: null,
      code,
    },
  });
}

function toMessages(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError("messages is required", {
      code: "invalid_request_error",
      why: "The OpenAI-compatible endpoint needs a non-empty messages array.",
      fix: "Send at least one user message.",
    });
  }

  const messages = [];
  const systemParts = [];
  for (const item of body.messages) {
    const role = item?.role;
    if (role === "system" || role === "developer") {
      systemParts.push(contentText(item.content, role));
    } else if (role === "user" || role === "assistant") {
      const content = contentText(item.content, role);
      if (content.trim()) messages.push({ role, content });
    }
  }
  if (!messages.length || messages.at(-1).role !== "user") {
    throw new AppError("The last message must be from the user", {
      code: "invalid_request_error",
      why: "OpenAI-compatible chat needs a user message at the end.",
      fix: "Add a user message and try again.",
    });
  }
  return { messages, systemPrompt: systemParts.join("\n\n") };
}

function toPrompt(body) {
  const prompt = body.prompt;
  if (typeof prompt === "string" && prompt.trim()) return prompt;
  if (Array.isArray(prompt) && prompt.length === 1 && typeof prompt[0] === "string") {
    return prompt[0];
  }
  throw new AppError("prompt is required", {
    code: "invalid_request_error",
    why: "The completion endpoint needs one non-empty text prompt.",
    fix: "Send prompt as a single string, or an array containing one string.",
  });
}

function normalizeStop(value) {
  if (typeof value === "string" && value) return [value];
  if (Array.isArray(value)) {
    const kept = value.filter((item) => typeof item === "string" && item).slice(0, 8);
    return kept.length ? kept : null;
  }
  return null;
}

function optionsFrom(body, settings) {
  return {
    temperature: body.temperature ?? settings.temperature,
    topP: body.top_p ?? settings.topP,
    topK: body.top_k ?? settings.topK,
    minP: body.min_p ?? settings.minP,
    repeatPenalty: body.repeat_penalty ?? settings.repeatPenalty,
    penalizeNewLine: settings.penalizeNewLine,
    dryStrength: settings.dryStrength,
    dryBase: settings.dryBase,
    dryAllowedLength: settings.dryAllowedLength,
    responsePrefix: settings.responsePrefix,
    customStopTriggers: normalizeStop(body.stop) ?? settings.customStopTriggers,
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? settings.maxTokens,
    contextSize: settings.contextSize,
    threads: settings.threads,
    systemPrompt: settings.systemPrompt,
    seed: body.seed ?? settings.seed,
    structuredOutput: settings.structuredOutput,
    jsonSchema: settings.jsonSchema,
    contextOverflow: settings.contextOverflow,
    reasoning: settings.reasoning,
    promptRepeat: settings.promptRepeat,
  };
}

function usage(stats) {
  const prompt = Number(stats?.promptTokens) || 0;
  const completion = Number(stats?.outputTokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function finishReason(stats) {
  return finishReasonFrom(stats?.stopReason);
}

/** IDEA-1085: one finish taxonomy for every /v1 surface. */
export function finishReasonFrom(stopReason) {
  if (stopReason === "maxTokens") return "length";
  return "stop";
}

/** IDEA-1264: never silently fake an unsupported parameter. */
export function rejectedParam(body) {
  if (!body || typeof body !== "object") return null;
  if (Object.hasOwn(body, "logit_bias")) return "logit_bias";
  if (body.tools !== undefined || body.tool_choice !== undefined) return "tools";
  if (body.functions !== undefined || body.function_call !== undefined) return "functions";
  return null;
}

async function ensureReady({ engine, jit, body, res }) {
  if (!engine) {
    openAiError(res, 503, "The inference engine is not ready.", {
      type: "server_error",
      code: "engine_unavailable",
    });
    return null;
  }
  let current = await engine.status();
  if (current.status !== "ready" && jit) {
    try {
      await jit.ensure(body.model);
      current = await engine.status();
    } catch (error) {
      openAiError(res, error.status ?? 409, error.message, {
        type: "model_not_loaded",
        code: error.code ?? "model_not_loaded",
      });
      return null;
    }
  }
  if (current.status !== "ready") {
    openAiError(res, 409, "No model is loaded. Load a model in ModelDuck first.", {
      type: "model_not_loaded",
      code: "model_not_loaded",
    });
    return null;
  }
  jit?.touch();
  return current;
}

async function handleCompletions({ res, body, prompt, engine, current, settings, logger, jit }) {
  const conversationId = `openai-${randomUUID()}`;
  const requestSettings = { ...optionsFrom(body, settings.value), promptRepeat: 1 };
  const id = `cmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = current.model?.id ?? "modelduck";
  const stream = body.stream === true;

  if (!stream) {
    try {
      const result = await engine.complete({
        conversationId,
        prompt,
        settings: requestSettings,
        onToken: () => {},
      });
      sendJson(res, 200, {
        id,
        object: "text_completion",
        created,
        model: modelId,
        system_fingerprint: result.manifest?.shortDigest ?? null,
        choices: [
          {
            text: result.text,
            index: 0,
            logprobs: null,
            finish_reason: finishReason(result.stats),
          },
        ],
        usage: usage(result.stats),
      });
    } catch (error) {
      logger.warn?.(`[modelduck] OpenAI completion failed: ${error.message}`);
      openAiError(res, error.status ?? 500, error.message, {
        type: "server_error",
        code: error.code ?? "generation_failed",
      });
    } finally {
      jit?.touch();
    }
    return;
  }

  sseStart(res);
  let finished = false;
  const controller = new AbortController();
  res.on("close", () => {
    if (!finished) controller.abort();
  });
  const chunk = (text, reason = null, extra = {}) =>
    sseJson(res, {
      id,
      object: "text_completion",
      created,
      model: modelId,
      system_fingerprint: null,
      choices: [{ text, index: 0, logprobs: null, finish_reason: reason }],
      ...extra,
    });

  // IDEA-1074: accumulate partial output so a mid-stream failure keeps the text the
  // client already rendered instead of discarding it.
  let partial = "";
  try {
    chunk("");
    const result = await engine.complete({
      conversationId,
      prompt,
      settings: requestSettings,
      signal: controller.signal,
      onToken: (text) => {
        partial += text;
        if (!res.destroyed) chunk(text);
      },
    });
    if (!res.destroyed) {
      chunk("", finishReason(result.stats), {
        system_fingerprint: result.manifest?.shortDigest ?? null,
        ...(body.stream_options?.include_usage ? { usage: usage(result.stats) } : {}),
      });
      res.write("data: [DONE]\n\n");
    }
  } catch (error) {
    endFailedStream(res, logger, streamFailure(error, partial));
  } finally {
    finished = true;
    jit?.touch();
    if (!res.destroyed) res.end();
  }
}

function modelObject(model) {
  return {
    id: model.id,
    object: "model",
    created: Math.floor(new Date(model.modifiedAt).getTime() / 1000) || 0,
    owned_by: "modelduck",
    permission: [],
    root: model.id,
    parent: null,
    context_length: model.contextLength,
    name: model.name,
    quant: model.quant,
    size: model.size,
    chat_template_hash: model.chatTemplateHash ?? null,
  };
}

function findModel(registry, id) {
  const models = registry?.listPublic?.() ?? [];
  return (
    models.find((model) => model.id === id) ??
    models.find((model) => model.fileName === id || model.fileName.replace(/\.gguf$/i, "") === id) ??
    null
  );
}

export async function handleOpenAI(
  req,
  res,
  { engine, registry, settings, serverSettings = null, jit = null, tuned = null, logger = console },
) {
  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/v1/models" && req.method === "GET") {
    const models = registry ? registry.listPublic() : [];
    sendJson(res, 200, {
      object: "list",
      data: models.map(modelObject),
    });
    return;
  }

  const modelMatch = url.pathname.match(/^\/v1\/models\/([^/]+)$/);
  if (modelMatch) {
    if (req.method !== "GET") {
      openAiError(res, 405, "Method not allowed", { code: "method_not_allowed" });
      return;
    }
    let id;
    try {
      id = decodeURIComponent(modelMatch[1]);
    } catch {
      id = modelMatch[1];
    }
    const model = findModel(registry, id);
    if (!model) {
      openAiError(res, 404, "Model not found", { code: "model_not_found" });
      return;
    }
    sendJson(res, 200, modelObject(model));
    return;
  }

  const pathname = url.pathname;
  const isChat = pathname === "/v1/chat/completions";
  const isCompletion = pathname === "/v1/completions";
  if (!isChat && !isCompletion) {
    openAiError(res, 404, "Not found", { code: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    openAiError(res, 405, "Method not allowed", { code: "method_not_allowed" });
    return;
  }

  const body = await readJsonBody(req, { limitBytes: 8 * 1024 * 1024 });
  const refused = rejectedParam(body);
  if (refused) {
    openAiError(res, 400, `"${refused}" is not supported by this local server`, {
      code: "unsupported_parameter",
    });
    return;
  }
  const parsed = isChat ? toMessages(body) : { prompt: toPrompt(body) };
  const current = await ensureReady({ engine, jit, body, res });
  if (!current) return;
  // A tuned model's preset for the task (x-modelduck-task header or modelduck_task, default code) becomes the defaults; client values still win.
  let applied = null;
  if (isChat && tuned) {
    const task = String(req.headers["x-modelduck-task"] ?? body.modelduck_task ?? "code");
    try {
      applied = await tuned.resolve(current.model?.id ?? null, task);
    } catch (error) {
      openAiError(res, 400, `${error.why ?? error.message} ${error.fix ?? ""}`.trim(), { code: error.code ?? "invalid_task" });
      return;
    }
  }
  const defaults = { ...settings.value, ...(applied?.settings ?? {}) };
  const requestSettings = optionsFrom(body, defaults);
  if (isCompletion) {
    await handleCompletions({
      res,
      body,
      prompt: parsed.prompt,
      engine,
      current,
      settings,
      logger,
      jit,
    });
    return;
  }
  const { messages, systemPrompt } = parsed;

  const conversationId = `openai-${randomUUID()}`;
  const effectiveSystemPrompt = systemPrompt || defaults.systemPrompt;
  const id = `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = current.model?.id ?? "modelduck";
  const stream = body.stream === true;

  if (!stream) {
    try {
      const result = await engine.chat({
        conversationId,
        messages,
        systemPrompt: effectiveSystemPrompt,
        settings: requestSettings,
        onToken: () => {},
      });
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: modelId,
        system_fingerprint: result.manifest?.shortDigest ?? null,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.text },
            logprobs: null,
            finish_reason: finishReasonFrom(result.stats?.stopReason),
          },
        ],
        usage: usage(result.stats),
      });
    } catch (error) {
      logger.warn?.(`[modelduck] OpenAI request failed: ${error.message}`);
      openAiError(res, error.status ?? 500, error.message, {
        type: "server_error",
        code: error.code ?? "generation_failed",
      });
    } finally {
      engine.dropSession(conversationId);
      jit?.touch();
    }
    return;
  }

  sseStart(res);
  let finished = false;
  const controller = new AbortController();
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  const chunk = (delta, finishReason = null, extra = {}) =>
    sseJson(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      system_fingerprint: null,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
      ...extra,
    });

  // IDEA-1074: accumulate partial output so a mid-stream failure keeps the text the
  // client already rendered instead of discarding it.
  let partial = "";
  try {
    chunk({ role: "assistant", content: "" });
    const result = await engine.chat({
      conversationId,
      messages,
      systemPrompt: effectiveSystemPrompt,
      settings: requestSettings,
      signal: controller.signal,
      onToken: (text) => {
        partial += text;
        if (!res.destroyed) chunk({ content: text });
      },
    });
    if (!res.destroyed) {
      chunk(
        {},
        finishReasonFrom(result.stats?.stopReason),
        {
          system_fingerprint: result.manifest?.shortDigest ?? null,
          ...(body.stream_options?.include_usage ? { usage: usage(result.stats) } : {}),
        },
      );
      res.write("data: [DONE]\n\n");
    }
  } catch (error) {
    endFailedStream(res, logger, streamFailure(error, partial));
  } finally {
    finished = true;
    engine.dropSession(conversationId);
    jit?.touch();
    if (!res.destroyed) res.end();
  }
}
