import assert from "node:assert/strict";
import test from "node:test";

import {
  QFS_MAX_SESSIONS,
  QFS_NORM_GAIN_SCALE,
  QFS_SOURCE_DIM,
  QFS_TARGET_DIM,
  appendVocab,
  rescaleNorm,
  widenResidual,
} from "../src/checkpoint-merge.js";
import { digest } from "../src/generation-manifest.js";

/** Deterministic toy PRNG (mulberry32) so the session is seeded without any model load. */
function seededValues(seed, count) {
  let state = seed >>> 0;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    out.push(((z ^ (z >>> 14)) >>> 0) / 4294967296 - 0.5);
  }
  return out;
}

function toyMatrix(rows, cols, seed) {
  const values = seededValues(seed, rows * cols);
  return Array.from({ length: rows }, (_, r) => values.slice(r * cols, (r + 1) * cols));
}

test("widenResidual zero-pads 2048 -> 3072 and keeps the source block intact", () => {
  const W = toyMatrix(2, QFS_SOURCE_DIM, 7);
  const snapshot = W.map((row) => [...row]);
  const wide = widenResidual(W, QFS_TARGET_DIM);
  assert.equal(wide.length, 2);
  assert.equal(wide[0].length, QFS_TARGET_DIM);
  for (const [r, row] of wide.entries()) {
    assert.deepEqual(row.slice(0, QFS_SOURCE_DIM), snapshot[r]);
    assert.deepEqual(row.slice(QFS_SOURCE_DIM), new Array(QFS_TARGET_DIM - QFS_SOURCE_DIM).fill(0));
  }
  assert.deepEqual(W, snapshot, "input matrix is not mutated");
});

test("widened residual is norm-equivalent after the sqrt(2048/3072) gain rescale", () => {
  // RMS of a zero-padded vector drops by sqrt(src/tgt); the gain scale restores it.
  const vec = seededValues(11, QFS_SOURCE_DIM);
  const rms = (xs) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
  const padded = [...vec, ...new Array(QFS_TARGET_DIM - QFS_SOURCE_DIM).fill(0)];
  const restored = rms(padded) / rms(vec);
  assert.ok(Math.abs(restored - QFS_NORM_GAIN_SCALE) < 1e-12);
  const gain = [1, 2, 0.5];
  assert.deepEqual(rescaleNorm(gain), gain.map((g) => g * Math.sqrt(2048 / 3072)));
});

test("appendVocab appends zero rows and rescaleNorm validates inputs", () => {
  const E = toyMatrix(4, 8, 21);
  const grown = appendVocab(E, 3);
  assert.deepEqual([grown.length, grown[0].length], [7, 8]);
  assert.deepEqual(grown.slice(0, 4), E);
  for (const row of grown.slice(4)) assert.deepEqual(row, new Array(8).fill(0));
  assert.deepEqual(appendVocab(E, 0).length, 4);
  assert.throws(() => widenResidual([[1, 2], [3]], 4), /rectangular/);
  assert.throws(() => widenResidual([[1, 2]], 2), /wider/);
  assert.throws(() => appendVocab([[1]], -1), /integer/);
  assert.throws(() => rescaleNorm([], 1), /non-empty/);
});

test("seeded scripted-session digests are stable and order-sensitive (toy math only)", () => {
  assert.ok(QFS_MAX_SESSIONS === 32, "qwenFS limit: at most 32 scripted sessions, no search");
  const sessionFor = (seed) => ({
    fingerprintVersion: 1,
    qfs: { src: QFS_SOURCE_DIM, tgt: QFS_TARGET_DIM, fsLayersFront: 2, vocabAppend: 3 },
    steps: seededValues(seed, 8).map((v) => Number(v.toFixed(6))),
  });
  const a = sessionFor(1234);
  const b = sessionFor(1234);
  const c = sessionFor(9999);
  assert.equal(digest(a), digest(b), "same seed -> same digest via generation-manifest digest()");
  assert.notEqual(digest(a), digest(c), "different seed -> different digest");
  assert.match(digest(a), /^[a-f0-9]{64}$/);
  // FS layers front + vocab append ordering is part of the scripted session.
  const ordered = { layers: ["fs-0", "fs-1", "base-0", "base-1"], vocabRows: 4 + 3 };
  assert.deepEqual(ordered.layers.slice(0, 2), ["fs-0", "fs-1"]);
  assert.equal(digest(ordered), digest({ layers: ["fs-0", "fs-1", "base-0", "base-1"], vocabRows: 7 }));
  assert.notEqual(
    digest(ordered),
    digest({ layers: ["base-0", "base-1", "fs-0", "fs-1"], vocabRows: 7 }),
    "FS-front order matters",
  );
});
