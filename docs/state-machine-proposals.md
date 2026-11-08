# State-machine proposals (2026-11-08)

Each proposal is judged on three axes and on "does not break an existing
contract": **UX** (the user sees the truth), **DX** (one vocabulary, legal
transitions checked where they are written), **AX** (the state is readable
through the API or a static catalog). Verified against the code and the test
suite before implementation.

## Passed and implemented

### P1 — One explicit machine module; adopt it at the write sites
**Axes:** DX (one definition, illegal transitions fail loudly), AX (JSON
catalog), UX (bad states become visible errors instead of silent lies).
**Shape:** `src/state-machine.js` defines `engine`, `download` and `benchmark`
with states, legal transitions and terminal states. `benchmarks/tune` and the
UI keep their own domains; the three highest-traffic ones adopt it now.
**Verification:** `tests/state-machine.test.js` pins the catalog, terminal
states, the canceled-download case and an actionable illegal-transition error.
Engine/downloader/benchmark tests still pass with the asserts in place.

### P2 — Download: terminal-state guard + concurrent-start reservation
**Axes:** UX (no canceled job that later says complete), DX (machine is the
guard), AX (status is truthful).
**Verification:** `tests/downloader.test.js` gains the concurrent-start test
(one 409 `download_starting`, one job); all downloader tests pass.

### P3 — Engine: no stuck loading/unloading; phase transitions asserted
**Axes:** UX (a failed start never bricks the Load button), DX (phase machine
is real), AX (`/api/health.phase`).
**Verification:** engine suite passes; the `finally` and teardown error paths
now reach `error`/`idle` through the machine.

### P4 — Created API key stays readable until close
**Axes:** UX (the only chance to copy the key works).
**Verification:** `createServerKey` refreshes with `{ keepKey: true }`;
reopening or closing still clears it. (This was a regression from the previous
transport batch and is now covered by the flow.)

### P5 — Settings form dirty state + guarded close
**Axes:** UX (no silent edit loss), DX (explicit `settingsDirty`).
**Verification:** UI smoke types into the form, sees the unsaved marker, is
asked on close, cancels once, then discards; Ctrl+, no longer re-seeds an open
form.

### P6 — Serialized confirms
**Axes:** UX (nested actions resolve on their own button), DX (queue).
**Verification:** the smoke's discard flow exercises two confirms in sequence.

### P7 — Polling resilience
**Axes:** UX (no frozen "running" view), DX (guards/timeout), AX (clear error).
**Verification:** full suite; UI smoke still follows the Bench flows. Downloads
stop after three failures with a reconnect message; benchmark/tune polls use a
10 s timeout and an in-flight guard.

### P8 — Restart-required is a state, not a toast
**Axes:** UX (persistent note), AX (`restartRequired` in `/api/state` and the
PUT response).
**Verification:** `restartRequiredFor()` unit tests cover same/changed
port and LAN binding; the dialog renders `#server-restart-note`.

### P9 — LAN/CORS only with authentication
**Axes:** UX (no rejected combination left on screen), DX (one guard).
**Verification:** the switches disable and clear when auth is off; the server
still refuses the invalid save.

### P10 — AX: health exposes phase, JIT, registry, machine catalog
**Axes:** AX (agents can read state without the source), DX (single catalog).
**Verification:** `tests/sampler-health.test.js` asserts `phase`, `jit`,
`registry` counters and the machine vocabulary.

## Rejected / deferred (with reasons)

- **Turn tune `paused` into a status.** The scheduler stores `paused` beside
  `status="running"`. A real status would clarify AX, but it changes the API
  and every client; deferred until a scheduler pass with migration.
- **Add tune stage `skipped`/`failed`/`interrupted`.** Higher value but a
  profile-schema and UI change; recorded in `docs/state-machines.md` as
  deferred.
- **Retrofit the UI onto a view router.** The static `aria-current` on
  Overview is a papercut; a router is a redesign, not a state fix.
- **Persist benchmark/tune jobs across restarts.** Needs a supervisor and
  child re-attachment; out of scope for this pass.
- **Registry scan generation counter.** Real race, but the fix touches the
  scan-cache performance work; deferred with the findings recorded.
