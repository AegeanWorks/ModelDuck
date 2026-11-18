/**
 * IDEA-0997: the thinking pipeline.
 *
 * Reasoning models (DeepSeek-R1 and Qwen3 families, among others) write their
 * working inside a leading `<think>...</think>` block before the answer. Left
 * in the reply, that block pollutes `content` for any client that expects only
 * the answer. This module separates the two, whole or token by token.
 *
 * Only a block that opens the reply (after optional whitespace) counts; a
 * `<think>` later in the text is ordinary text, so a model explaining the tag
 * is never rewritten. A block the token limit cut off is all reasoning.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest proper prefix of `tag` that `text` ends with. */
function partialTagSuffix(text, tag) {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/** @typedef {{kind: "reasoning" | "content", text: string}} ThinkPart */

export class ThinkSplitter {
  #state = "start";
  #buf = "";
  #reasoningStarted = false;
  #contentStarted = false;

  /** @returns {ThinkPart[]} the parts that are now certain; the rest waits. */
  push(text) {
    this.#buf += text;
    const parts = [];
    for (;;) {
      if (this.#state === "start") {
        const lead = this.#buf.trimStart();
        if (lead === "" || (lead.length < OPEN.length && OPEN.startsWith(lead))) return parts;
        if (lead.startsWith(OPEN)) {
          this.#state = "think";
          this.#buf = lead.slice(OPEN.length);
          continue;
        }
        this.#state = "answer";
        this.#contentStarted = true;
        parts.push({ kind: "content", text: this.#buf });
        this.#buf = "";
        return parts;
      }
      if (this.#state === "think") {
        const close = this.#buf.indexOf(CLOSE);
        if (close !== -1) {
          this.#emitReasoning(parts, this.#buf.slice(0, close), true);
          this.#buf = this.#buf.slice(close + CLOSE.length);
          this.#state = "answer";
          continue;
        }
        const cut = this.#buf.length - partialTagSuffix(this.#buf, CLOSE);
        const safe = this.#buf.slice(0, cut).trimEnd();
        this.#emitReasoning(parts, safe, false);
        this.#buf = this.#buf.slice(safe.length);
        return parts;
      }
      // answer: nothing to hold back, only the gap after the block is trimmed.
      const out = this.#contentStarted ? this.#buf : this.#buf.trimStart();
      this.#buf = "";
      if (out) {
        this.#contentStarted = true;
        parts.push({ kind: "content", text: out });
      }
      return parts;
    }
  }

  /** @returns {ThinkPart[]} whatever was held back when the stream ended. */
  flush() {
    const parts = [];
    if (this.#state === "start") {
      if (this.#buf) parts.push({ kind: "content", text: this.#buf });
    } else if (this.#state === "think") {
      this.#emitReasoning(parts, this.#buf, true);
    }
    this.#buf = "";
    return parts;
  }

  #emitReasoning(parts, text, final) {
    const out = this.#reasoningStarted ? text : text.trimStart();
    const emitted = final ? out.trimEnd() : out;
    if (!emitted) return;
    this.#reasoningStarted = true;
    parts.push({ kind: "reasoning", text: emitted });
  }
}

/** Split a finished reply into its thinking and its answer. */
export function splitThinking(text) {
  const splitter = new ThinkSplitter();
  const result = { reasoning: "", content: "" };
  for (const part of [...splitter.push(String(text ?? "")), ...splitter.flush()]) {
    result[part.kind] += part.text;
  }
  return result;
}
