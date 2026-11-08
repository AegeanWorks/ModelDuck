# ModelDuck implicit state machines

Written 2026-11-08 from the source at `818e0c7`, then re-read line by line for
this list. Scope: the server (`src/`), the tuner/benchmark harness
(`benchmarks/`, `src/tune-*`, `src/benchmark-runner.js`) and the control panel
(`public/app.js`). "Implicit" means the states are string literals or boolean
clusters re-typed at each use site, with no single definition and often no
legal-transition check.

The three machines that now live in `src/state-machine.js` are marked
**explicit**. The rest are candidates for the same treatment.

`docs/state-machines.json` is the canonical, agent-readable copy of this table.
`tests/state-machine-coverage.test.js` checks that every entry names a real
file and anchor, that the explicit entries match the runtime catalog, and that
every status written by the adopted modules is a machine state.

## Inventory

| # | Machine | Where state lives | States | Kind |
|---|---|---|---|---|
| 1 | Engine phase | `LlamaEngine.#state.status`, `#loading`, `#unloading` (`src/engine.js:222-263`) | idle, loading, ready, error, unloading | **explicit** (`ENGINE_MACHINE`) |
| 2 | Engine load cancel epoch | `#loadEpoch` (`src/engine.js:247`, `:266-281`) | live, canceled | implicit integer |
| 3 | Engine context attempt ladder | `#context`, `attempt` loop (`src/engine.js:598-630`) | unallocated, trying, allocated, exhausted | implicit list |
| 4 | JIT model tracking | `JitManager.#trackedId`, `#timer` (`src/jit.js:20-39`) | untracked, tracked-idle-armed, tracked-model-gone, disabled | implicit |
| 5 | Download job | `job.status`, `job.stalled`, `job.controller` (`src/downloader.js:156-175`) | queued, downloading, complete, canceled, error | **explicit** (`DOWNLOAD_MACHINE`) |
| 6 | Download start reservation | `#starting` (`src/downloader.js:50-54`) | free, starting | implicit set |
| 7 | Registry scan cache | `lastScanAt`, `lastDirStamp`, `entries` (`src/model-registry.js:227-231`) | cold, fresh, stale | implicit timestamps |
| 8 | Registry import copy | `suffix` counter (`src/model-registry.js:386-398`) | copying, imported, renamed(n), blocked/missing | implicit |
| 9 | Tune stage progress | `state.<stage>.status`, `done[]`, `sampledWith` (`benchmarks/tune.mjs:66-70`, `:527-545`) | pending, partial, done | implicit literals |
| 10 | Tune queue and job | `#job.status`, `job.paused`, `items[].status` (`src/tune-scheduler.js:81-101`) | running, paused(boll), guarded, cancelled, complete, failed; item queued/running/done/skipped/failed/cancelled | implicit |
| 11 | Tune run record | `record.outcome` (`src/tune-runs.js:55-116`) | running, done, stopped, failed, interrupted(derived) | implicit |
| 12 | Timing lock and registration | files `active-<pid>`, `paused-<pid>`, `timing.lock` (`src/tune-lock.js:25-122`) | unregistered, registered, paused, lock-holder, settled/unsettled | implicit files |
| 13 | Benchmark job | `#job.status`, `job.cancelling` (`src/benchmark-runner.js:104-168`) | running, complete, cancelled, failed | **explicit** (`BENCHMARK_MACHINE`) |
| 14 | Measurement budget | `Measurements.stopped` (`benchmarks/tune-measure.mjs:45-58`) | open, stopped(reason) | implicit |
| 15 | UI dialogs and views | `dialog.open`, `.tab.active`, `hidden` (`public/app.js:934-951`) | closed/open per dialog, Discover/Installed | implicit DOM |
| 16 | Settings form | `state.settings` snapshot vs DOM inputs (`public/app.js:326`, `:1180`) | clean, dirty | implicit (now `state.settingsDirty`) |
| 17 | Server-settings form | `serverSettingsLoading`, error.hidden, save.disabled (`public/app.js:1279-1305`) | loading, ready, failed | implicit booleans |
| 18 | Server exposure | `requireAuth`, `serveOnLocalNetwork`, `enableCors` (`src/server-settings.js:25-63`) | local, LAN, CORS, invalid | implicit booleans |
| 19 | Restart required | none (server replied `true`; client used a toast) (`src/server.js:817-823`) | pending, applied | implicit (now explicit API field) |
| 20 | API-key lifecycle | `#keys[]`, session key, key-output visibility (`src/server-settings.js:90-166`) | none, revealed, stored, revoked | implicit |
| 21 | Download poller | `pollTimer`, `polling`, `completedDownloads` (`public/app.js:337-352`, `:783-831`) | stopped, polling, failing | implicit |
| 22 | Benchmark poller | `benchmarkTimer`, `benchmarkPolling` (`public/app.js:340-342`, `:1838`) | stopped, running, terminal | implicit |
| 23 | Tune follower | `tuneTimer`, `tuneStream`, `tunePolling` (`public/app.js:344-347`, `:3004`) | SSE, polling, stopped | implicit |
| 24 | Confirm dialog | `confirm-dialog.open`, `confirmQueue` (`public/app.js:3370-3406`) | idle, asking | implicit (now serialized) |
| 25 | Serving tuned settings | `useTunedProfile`, `speedPreset`, `stale`, `deviceParts` (`src/tuned-settings.js:35-42`) | tuned, stale, none | implicit literals |

