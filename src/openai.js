import { randomUUID } from "node:crypto";

import { AppError } from "./errors.js";
import { assertJsonSchemaSupported } from "./engine.js";
import { readJsonBody, sendJson, sseStart } from "./http.js";
import { ThinkSplitter, splitThinking } from "./thinking.js";

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
      .map((part) => {
        if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") {
          // Refuse instead of dropping: a dropped image part used to become an
          // empty message and the misleading "last message must be from the user".
          throw new AppError(`Unsupported content for ${role}`, {
            code: "invalid_request_error",
            why: `This server reads text parts only; the ${role} message contains a non-text part.`,
            fix: "Remove image, audio or other non-text parts; ModelDuck has no vision or audio input.",
          });
        }
        return part.text;
      })
      .join("");
  }
  throw new AppError(`Invalid content for ${role}`, {
    code: "invalid_request_error",
    why: "OpenAI-compatible messages must contain a string, or an array of text parts.",
    fix: "Send message content as plain text.",
  });
}

function openAiError(res, status, message, { type = "invalid_request_error", code = null, param = null } = {}) {
  sendJson(res, status, {
    error: {
      message,
      type,
      param,
      code,
    },
  });
}

/** A refusal the client can fix keeps OpenAI's invalid_request_error shape. */
function errorTypeFor(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 ? "invalid_request_error" : "server_error";
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

const RESPONSE_FORMAT_SCHEMA_MAX = 12000;

/**
 * IDEA-0859: an OpenAI request's response_format becomes that request's
 * structured-output grammar. Returns null when the request names no format, so
 * the saved settings still decide. A client-supplied schema is refused before
 * the engine sees it or a model is loaded.
 */
export function responseFormatSettings(body) {
  if (!body || typeof body !== "object" || body.response_format === undefined) return null;
  const format = body.response_format;
  const type = format && typeof format === "object" ? format.type : null;
  if (type === "text") return { structuredOutput: "none", jsonSchema: "" };
  if (type === "json_object") return { structuredOutput: "json_object", jsonSchema: "" };
  if (type === "json_schema") {
    const schema = format.json_schema?.schema;
    assertJsonSchemaSupported(schema);
    const jsonSchema = JSON.stringify(schema);
    if (jsonSchema.length > RESPONSE_FORMAT_SCHEMA_MAX) {
      throw new AppError("The JSON schema is too large", {
        code: "invalid_response_format",
        status: 400,
        why: `response_format carries a ${jsonSchema.length}-character schema; this server accepts up to ${RESPONSE_FORMAT_SCHEMA_MAX}.`,
        fix: "Send a smaller schema, or use response_format type json_object.",
      });
    }
    return { structuredOutput: "json_schema", jsonSchema };
  }
  throw new AppError("response_format is not supported", {
    code: "invalid_response_format",
    status: 400,
    why: `"${type ?? ""}" is not a response_format this server can produce.`,
    fix: 'Send {"type":"text"}, {"type":"json_object"} or {"type":"json_schema","json_schema":{"schema":{...}}}.',
  });
}

function optionsFrom(body, settings) {
  const format = responseFormatSettings(body);
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
    structuredOutput: format ? format.structuredOutput : settings.structuredOutput,
    jsonSchema: format ? format.jsonSchema : settings.jsonSchema,
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
const UNSUPPORTED_PARAM_RULES = Object.freeze([
  {
    param: "logit_bias",
    used: (body) => Object.hasOwn(body, "logit_bias"),
    why: "This server cannot apply a logit bias.",
    fix: "Remove logit_bias from the request.",
  },
  {
    param: "tools",
    used: (body) => body.tools !== undefined || body.tool_choice !== undefined,
    why: "This server has no tool calling.",
    fix: "Remove tools and tool_choice from the request.",
  },
  {
    param: "functions",
    used: (body) => body.functions !== undefined || body.function_call !== undefined,
    why: "This server has no function calling.",
    fix: "Remove functions and function_call from the request.",
  },
  {
    param: "n",
    used: (body) => body.n !== undefined && Number(body.n) !== 1,
    why: "This server returns one choice per request.",
    fix: "Send n=1 or omit it.",
  },
  {
    param: "best_of",
    used: (body) => body.best_of !== undefined && Number(body.best_of) !== 1,
    why: "This server returns one choice per request.",
    fix: "Send best_of=1 or omit it.",
  },
  {
    param: "presence_penalty",
    used: (body) => body.presence_penalty !== undefined && Number(body.presence_penalty) !== 0,
    why: "This server has no presence penalty.",
    fix: "Send presence_penalty=0 or omit it.",
  },
  {
    param: "frequency_penalty",
    used: (body) => body.frequency_penalty !== undefined && Number(body.frequency_penalty) !== 0,
    why: "This server has no frequency penalty.",
    fix: "Send frequency_penalty=0 or omit it.",
  },
  {
    param: "logprobs",
    used: (body) => Boolean(body.logprobs),
    why: "This server does not return token probabilities.",
    fix: "Remove logprobs or send false.",
  },
  {
    param: "top_logprobs",
    used: (body) => body.top_logprobs !== undefined,
    why: "This server does not return token probabilities.",
    fix: "Remove top_logprobs from the request.",
  },
  {
    param: "echo",
    used: (body) => Boolean(body.echo),
    why: "This server does not echo the prompt.",
    fix: "Remove echo or send false.",
  },
  {
    param: "suffix",
    used: (body) => typeof body.suffix === "string" && body.suffix.length > 0,
    why: "This server does not fill in a suffix.",
    fix: "Remove suffix from the request.",
  },
  {
    param: "audio",
    used: (body) => body.audio !== undefined,
    why: "This server returns text only.",
    fix: "Remove audio from the request.",
  },
  {
    param: "modalities",
    used: (body) =>
      Array.isArray(body.modalities) && !(body.modalities.length === 1 && body.modalities[0] === "text"),
    why: "This server returns text only.",
    fix: 'Send modalities ["text"] or omit it.',
  },
  {
    param: "prediction",
    used: (body) => body.prediction !== undefined,
    why: "This server has no predicted-output support.",
    fix: "Remove prediction from the request.",
  },
]);

/** The refusal for the first parameter this server cannot honour, or null. */
export function rejectedParamDetail(body) {
  if (!body || typeof body !== "object") return null;
  for (const rule of UNSUPPORTED_PARAM_RULES) {
    if (rule.used(body)) return { param: rule.param, why: rule.why, fix: rule.fix };
  }
  return null;
}

export function rejectedParam(body) {
  return rejectedParamDetail(body)?.param ?? null;
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

async function handleCompletions({ res, body, prompt, engine, current, requestSettings, logger, jit }) {
  const conversationId = `openai-${randomUUID()}`;
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
        type: errorTypeFor(error),
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

  // The body reader refuses invalid JSON and oversized bodies; those refusals
  // keep this route's OpenAI error shape, not ModelDuck's UI error JSON.
  let body;
  try {
    body = await readJsonBody(req, { limitBytes: 8 * 1024 * 1024 });
  } catch (error) {
    openAiError(res, error.status ?? 400, `${error.why ?? error.message} ${error.fix ?? ""}`.trim(), {
      code: error.code ?? "invalid_request_error",
    });
    return;
  }
  const refused = rejectedParamDetail(body);
  if (refused) {
    openAiError(res, 400, `${refused.why} ${refused.fix}`.trim(), {
      code: "unsupported_parameter",
      param: refused.param,
    });
    return;
  }
  // IDEA-0859: refuse a bad response_format before a model is loaded or a
  // session is created; a good one becomes this request's grammar below.
  try {
    responseFormatSettings(body);
  } catch (error) {
    openAiError(res, error.status ?? 400, `${error.why ?? error.message} ${error.fix ?? ""}`.trim(), {
      code: error.code ?? "invalid_response_format",
    });
    return;
  }
  // A refusal in the body keeps the OpenAI error shape, not ModelDuck's UI
  // error JSON: clients test error.type, and the status must stay 400.
  let parsed;
  try {
    parsed = isChat ? toMessages(body) : { prompt: toPrompt(body) };
  } catch (error) {
    openAiError(res, error.status ?? 400, `${error.why ?? error.message} ${error.fix ?? ""}`.trim(), {
      code: error.code ?? "invalid_request_error",
    });
    return;
  }
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
      requestSettings: { ...requestSettings, promptRepeat: 1 },
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
      // IDEA-0997: a reasoning model's <think> block is reported apart from the answer.
      const { reasoning, content } = splitThinking(result.text);
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: modelId,
        system_fingerprint: result.manifest?.shortDigest ?? null,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            logprobs: null,
            finish_reason: finishReasonFrom(result.stats?.stopReason),
          },
        ],
        usage: usage(result.stats),
      });
    } catch (error) {
      logger.warn?.(`[modelduck] OpenAI request failed: ${error.message}`);
      openAiError(res, error.status ?? 500, error.message, {
        type: errorTypeFor(error),
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
  const thinking = new ThinkSplitter();
  const sendParts = (parts) => {
    for (const part of parts) {
      if (part.kind === "content") partial += part.text;
      if (!res.destroyed) {
        chunk(part.kind === "content" ? { content: part.text } : { reasoning_content: part.text });
      }
    }
  };
  try {
    chunk({ role: "assistant", content: "" });
    const result = await engine.chat({
      conversationId,
      messages,
      systemPrompt: effectiveSystemPrompt,
      settings: requestSettings,
      signal: controller.signal,
      onToken: (text) => sendParts(thinking.push(text)),
    });
    sendParts(thinking.flush());
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
