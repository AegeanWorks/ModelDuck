/**
 * IDEA-1087: one deterministic checkpoint plan for the whole runtime.
 *
 * Checkpoint rewind is only useful when checkpoints actually span the context:
 * a fixed 8192-token interval leaves a 16K context mostly uncovered, so the
 * interval scales to `contextSize / max` and stays inside the shared
 * 128..32768 clamp. The checkpoint store is RAM-backed, so the plan also
 * carries a memory budget: 64 MiB by default, 0 = unlimited, never above
 * 256 MiB. The function is pure — no clock, randomness or environment reads —
 * so the same settings always build the same plan.
 */

export const DEFAULT_CHECKPOINT_MEMORY_MB = 64;
export const MAX_CHECKPOINT_MEMORY_MB = 256;

function clampInteger(value, min, max, fallback) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(numeric, max));
}

export function deriveCheckpointPlan({
  contextSize = null,
  checkpoints = true,
  checkpointMax = 32,
  checkpointInterval = 8192,
  checkpointMemoryMb = DEFAULT_CHECKPOINT_MEMORY_MB,
} = {}) {
  const max = clampInteger(checkpointMax, 1, 64, 32);
  const context = Number(contextSize);
  const contextClamped = Number.isFinite(context) && context >= 512 ? Math.round(context) : null;
  // Uniform coverage: `max` checkpoints at `interval` tokens span the context
  // exactly, through the same clamp the settings normalize step applies.
  const interval = contextClamped
    ? clampInteger(Math.ceil(contextClamped / max), 128, 32768, 8192)
    : clampInteger(checkpointInterval, 128, 32768, 8192);
  const rawMemory = checkpointMemoryMb === null || checkpointMemoryMb === undefined
    ? DEFAULT_CHECKPOINT_MEMORY_MB
    : Number(checkpointMemoryMb);
  const clampedMemory = clampInteger(rawMemory, 0, MAX_CHECKPOINT_MEMORY_MB, DEFAULT_CHECKPOINT_MEMORY_MB);
  return {
    enabled: checkpoints !== false,
    max,
    interval,
    // 0 means unlimited, expressed as null so callers can omit the option.
    memoryMb: clampedMemory > 0 ? clampedMemory : null,
  };
}
