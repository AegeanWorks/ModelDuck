import { AppError } from "../src/errors.js";

/** One day: a longer budget is almost certainly a typo for seconds or hours. */
export const MAX_BUDGET_MINUTES = 1440;

/** The `--budget` flag in minutes (decimals allowed); absent means no time budget. */
export function parseBudget(value) {
  if (value === undefined || value === null || value === "") return null;
  const minutes = Number(value);
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= MAX_BUDGET_MINUTES) return minutes;
  throw new AppError("--budget needs a number of minutes", {
    code: "tune_budget_invalid",
    why: `"${value}" is not a number of minutes above 0 and up to ${MAX_BUDGET_MINUTES}.`,
    fix: "Pass --budget 5 for five minutes, or --budget 0.5 for thirty seconds. Leave it out for no time limit.",
  });
}

/** When a tune that starts `now` must stop asking; Infinity without a budget. */
export function budgetDeadline(minutes, { now = Date.now() } = {}) {
  return minutes == null ? Infinity : now + minutes * 60_000;
}
