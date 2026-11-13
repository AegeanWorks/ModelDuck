/**
 * Why an answer failed, in one word, so a tune can say which lever is worth
 * pulling. Measured on Qwen2.5 Coder 1.5B (600 failing code answers): about
 * 78% were runnable code with wrong results, 10% threw, 5% hit the token
 * budget and 3% did not run. Settings can fix a budget or a format; they
 * cannot fix wrong logic, which needs a stronger model or real tests.
 */
export const FAILURE_CLASSES = Object.freeze(["error", "truncated", "empty", "unreadable", "timeout", "crash", "threw", "wrong"]);

const HAS = (evaluation, text) => (evaluation?.checks ?? []).some((check) => !check.passed && String(check.detail ?? "").includes(text));

/**
 * The class of one answer, the cause before the symptom: an answer cut off by
 * the token budget is "truncated" even though its code then fails to run.
 * Null when every check passed.
 */
export function failureClass({ error = null, text = "", stopReason = null, evaluation = null }) {
  if (error) return "error";
  if (evaluation && evaluation.passed >= evaluation.total) return null;
  if (stopReason === "maxTokens") return "truncated";
  if (!String(text ?? "").trim()) return "empty";
  if (evaluation?.unreadable) return "unreadable";
  if (HAS(evaluation, "timed out")) return "timeout";
  if (HAS(evaluation, "did not run")) return "crash";
  if (HAS(evaluation, "threw")) return "threw";
  return "wrong";
}

/** Failing answers per task and class. Rows without a `failure` field (restored answers) are left out. */
export function summarizeFailures(rows) {
  const summary = {};
  for (const row of rows) {
    if (row.failure === undefined || !row.task) continue;
    const entry = (summary[row.task] ??= { answers: 0, failing: 0, classes: {} });
    entry.answers += 1;
    if (row.failure === null) continue;
    entry.failing += 1;
    entry.classes[row.failure] = (entry.classes[row.failure] ?? 0) + 1;
  }
  return summary;
}

const HINTS = Object.freeze({
  truncated: "raise maxTokens or let the maxTokens axis run",
  unreadable: "the model ignores the requested format: try the systemPrompt axis",
  empty: "the model gives up: try the systemPrompt or reasoning axis",
  timeout: "generated code loops forever",
});

/** One line per task, largest class first, with a hint when a setting can help. */
export function formatFailures(summary) {
  return Object.entries(summary)
    .filter(([, entry]) => entry.failing > 0)
    .map(([task, entry]) => {
      const classes = Object.entries(entry.classes).sort((left, right) => right[1] - left[1]);
      const shares = classes.map(([name, count]) => `${name} ${Math.round((100 * count) / entry.failing)}%`).join(" · ");
      const hints = classes.filter(([name, count]) => HINTS[name] && count / entry.failing >= 0.1).map(([name]) => HINTS[name]);
      const wrongShare = (entry.classes.wrong ?? 0) / entry.failing;
      if (wrongShare >= 0.5) hints.push("most failures are wrong logic, and settings cannot fix wrong logic: a larger or code-tuned model can");
      return `Why ${task} answers failed (${entry.failing} of ${entry.answers}): ${shares}${hints.length ? ` — ${hints.join("; ")}` : ""}`;
    })
    .join("\n");
}
