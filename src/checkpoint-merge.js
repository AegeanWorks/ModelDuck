/**
 * Toy qwenFS -> ModelDuck checkpoint-merge math (offline analysis only, no runtime use).
 *
 * Mirrors the qwenFS mechanism:
 * - `qfs/merge.py`: widen residual width 2048 -> 3072 by zero-pad, rescale norm
 *   gains by sqrt(2048/3072), place FS layers front and append vocab rows.
 * - `qfs/circuit.py`: ballast plus padded-rails construction that keeps the
 *   widened residual norm-equivalent to the narrow source.
 * - `qfs/disk.py`: offline checkpoint layout the toy shapes imitate (no reads here).
 * - qwenFS limits: at most 32 scripted sessions, no search/retrieval.
 *
 * ModelDuck scope (why this file stays a toy):
 * - `src/engine.js`: fixed-shape runtime (`MAX_SESSIONS = 1`,
 *   `RUNTIME_OPTIONS = { build: "never" }`, threads clamped to 64). No runtime widen.
 * - `src/model-registry.js`: GGUF-only ingest (`.gguf` suffix + magic, line 11).
 *   No safetensors ingest, no model download, no retraining in this file.
 * - `src/gguf-guard.js`: header guard runs before any parse; this module parses nothing.
 * - `src/memory-fit.js`: KV-only memory math; this module allocates no KV cache.
 * - `src/generation-manifest.js` `digest()` (lines 12-13) is reused by the test
 *   for seeded scripted-session digests, not for serving.
 * - `benchmarks/run.mjs` `UNSUPPORTED`: benchmark matrix is untouched.
 * - `benchmarks/test-hash.mjs:10-51` and `benchmarks/tune-baseline.mjs:16`
 *   (`IDENTITY_KEYS`) are untouched, so the suite/test hash does not move.
 *
 * Production widened serve is REJECTED on record: GGUF-only ingest plus the
 * fixed-shape runtime cannot serve a widened 3072-wide model; this file only
 * proves the shapes and the norm-equivalence on toy arrays.
 */

/** Source residual width mirrored from `qfs/merge.py`. */
export const QFS_SOURCE_DIM = 2048;

/** Target residual width mirrored from `qfs/merge.py` (zero-pad 2048 -> 3072). */
export const QFS_TARGET_DIM = 3072;

/**
 * Norm-gain scale mirrored from `qfs/merge.py`: gains are multiplied by
 * sqrt(2048/3072) so RMSNorm output magnitude is preserved after widening.
 */
export const QFS_NORM_GAIN_SCALE = Math.sqrt(QFS_SOURCE_DIM / QFS_TARGET_DIM);

/** qwenFS scripted-session limit mirrored for the toy session digests (max 32, no search). */
export const QFS_MAX_SESSIONS = 32;

function assertMatrix(value, name) {
  if (!Array.isArray(value) || value.length === 0 || !Array.isArray(value[0])) {
    throw new TypeError(`${name} must be a non-empty 2D array`);
  }
  const cols = value[0].length;
  if (!Number.isInteger(cols) || cols <= 0) throw new TypeError(`${name} rows must be non-empty`);
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== cols) {
      throw new TypeError(`${name} must be rectangular (all rows length ${cols})`);
    }
    for (const cell of row) {
      if (typeof cell !== "number" || !Number.isFinite(cell)) {
        throw new TypeError(`${name} must contain only finite numbers`);
      }
    }
  }
  return cols;
}

/**
 * Widen a residual matrix 2048 -> `k` by zero-padding columns.
 * @param {number[][]} W source rows x 2048.
 * @param {number} [k=3072] target width, must exceed the source width.
 * @returns {number[][]} new rows x `k` matrix; input is not mutated.
 */
export function widenResidual(W, k = QFS_TARGET_DIM) {
  const src = assertMatrix(W, "W");
  if (!Number.isInteger(k) || k <= src) {
    throw new RangeError(`k must be an integer wider than the source width ${src}`);
  }
  return W.map((row) => [...row, ...new Array(k - src).fill(0)]);
}

/**
 * Append `n` zero vocab rows (FS vocab append).
 * @param {number[][]} E vocab rows x dim.
 * @param {number} n extra rows, integer >= 0.
 * @returns {number[][]} new (V + n) x dim matrix; input is not mutated.
 */
export function appendVocab(E, n) {
  const dim = assertMatrix(E, "E");
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be an integer >= 0");
  const tail = Array.from({ length: n }, () => new Array(dim).fill(0));
  return [...E.map((row) => [...row]), ...tail];
}

/**
 * Rescale norm gains by `gainScale` (default sqrt(2048/3072)).
 * @param {number[]} gain per-channel gains.
 * @param {number} [gainScale=QFS_NORM_GAIN_SCALE] finite scale factor.
 * @returns {number[]} new scaled gains; input is not mutated.
 */
export function rescaleNorm(gain, gainScale = QFS_NORM_GAIN_SCALE) {
  if (!Array.isArray(gain) || gain.length === 0) {
    throw new TypeError("gain must be a non-empty array");
  }
  if (typeof gainScale !== "number" || !Number.isFinite(gainScale) || gainScale <= 0) {
    throw new RangeError("gainScale must be a finite number > 0");
  }
  return gain.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("gain must contain only finite numbers");
    }
    return value * gainScale;
  });
}