## Verified defects (severity after re-reading the code)

1. **Engine could stay `loading` forever** (high). `#loading = true` was set
   before the `try`, and `await this.unload()` ran outside it
   (`src/engine.js:534-540` pre-fix). A throw there never reached the
   `finally` that clears `#loading`, so every later load got 409
   `model_loading`. Fixed by moving the whole opening into the `try` and
   asserting the phase machine.
2. **Engine could stay `unloading`** (high). A teardown throw skipped the
   `idle` write while the `finally` cleared only `#unloading`
   (`src/engine.js:683-693` pre-fix). Now a teardown throw moves the phase to
   `error` through the machine and rethrows.
3. **A canceled download could be marked complete** (medium). The success
   path wrote `complete` after hashing/promotion with no status re-check
   (`src/downloader.js:422` pre-fix); `cancel()` is terminal. Now a cancel
   before promotion returns, and `moveTo` refuses terminal rewrites.
4. **Two concurrent starts could share one `.part`** (high). The duplicate and
   limit checks were followed by `await stat` (`src/downloader.js:87-105`
   pre-fix), so both requests passed the check. A synchronous `#starting`
   reservation now covers the await.
5. **A created API key was erased before it could be copied** (high, UX).
   `createServerKey` revealed the key and then called `openServerSettings`,
   which cleared the reveal (`public/app.js:3188-3191`). Refresh now takes
   `{ keepKey: true }`, and close still clears it.
6. **Closing the settings dialog silently discarded edits** (medium). No
   dirty state existed; Ctrl+, re-seeded the form over an open edit
   (`public/app.js:1180-1226`). Now edits are marked, close/backdrop/Esc ask
   first, and an open dialog is never re-seeded.
7. **A second confirm could resolve the first caller's promise on the wrong
   button** (medium). `askConfirm` overwrote `onclick`/`onclose`
   (`public/app.js:3370-3392` pre-fix). Confirms are now serialized through a
   queue.
8. **Pollers could hang or die silently** (medium). A rejected download poll
   kept its interval forever with no message; benchmark and tune polls could
   stack requests and stopped silently on one failure (`public/app.js:806`,
   `:1811`, `:2925` pre-fix). Polls now have timeouts, in-flight guards, a
   three-failure stop for downloads, and a visible reconnect message.
9. **Restart-required was a toast** (low/medium). The server always returned
   `restartRequired: true`; the client ignored it and diffed two settings.
   The server now compares the saved listener with the running instance, and
   the dialog keeps a standing note.
10. **LAN/CORS could be saved without auth, then rejected** (low/medium). The
    server refused correctly, but the invalid combination stayed on screen.
    The two switches are now disabled and cleared unless auth is on.
11. **JIT tracking state was invisible** (low, AX). `#trackedId` and the
    idle-unload timer are now in `GET /api/health`, together with the engine
    phase, registry scan counters and the machine catalog.
12. **Engine teardown leaked `fit`/`contextFallback`** (low). The reset object
    omitted both, so an idle/loading payload could show the previous load's
    verdict. Both are now cleared.

## Checked and not defects

- `canceled → error` in the downloader: the catch already excludes a
  `canceled` status from the stall branch, so a cancel wins (verified at
  `src/downloader.js:427` pre-fix).
- `unloading` is a real phase but the UI renders only ready/loading/error.
  That is a display gap, not an invalid transition; deferred to a UI polish
  pass rather than changing the phase vocabulary.

## Deferred (larger or riskier)

- Tune stage `skipped`/`failed`/`interrupted` states, and a `cancelled` run
  outcome: they need a profile/run-schema migration and UI work.
- A real UI view router (`aria-current` is currently static on Overview).
- Registry scan generation counter and delete-stamp invalidation.
- Benchmark/tune job persistence across a restart.
