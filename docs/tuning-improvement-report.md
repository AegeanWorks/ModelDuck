# Improving ModelDuck's tuner

> **Status note:** this report is a snapshot of commit `6ece836` (2026-11-01). Later work changed the code it describes (see ADR-101 to ADR-121 in `.aikit/decisions.md`). Re-check a finding against current `master` before acting on it.
>
> **Checked on `master` 2026-11-14:** D1 fixed (the continuation measures 102 candidates and finishes every stage). D2 fixed (Light and Quiet threads come from measured steps). D3 fixed (`estimateTune` for the device stage alone gives 46 s, not the full-tune time). D5 fixed (the three `benchmarks/baseline-*.json` files exist). D4 fixed in code (fractional solved counts in `tune-measure.mjs`; the arithmetic at the end of `presets-and-tolerance.mjs` shows the old rule only). M1 partly done (`stopReason` is recorded and classed `truncated`). `penalizeNewLine` joined the search in suite v15. M2 present (`tune-speed.mjs` times candidates 3 times, interleaved, with an A/A tie band). M3 and M4 present in part (`changedItems`, `flippedItems`, `prefillTps` and `decodeTps` are measured and reported). M7 present in part (`vramFitsModel` in `engine.js`). I read these as present from the code only, not by re-running the report's numbers. M5 fixed (the load-stage probe runs with `repeatPenalty: 1`, and the code task starts without it). M8 handled by recording (the timing lock still proceeds after 120 s, but the device record carries `settled`). S5 comprehension leak gone (`suite-usage.mjs`: 0 of 22 held items share a family with tuned items). S7 handled (an `accuracyRecheck` is recorded for the device stage). S3 fixed in tuner v11: saturated rung slots are refilled from the task's unused tuning pool (ADR-125). M9 fixed (the decode rate uses `outputTokens - 1` over the decode interval). M6, S2 and S6 are covered in code. S1 changed the trade-off: re-running `power.mjs` on `master` gives 69.3% for a true +10-point value (was 61.0%), and wrong changes with no true difference are 8.7% (260 of 3,000 runs; was 5.0%), inside the tuner's `changeAlpha` of 0.2. S4 fixed in tuner v11: the sweep's Holm gate is clustered too (ADR-125). G1 to G9 and V1 to V4 are present in code, by reading only: one-seed screening (G1), a pair check (G2), greedy code starts (G3), DRY, `penalizeNewLine` and mixed K/V in the grid (G4), the "show only the answer" directive gone (G5), partial credit (G6), 75/50/25% offloads (G7), a persistent gate answer cache (G8), opt-in multistep chains (G9), hardware in the baseline (V1), statistical tests in `npm test` (V2), `TUNER_VERSION` (V3), and `gpuVram` per answer (V4). V1's hardware note blamed hardware on every regression; fixed on 2026-11-14. No finding is left unchecked. M3, M4 and M7 are present only in part (read from the code, not re-measured), and S1's higher false-change rate is a recorded trade-off (ADR-122).

A review of the settings tuner (**Bench & Tune → Tune**, `npm run tune`, `npm run tune:gate`) with measured
evidence and a prioritized plan.

| | |
|---|---|
| Snapshot | commit `6ece836`, suite v14 (262 items), node-llama-cpp 3.22.2. Line links point at that commit. |
| Date | 2026-11-01 |
| Method | Read every module on the tune path and ADR-021 to ADR-075. Re-ran each suspected defect through the repository's own `tune()`. Ran Monte Carlo studies through the real decision code. Checked the timing and determinism assumptions on the real engine with SmolLM2 135M and Qwen2.5 0.5B (CPU, 4-core Linux container, 3 threads). |
| Reproduce | Every number below comes from a script in [`docs/tuning-repro/`](tuning-repro/). See [Appendix A](#appendix-a-reproduction). |

The real-engine numbers come from a different machine than the one in the ADRs (i5-14400F, Radeon RX 9060 XT), so
read them as evidence that a mechanism exists, not as that PC's exact values. The simulations show how the decision
rules behave, given the stated assumptions about the items.

---

## Contents

1. [Summary](#1-summary)
2. [How a tune works today](#2-how-a-tune-works-today)
3. [Defects](#3-defects): D1 to D5
4. [What is measured vs. what is used](#4-what-is-measured-vs-what-is-used): M1 to M9
5. [Statistics: power, error control, item use](#5-statistics-power-error-control-item-use): S1 to S7
6. [Search strategy and search space](#6-search-strategy-and-search-space): G1 to G9
7. [Validation and governance](#7-validation-and-governance): V1 to V4
8. [Roadmap](#8-roadmap)
9. [How to tell the tuner got better](#9-how-to-tell-the-tuner-got-better)
10. [Follow-up, 2026-11-19: what recorded runs say](#10-follow-up-2026-11-19-what-recorded-runs-say): F1 to F10
- [Appendix A: Reproduction](#appendix-a-reproduction)
- [Appendix B: node-llama-cpp 3.22.2 options checked](#appendix-b-node-llama-cpp-3222-options-checked)

**Severity:** *High* means it changes what a tune chooses or ships in ordinary use; *Medium* means it weakens a
decision or a safeguard; *Low* means accuracy or UX. **Effort:** *S* ≤ 1 day, *M* 2–5 days, *L* 1–2 weeks.
**G-003** marks a change to items, rungs or the sweep, which needs a `SUITE_VERSION` bump, a CHANGELOG row and a
deliberate baseline update.

---

## 1. Summary

The tuner is already careful. It uses paired tests, Holm correction, sequential stopping with alpha spending, a
held-back check, per-type and per-view guards, resumable progress and a full answer log. The next gains come from
four places.

1. **Five defects change what a tune does, silently.** The worst one: a **Quick pass never gets the full search it
   promises**. The "full continuation" re-runs no axis at all. It marks the 12-item choices as final (82 answers
   instead of 516 in a reproduction). Another defect: the **required regression gate (G-001) cannot run**, because
   its baseline file was never created.
2. **The settings users feel most are measured least.**
   - The speed stage gets **0.6%** of a tune's answers.
   - On a real engine, it called *identical* settings "significantly different" in **20%** of comparisons.
   - It rejects most thread and batch candidates because rounding changed an answer's text (**9 of 18** answers
     changed by thread count alone), not because quality dropped.
   - The token budget is tuned as a cost to minimize, and then served as the hard cap on real requests.
3. **Statistical power is low where the answers go.**
   - **96%** of a tune's answers go to sampling and prompt choices.
   - Even so, a value that is truly **10 points better is chosen only 61%** of the time (5 points better: 17%).
   - **53 of the 136 code items (39%) are never used.**
   - Comprehension's "unseen" check reuses the same 8 functions.
   - Clustered items inflate false positives **3–4×**.
4. **The search space misses cheap, relevant knobs, and the starting point works against code.** The repeat
   penalty of 1.1 also penalizes newlines. It is on for every load-stage measurement and for the "defaults"
   baseline. Turning it off fixed 3 code items and broke none on Qwen2.5 0.5B. DRY, `penalizeNewLine`, mixed K/V
   cache types, response prefixes and stop triggers are available in the runtime but are not searched.

### Findings at a glance

| ID | Finding | Evidence | Severity | Effort |
|---|---|---|---|---|
| D1 | Quick pass → "full continuation" re-runs no axis and marks 12-item choices final | 0 search candidates, 82 vs 516 answers | High | S |
| D2 | Light/Quiet thread counts are set by a formula and may never have been measured | 6 and 3 threads from steps {1,2,4,8} | Medium | S |
| D3 | Preflight time ignores the selected stages | Device-only shows the 14.3 h full-tune time | Low | S |
| D4 | Rates are rounded before the tolerance test, so "one item" applies on 12 items but not on 24/46/48 | 91.7 ≥ 91.667, but 97.9 < 97.917 | Medium | S |
| D5 | `tune:gate` (G-001) has no baseline, and its rule is unpaired and blind to hardware | exits `tune_baseline_missing` | High | M |
| M1 | `maxTokens` is minimized as a cost, truncation isn't recorded, and the preset becomes the serving cap | `stopReason` discarded; `openai.js` default cap | High | M |
| M2 | Speed decisions rest on single, sequential timings | A/A: 20% false "significant"; per-item CV 4.6–9.4% | High | M |
| M3 | The "identical answer text" rule rejects speed candidates over rounding | threads 1–2: 9/18 changed; batch 64: 11/18 | High | M |
| M4 | The speed workload is 6 short, mostly prefill-bound items | time to first token is 63–95% of the time for 4 of the 6 items | Medium | M–L |
| M5 | Load stages and the defaults baseline run with repeat penalty 1.1 (newlines penalized) | 27.1% → 33.3% on 48 code items, 3–0 | Medium | S |
| M6 | KV cache is chosen on prompts of ≤ 1.2k tokens but served at up to 16k | longest prompt ≈ 1,176 tokens | Medium | M |
| M7 | Context budget = 60% of *transient* free memory, with an uncalibrated estimate | fixed 256 MiB reserve; budget inputs not stored | Medium | M |
| M8 | Timed stages can overlap other work | lock proceeds after 120 s; `/v1` is not paused | Medium | S–M |
| M9 | Decode tok/s counts n tokens over n−1 intervals, and VRAM is not recorded | +2 to +9% on the speed items | Low | S |
| S1 | Low power for realistic effects; halving drops the best | +10 pts chosen 61%; best cut at rung 1 in 5–22% | High | M |
| S2 | Majority vote throws away seed information | +10 pts detected 74% vs 89% with fractions | Medium | S–M |
| S3 | 39% of code items are unused; the saturation filter shrinks rungs instead of refilling them | 53/136 never asked | Medium | S (G-003) |
| S4 | Clustered items make paired p-values too optimistic | p ≤ 0.05 in 13.6–21.6% under no difference | Medium | M (G-003) |
| S5 | Held-back check: comprehension leaks; the fall-back rule is a coin flip for equal presets | 16/16 share a function; 46–48% fall back | Medium | S–M |
| S6 | An item counts as "saturated" after 2 observations, from any suite or device | `minObservations = 2` | Low | S |
| S7 | The device stage's accuracy rule decides on 6 items with no test | GPU loses on one item | Low–Medium | S |

### If you do five things first

1. **Fix D1, D2 and D4** (about two days). Quick-pass presets get the search they promise, Light and Quiet become
   measured values, and the tolerance means the same thing on every rung.
2. **Stop treating the token budget as a cost (M1).** Record `stopReason`, set the budget as a safety cap, and
   report the truncation rate.
3. **Rebuild the speed stage around throughput (M2–M4).** Use repeated, interleaved timings, prefill and decode
   tokens/s instead of identical text, and a task-weighted workload. Triple its answers; the cost is still about 1%
   of a tune.
4. **Make `tune:gate` real (D5, V1).** Use per-item paired outcomes, a machine-local baseline and an A/A noise floor.
   G-001 can't be honoured until this exists.
5. **Buy power with items you already have (S1–S3).** Add a confirmation rung from the 53 unused code items, test on
   seed fractions, and cut the 22-prompt lists down. That money comes from the system-prompt axis, which alone takes
   43% of a tune.

---

## 2. How a tune works today

```mermaid
flowchart LR
  D["Device<br/>CPU vs GPU, offload<br/>6 items · 1 seed"] --> Q["Quality<br/>context budget · KV cache<br/>36→72 items · greedy"]
  Q --> S["Speed<br/>flash · mmap · batch · threads<br/>6 items · identical text"]
  S --> SA["Sampling, per task<br/>T · maxTokens · repeat · min-p · top-p · top-k<br/>12→24→48 items · 3 seeds"]
  SA --> P["Prompt, per task<br/>system prompt · reasoning · repeat<br/>25% screen → 48 items"]
  P --> H["Held-back check<br/>35 / 16 / 16 unseen items"]
```

| Stage | Chooses | Items | Seeds | Decision rule | Answers per model (share) |
|---|---|---|---:|---|---:|
| Device | backend, GPU layers | 6 speed items | 1 | GPU must be measurably faster (paired tok/s) and answer at least as many items as the CPU | 12 (0.1%) |
| Quality | context (memory budget), KV cache | 36 → 72, mixed tasks | 1 | best rate within one item, then cheapest latency, then memory; Holm-corrected gain for a quality-only change; per-task revert | 180 (1.0%) |
| Speed | flash, mmap, batch, threads | 6 speed items | 1 | fastest candidate whose answer text is unchanged; incumbent wins ties; Light/Quiet from the thread sweep | 102 (0.6%) |
| Sampling | temperature, maxTokens, repeat penalty, min-p, top-p, top-k | 12 → 24 → 48 per task | 3 at T > 0 | successive halving, sequential stop, tolerance, Holm | 7,596 (43.3%) |
| Prompt | system prompt (9 or 22), reasoning, prompt repeat | 25% screen, then 48 | 3 at T > 0 | same | 9,240 (52.7%) |
| Held-back | preset vs. defaults | 35 / 16 / 16 | 3 | fall back if the preset's rate is lower | 402 (2.3%) |

A full tune of one model asks up to **17,532 answers in one pass**. That is about 14.6 h at 3 s/answer, or 1.5 h at
0.3 s/answer on a GPU. The **system-prompt axis alone accounts for 7,500 answers (42.8%)**. These are upper bounds:
screening and sequential stopping cut them in practice.

**What already works well, and should be kept:**
- paired designs throughout;
- exact McNemar and Holm;
- alpha spending across looks (ADR-063);
- nested rungs with a per-item answer cache;
- the held-back check (ADR-054);
- per-task and per-view guards (ADR-057, ADR-070);
- per-type warnings with their own p (ADR-059);
- resumable, fully recorded runs (ADR-050, ADR-051);
- fingerprints with stale warnings;
- sandboxed checks.

The recommendations below build on these rather than replace them.

---

## 3. Defects

### D1. A Quick pass never receives its full continuation — *High, S*

**What happens.**
1. `--quick` runs every axis on its first rung (12 items).
2. Each finished sweep is recorded as `pass:axis` in the stage's `done` list
   ([`tune.mjs:354`](../benchmarks/tune.mjs#L354)).
3. The scheduler then starts the "full continuation" with `--continue`
   ([`tune-scheduler.js:295`](../src/tune-scheduler.js#L295)).
4. On resume, `isDone()` ([`tune.mjs:352`](../benchmarks/tune.mjs#L352)) skips every axis in `done`. Pass 1 changes
   nothing, so `descend()` stops before pass 2 ([`tune.mjs:286`](../benchmarks/tune.mjs#L286)).
5. `finished()` is now true ([`tune.mjs:350`](../benchmarks/tune.mjs#L350)), so every stage is marked **done**.

The result: the 12-item choices become the final preset, and only the final statistics and the held-back check are
measured.

**Evidence** ([`quick-continue.mjs`](tuning-repro/quick-continue.mjs)):

```
Quick pass    stages: {"device":"done","quality":"partial","speed":"partial","sampling":{"math":"partial",…},"prompt":{…"partial"}}
Continuation  search candidates measured: 0
Continuation  stages: {"device":"done","quality":"done","speed":"done","sampling":{"math":"done",…},"prompt":{…"done"}}
Continuation  answers asked: 82 vs a full tune: 516
```

**Why it matters.** ADR-074 states that "the full continuation still measures the same stages on the full rungs".
Instead, every Quick pass ships a preset chosen on 12 items. The one-item tolerance on 12 items is 8.3 points
(see D4). The UI then clears the *provisional* flag.

**Fix.**
- Record quick sweeps apart from `done`, for example `quick:${pass}:${axis}` or a `provisional` flag on the stage.
  The continuation then re-runs each axis on the full rungs, with the quick winner as the incumbent. Sequential
  stopping drops clearly worse challengers early, so confirming a good quick winner costs less than a fresh search.
- Add a test: "a quick pass followed by `--continue` measures every axis on the full rungs". Assert candidate events
  at the last rung size, and that an effect visible only on the full rung is found.

### D2. Light and Quiet can be thread counts nobody measured — *Medium, S*

**What happens.** Two paths end in the fallback `min(Fastest threads, cap)` in `threadsFor()`
([`tune-speed.mjs:82–87`](../benchmarks/tune-speed.mjs#L82-L87)). That is a value chosen by formula, not by
measurement:

1. **Resume.** [`tune.mjs:408–414`](../benchmarks/tune.mjs#L408-L414) treats "threads is a selected axis" as
   "threads was re-measured". When a continued or resumed run skips the finished thread sweep, `speedStage` has no
   thread entries.
2. **Changed text.** `chooseFastest()` drops every candidate whose answer text changed
   ([`tune-speed.mjs:15`](../benchmarks/tune-speed.mjs#L15)). On a real CPU, lower thread counts change answers
   often (see M3). When all of them do, nothing qualifies.

**Evidence.**
- [`quick-continue.mjs`](tuning-repro/quick-continue.mjs): Light/Quiet are 4/2 after the Quick pass and **6/3**
  after the continuation, though the measured steps were 1, 2, 4 and 8.
- [`presets-and-tolerance.mjs`](tuning-repro/presets-and-tolerance.mjs): one changed answer below 8 threads gives
  Light 6 and Quiet 3. On a 12-thread CPU, Quiet's 3 threads is not even a default step.

**Fix.**
- Persist the per-thread measurements in the speed progress, for example
  `threads: [{ threads, latencyMs, changed }]`, and derive Light and Quiet only from measured entries.
- Treat thread count as quality-neutral in expectation. Pick by speed among measured values at or under the cap,
  and guard on pass/fail rather than on text (M3).
- If nothing qualifies, store `null` and have Settings say the preset is unavailable.

### D3. The preflight shows the full-tune time for any selection — *Low, S*

**What happens.** `GET /api/tune/estimate` returns the answer count for the selected stages and settings, but the
seconds come from `estimateTune()`, which takes no stages or settings
([`server.js:519`](../src/server.js#L519), [`tune-grid.mjs:332`](../benchmarks/tune-grid.mjs#L332)). The Tune panel
shows both ([`app.js:2619`](../public/app.js#L2619)).

**Evidence** ([`budget-and-preflight.mjs`](tuning-repro/budget-and-preflight.mjs)):

| Selection | Answers | Seconds shown |
|---|---:|---:|
| all stages | 17,532 | 51,515 |
| prompt only | 9,642 | 51,515 |
| device only | 12 | 51,515 |

**Fix.** Pass `stages` and `only` into `estimateTune()`, or compute seconds as expected answers × measured pace,
plus reloads. Test that a device-only estimate is under a minute.

### D4. The one-item tolerance depends on rounding — *Medium, S*

**What happens.** `score()` rounds rates to one decimal ([`tune-measure.mjs:104`](../benchmarks/tune-measure.mjs#L104)).
`sweep()` compares them with an unrounded floor ([`tune.mjs:211–213`](../benchmarks/tune.mjs#L211-L213)). So
whether a candidate one item behind is "within tolerance" depends on which way the rounding goes:

```
n=12: one item lost -> rounded rate 91.7 vs floor 91.6667 -> inside the tolerance
n=24: one item lost -> rounded rate 95.8 vs floor 95.8333 -> outside the tolerance
n=46: one item lost -> rounded rate 97.8 vs floor 97.8261 -> outside the tolerance
n=48: one item lost -> rounded rate 97.9 vs floor 97.9167 -> outside the tolerance
48 items, T=0.7, last item lost on 2/3 seed(s): chose maxTokens 256 (incumbent 512), paired p=1
```

At T > 0, an item lost by majority (2 of 3 seeds) counts as 0.67 items, so it is accepted. In every accepted case
the paired p is 1. The tolerance stands in for evidence.

**Why it matters.** On full rungs the tuner is stricter than designed: no one-item trade for speed or tokens. On a
Quick pass it trades 8.3 points for fewer tokens. Each stage resets `stageBest`
([`tune.mjs:259`](../benchmarks/tune.mjs#L259)), so sampling and prompt can each make such a trade.

**Fix.**
- Compare counts, not rounded percentages: solved ≥ best solved − `toleranceItems`.
- State non-inferiority as a margin in points with a one-sided paired test, for example "the loss is under 2
  points at α = 0.2". A fixed item count changes meaning with rung size.

### D5. The required gate cannot run, and would be unreliable if it did — *High, M*

**What happens.**
- G-001 makes `npm run tune:gate` mandatory for every change that affects generation. The gate reads
  `benchmarks/baseline-profiles.json` ([`tune-gate.mjs:18`](../benchmarks/tune-gate.mjs#L18)), which has never been
  committed (the [benchmarks README](../benchmarks/README.md) says so). Every run exits with `tune_baseline_missing`.
- Even with a baseline, the rule is a fixed one-item drop in the rate
  ([`tune-baseline.mjs:33–51`](../benchmarks/tune-baseline.mjs#L33-L51)). It is unpaired, the baseline stores no
  per-item outcomes, and the identity check covers suite, task hash and runtime only
  ([`tune-baseline.mjs:7`](../benchmarks/tune-baseline.mjs#L7)), not the CPU or GPU. M3 shows that thread count alone
  changes 9 of 18 greedy answers, so a baseline from one PC passes or fails on another by rounding.

**Fix.** See [V1](#v1-a-gate-that-can-detect-regressions). Until it lands, note in each generation-affecting change
that the gate could not run, rather than implying it passed.

---

## 4. What is measured vs. what is used

### M1. The token budget is tuned as a cost and served as a cap — *High, M*

**What happens.**
- `maxTokens` is a sampling axis whose cost is answer tokens ([`tune.mjs:430`](../benchmarks/tune.mjs#L430)). Ties
  and the tolerance favor the shortest budget. The tests assert "the shortest budget that keeps every item"
  ([`tests/benchmark-tune.test.js:116`](../tests/benchmark-tune.test.js#L116)).
- The evaluator drops the engine's `stopReason` ([`tune-evaluate.mjs:104–114`](../benchmarks/tune-evaluate.mjs#L104-L114)),
  so a truncated answer looks like any other wrong answer.
- When serving, the task preset's `maxTokens` becomes the default cap for any request that does not send
  `max_tokens` ([`openai.js:86`](../src/openai.js#L86), [`331`](../src/openai.js#L331)). `code` is the default task
  ([`openai.js:323`](../src/openai.js#L323)).
- The sampling stage starts from `maxTokens: 512` ([`config.js:27`](../src/config.js#L20-L50)). That overrides the
  per-item budgets, so the **54 code items designed for 1,024 tokens** are cut at 512 in the incumbent and in the
  "defaults" baseline. The load stages use per-item budgets ([`tune.mjs:45`](../benchmarks/tune.mjs#L45)), so the
  two baselines do not match.

**Why it matters.** Suite answers are short; Qwen2.5 0.5B's median code answer was 56–63 tokens in our run.
Real coding requests (a file-wide refactor, a multi-function change) are longer. A cap fitted to the suite cuts them
off with `finish_reason: "length"`. That is the most visible failure a coding assistant can have.

**Fix.**
1. Record `stopReason`, `promptTokens` and `firstTokenMs` with every answer. The engine already computes them.
2. Take `maxTokens` out of cost minimization. Set it as a **safety cap**:
   `max(the task's largest per-item budget, 1.5 × p99 of passing answer lengths)`, rounded up to a step.
   Let verbosity be tuned by prompts and stop triggers, not by caps.
3. Report each preset's **truncation rate**, and refuse a preset that truncates passing-length answers.
4. In `openai.js`, apply a tuned cap only above a floor (for example ≥ 2,048 tokens for code), or not at all.

### M2. Speed decisions rest on single, sequential timings — *High, M*

**What happens.** Each speed candidate is answered **once** on 6 items with 1 seed, one after another, right after
its reload ([`tune-speed.mjs:37–52`](../benchmarks/tune-speed.mjs#L37-L52)). `costDelta()` calls a difference real
when it exceeds both a 3% band and 2 standard errors across the 6 items
([`tune-measure.mjs:143–156`](../benchmarks/tune-measure.mjs#L143-L156)).

**Evidence (A/A on the real engine).** Six measurements of the *same* settings, each with a reload and warm-up as a
candidate gets ([`real-engine.mjs`](tuning-repro/real-engine.mjs)):

```
E1 A/A: median latency per repeat (ms): 1014, 1102, 1110.5, 1098, 1127, 1075
E1 A/A: costDelta called identical settings "significantly different" in 6/30 ordered pairs
E1 per-item latency spread: CV 4.6% – 9.4%
```

The first run was 8% faster than the others. A whole run shifts together, and a standard error across the 6 items
cannot see that.

**Why it matters.** Fastest, Light, Quiet, the device verdict and the latency tie-breaks can all flip on noise. With
7 thread values and 6 batch sizes per pass, a false "significantly faster" challenger is likely somewhere.

**Fix.**
- Measure each candidate **at least 3 times, interleaved** (A B C A B C …), after a warm-up that includes one long
  prompt.
- Decide on run-level medians with a bootstrap interval, or Welch on run totals.
- Set the tie band from a built-in A/A, with the incumbent measured twice: band = max(5%, 2 × A/A spread).
- Today the stage asks 102 answers. Tripling that costs about 200 more, roughly 1% of a tune.

### M3. "Identical answer text" rejects speed candidates over rounding — *High, M*

**What happens.** The speed stage excludes any candidate whose answer text (digest) differs from the stage's start
([`tune-speed.mjs:15`](../benchmarks/tune-speed.mjs#L15), [`52`](../benchmarks/tune-speed.mjs#L52)). The device stage
needs the GPU to answer at least as many of the 6 items as the CPU
([`tune-device.mjs:66`](../benchmarks/tune-device.mjs#L66)).

**Evidence (real engine, CPU, greedy, 18 items: 6 speed and 12 code).**

| Change from threads 3, batch 512 | Answers changed | Notes |
|---|---:|---|
| threads 1 | 9 / 18 | includes speed item `bug-sum-to` |
| threads 2 | 9 / 18 | |
| batch 64 | 11 / 18 | includes speed items `read-sumTo-1`, `read-clamp-1` |
| batch 128 | 4 / 18 | none of the 6 speed items changed, so it would pass the rule |
| flash attention on | 0 / 18 | |
| mmap off | 0 / 18 | |

**Why it matters.** Whether a faster thread count or batch size can win depends on bit-level rounding on a 6-item
workload, and not on quality. It also triggers D2. GPUs, with their own kernels, diverge more (ADR-031).

**Fix.** Base speed on throughput that does not depend on the answer, and guard quality separately:
- **Prefill tokens/s** = `promptTokens / firstTokenMs`. The prompts are identical across candidates.
- **Decode tokens/s** = `(n − 1) / (t_last − t_first)`. It stays comparable when answers differ.
- **Quality guard on pass/fail, not text.** A changed digest is fine if no item flips. If one does, run a
  non-inferiority check on the 36-item load rung (greedy, 1 seed; about 36 answers).

### M4. The speed workload is not the code workload — *Medium, M–L*

**What happens.** The workload ([`tasks.mjs:151–159`](../benchmarks/tasks.mjs#L151-L159)) is the first one or two
items of each task:

```
javascript           prompt   47 · out  75 · time to first token 41% of 676 ms
read-sumTo-1         prompt   94 · out  32 · time to first token 65% of 599 ms  · stop maxTokens
needle               prompt 1412 · out  12 · time to first token 95% of 2570 ms
bug-sum-to           prompt  103 · out 173 · time to first token 24% of 1375 ms
read-clamp-1         prompt   89 · out  32 · time to first token 63% of 536 ms  · stop maxTokens
recall-locker-first  prompt  605 · out  16 · time to first token 89% of 1132 ms · stop maxTokens
```

Four of the six items are dominated by prefill, and only one has a long answer.

**Why it matters.** Code answers are decode-heavy (hundreds of tokens), and codebase prompts are prefills of about
1k tokens. Batch size mostly affects prefill. Threads affect prefill and decode differently: decode is bound by
memory bandwidth and often peaks at fewer threads, especially on hybrid P/E-core CPUs. "Fastest" is currently fastest
for short prompts with short answers.

**Fix.**
- Measure prefill and decode throughput separately (M3).
- Predict each task's latency from its own token profile: median prompt and answer tokens of the preset's answers,
  which are already in `answers.jsonl`.
- Choose the load settings that minimize *task-weighted* latency. Weight by how the user uses tasks, with `code`
  as the default.

This is the deferred "speed on long prompts" item of the `tune-smarter` plan in the AIKit ledger.

### M5. Load stages and the defaults baseline run with the repeat penalty on — *Medium, S*

**What happens.**
- Every tune starts from `DEFAULT_SETTINGS`: temperature 0.7, top-p 0.9, repeat penalty 1.1 over 64 tokens
  ([`config.js:20–50`](../src/config.js#L20-L50), [`tune-job.mjs:53`](../benchmarks/tune-job.mjs#L53)).
- The device, quality and speed stages force temperature 0 but keep the 1.1 penalty
  ([`tune.mjs:45`](../benchmarks/tune.mjs#L45), [`tune-evaluate.mjs:22–31`](../benchmarks/tune-evaluate.mjs#L22-L31)).
- The engine never sets `penalizeNewLine` ([`engine.js:565–571`](../src/engine.js#L565-L571)). node-llama-cpp defaults
  it to **true**, so newlines, which code is full of, are penalized too.

**Evidence** ([`repeat-penalty.mjs`](tuning-repro/repeat-penalty.mjs), Qwen2.5 0.5B, greedy, the code task's 48
tuning items):

```
repeatPenalty 1.1: 27.1% of 48 code items · median 56 tokens
repeatPenalty 1:   33.3% of 48 code items · median 62.5 tokens
paired: 3 items fixed by turning the penalty off, 0 broken; exact McNemar p=0.25
```

The direction is clear, but the sample is too small to pass the tuner's own bar. A 3–0 split *cannot* reach
p ≤ 0.2; the minimum is 4–0. Incumbents win ties, so a poor starting value tends to stick (S1).

**Fix.**
- Run the load stages with the repeat penalty off; they are greedy anyway.
- Start code's sampling stage from repeat 1.0.
- Add `penalizeNewLine: false` and DRY as candidates (G4).
- Use the tuner itself to reconsider `DEFAULT_SETTINGS` for a coding server, on the gate models.

### M6. The KV cache is chosen on short prompts and served at long contexts — *Medium, M (G-003)*

**What happens.** The longest suite prompt is about 1,176 tokens (4,704 characters). The context budget goes up to
16,384 ([`tune-grid.mjs:90`](../benchmarks/tune-grid.mjs#L84-L114)). The KV choice (f16, q8_0 or q4_0) is made on
the short prompts and then applies at the budgeted context. The error of a quantized KV cache grows with context
length.

**Fix.**
- Add a few long items (4k, 8k and 16k tokens of code to read, or recall), generated from a fixed seed like the
  recall items.
- Use them only to confirm the KV choice at the budgeted context: non-inferiority against f16, greedy, 1 seed.
  Skip sizes above the budget.
- Also try mixed K/V types (G4).

### M7. The context budget depends on transient memory and an uncalibrated estimate — *Medium, M*

**What happens.**
- `budgetContext()` takes the largest step whose estimate fits in **60% of free memory at tune time**
  ([`memory-fit.js:15`](../src/memory-fit.js#L15), [`60–79`](../src/memory-fit.js#L60-L79)). Free memory includes
  whatever else is running, even the ModelDuck server's own loaded model.
- The estimate is weights + KV + a fixed 256 MiB reserve ([`memory-fit.js:14`](../src/memory-fit.js#L14)). Compute
  buffers grow with batch size and context, and ADR-021 notes the estimate is uncalibrated.
- `availableMemory()` counts the loaded model's *file size* as reclaimable but not its context. On a GPU it adds the
  whole file size to free VRAM, even for a partial offload ([`engine.js:153`](../src/engine.js#L153)).
- None of these inputs is stored, so a profile does not say what budget it assumed.

**Fix.**
- Budget against **total** memory minus a reserve the user sets (a "memory budget" setting), not momentary free
  memory.
- Use node-llama-cpp's `estimateContextResourceRequirementsV2()`, which accounts for batch size, flash, K/V types,
  mmap and offloaded layers. Or calibrate `memory-fit.js` against `getLlamaMemoryUsage()`.
- Record the budget inputs in the profile.

### M8. Timed stages can overlap other work — *Medium, S–M*

**What happens.**
- The timing lock waits up to 120 s for other tunes to pause, then **proceeds anyway**
  ([`tune-lock.js:23`](../src/tune-lock.js#L23), [`102`](../src/tune-lock.js#L102)). A 2,048-token answer on a CPU
  lane can outlast that wait, and nothing records it.
- The server's own `/v1` traffic is not paused during timed stages. Busy is checked only when a tune starts
  ([`server.js:426`](../src/server.js#L426)).
- The quality stage breaks ties on latency ([`tune.mjs:381`](../benchmarks/tune.mjs#L381)) while other lanes run
  untimed.

**Fix.**
- Record `settled` with each timed measurement, and re-measure when it is false.
- Let the server join the lock: pause timed stages while a reply runs, or answer 503 with `Retry-After` during one.
- Break quality-stage ties on tokens and memory instead of latency.

### M9. Small measurement errors — *Low, S*

- **Decode rate.** [`engine.js:595–598`](../src/engine.js#L589-L598) divides n tokens by the time *after* the first
  token, which covers n − 1 intervals, using `Date.now()`. On the speed items this reads 2% to 9% high (needle: 94.5
  vs. 86.6 tok/s). In the device stage, answers differ in length between devices, so the bias differs between the
  two sides. Fix: use `(n − 1) / (t_last − t_first)` with `performance.now()`, and leave answers under about 16
  tokens out of decode rates.
- **VRAM.** The evaluator keeps only `cpuRam` from `getLlamaMemoryUsage()`
  ([`tune-evaluate.mjs:55`](../benchmarks/tune-evaluate.mjs#L55)), which also returns `gpuVram`. On a GPU the KV cache
  lives in VRAM, so the memory tie-break cannot see a quantized KV cache's saving. Fix: record both, and break ties
  on the chosen device's memory.

---

## 5. Statistics: power, error control, item use

### S1. Low power for realistic effects; halving drops the best — *High, M*

[`power.mjs`](tuning-repro/power.mjs) runs one sampling axis through the real `tune()`: 6 values, with value 3 truly
better by a set number of points. The items are 40% discriminating (pass rate 0.2–0.8), 30% near-always-fail and
30% near-always-pass, answered at T = 0.7 with the default 3 seeds. 400 simulations per row:

| Rungs | True gain | Best value chosen | Wrong change | Best reached rung 2 | Answers per sweep |
|---|---:|---:|---:|---:|---:|
| 12/24/48 (today) | 0 | – | 5.0% | – | 516 |
| 12/24/48 (today) | +5 pts | **17.3%** | 3.5% | 77.5% | 525 |
| 12/24/48 (today) | +10 pts | **61.0%** | 0.3% | 95.0% | 532 |
| 12/24/48 (today) | +15 pts | 90.8% | 0.0% | 98.5% | 531 |
| 12/24/48/96 | +5 pts | 39.3% | 3.3% | 77.5% | 884 |
| 12/24/48/96 | +10 pts | **87.3%** | 1.0% | 95.0% | 898 |
| 12/24/48/96 | +15 pts | 98.3% | 0.0% | 98.5% | 880 |

When the better value also costs more tokens, it is chosen slightly less often (58.8% at +10 points), because the
rung-1 cut ranks ties by cost. The error control is fine: about 5% wrong changes when nothing differs. The power is
the problem.

**Fix, in order of value per answer:**
1. **A confirmation rung from the unused code items (S3).** Score only the incumbent and the leading challenger on
   them. That is about 2 × 53 × 3 answers per sweep, close to the simulated +65%, paid for by G1.
2. **Halving that tolerates noise.** Keep the top half *plus* any candidate within one standard error of the leader.
   Cutting on rank at 12 items is how the true best is lost in 5–22% of sweeps.
3. **Seed fractions instead of majority votes (S2).**
4. **Refill saturated items from the whole tuning pool (S3)**, so every rung is discriminating.

### S2. Majority vote throws away seed information — *Medium, S–M*

`paired()` runs McNemar on each item's **majority of 3 seeds**
([`tune-measure.mjs:116`](../benchmarks/tune-measure.mjs#L116), [`127`](../benchmarks/tune-measure.mjs#L127)), while
`rate` averages the fractions. The two can disagree: a candidate can lead on rate while c ≤ b. With 48 items and one
challenger ([`stats-micro.mjs`](tuning-repro/stats-micro.mjs), 4,000 runs; both tests at one-sided 0.1):

| Discriminating items | True gain | McNemar on majority (today) | Sign-flip on fractions |
|---|---:|---:|---:|
| 40% | 0 | 4.8% | 8.4% |
| 40% | +5 pts | 30.2% | **47.3%** |
| 40% | +10 pts | 73.9% | **89.3%** |
| 100% (after the saturation filter) | 0 | 6.2% | 9.1% |
| 100% | +5 pts | 22.3% | **34.9%** |
| 100% | +10 pts | 50.2% | **68.8%** |

**Fix.**
- Use a paired **sign-flip (permutation) test** on per-item fraction differences. Enumerate exactly when there are
  at most 20 non-zero differences, and use a seeded Monte Carlo above that, so results stay reproducible.
- Use the same statistic in `perTaskCheck`, `groupEvidence` and `byType`.
- At temperature 0 it reduces to McNemar.

### S3. 39% of code items are never used — *Medium, S (G-003)*

`taskRungs()` stops at 48 ([`tasks.mjs:103–111`](../benchmarks/tasks.mjs#L103-L111)). The code task has 101 items
it could tune on (136 minus 35 held back), so **53 items (39%) are never asked**: 16 code, 13 bugfix, 12 code-repo,
3 code-long, 3 bugfix-long, 3 bugfix-repo and 3 public-code ([`suite-usage.mjs`](tuning-repro/suite-usage.mjs)).
Of the 36 codebase items, 15 are unused.

The saturation filter makes this worse. `withDiscriminatingRungs()` filters the *same* 48 items
([`tasks.mjs:134`](../benchmarks/tasks.mjs#L134)), so a model with many saturated items searches on fewer items,
instead of on other discriminating ones from the 53.

**Fix.**
- Refill the rungs from the full tuning pool after filtering.
- Use the remainder as the confirmation rung (S1), or grow the code holdout (S5).

### S4. Clustered items make p-values too optimistic — *Medium, M (G-003)*

Comprehension is **8 functions × 8 inputs** ([`comprehension-items.mjs:63`](../benchmarks/comprehension-items.mjs#L63)),
and the 36 codebase items share **7 codebases**. McNemar treats every item as independent. A setting that changes
how a model reads one function flips several of its inputs together.

Simulated with **no real difference** between the settings ([`stats-micro.mjs`](tuning-repro/stats-micro.mjs)):

| Functions whose reading a setting perturbs | Item McNemar p ≤ 0.05 (nominal 5%) | p ≤ 0.20 (nominal 20%) | Function-level sign test p ≤ 0.05 |
|---|---:|---:|---:|
| 15% | **13.6%** | 29.7% | 1.6% |
| 30% | **21.6%** | 39.3% | 1.2% |

This affects comprehension's sampling and prompt decisions, the per-task revert (ADR-057), the view guard (ADR-070)
and the per-type warnings (ADR-059).

**Fix.**
1. **Suite:** more functions with fewer inputs each. For example, 32 functions × 2 inputs keeps 64 items but gives
   4× more independent clusters. Give codebase items a `group` (their codebase id).
2. **Statistics:** a cluster sign-flip test that flips the signs of per-cluster summed differences. It stays valid
   under clustering. With only 8 clusters it is conservative, which is why the suite change matters.

### S5. The held-back check leaks, and its rule is a coin flip for equal presets — *Medium, S–M*

**What happens.**
- **Leak.** All 16 of comprehension's held-back items are other inputs of the same functions it tuned on. In the
  code task, 9 of 35 held-back items share a codebase with tuned items ([`suite-usage.mjs`](tuning-repro/suite-usage.mjs)).
  `bucketKey()` stratifies by `group` ([`tasks.mjs:56–58`](../benchmarks/tasks.mjs#L56-L58)), but codebase items
  have none.
- **Rule.** A preset falls back to the defaults whenever its held-back rate is lower
  ([`tune.mjs:499`](../benchmarks/tune.mjs#L499), [`575`](../benchmarks/tune.mjs#L575)). There is no test, and cost
  is not considered. Simulated ([`stats-micro.mjs`](tuning-repro/stats-micro.mjs)):

| Held-back items | Preset's true gain | Falls back |
|---:|---:|---:|
| 16 | 0 (equal) | 45.9% |
| 16 | +5 pts | 18.6% |
| 16 | +10 pts | 5.9% |
| 35 | 0 (equal) | 48.4% |
| 35 | +5 pts | 11.2% |
| 35 | +10 pts | 1.1% |

  An equal but cheaper preset (fewer tokens, faster) is thrown away about half the time.
- **Reuse.** Every re-tune consults the same held-back items. With repeated adaptive use, they slowly stop being
  "unseen".

**Fix.**
- Hold back **whole functions and codebases** (group-level split).
- Fall back only when the preset is *significantly* worse, using a one-sided, cluster-aware test, or worse beyond a
  margin. Keep an equal preset that is cheaper.
- Report the held-back estimate with its interval.
- Rotate two held-back folds between re-tunes, or show "held-back set used N times".

### S6. "Saturated" rests on two observations from any context — *Low, S*

`itemOutcomes()` marks an item saturated after **2** observations with the same outcome
([`tune-runs.js:225`](../src/tune-runs.js#L225)). It reads every run of the model, whatever its suite version, task
hash, runtime or device. The two observations are often greedy answers from the load stages. So an item that is
hard but fixable (a format or budget problem) can leave the search early.

**Fix.**
- Require at least 6 observations across at least 2 distinct sampling or prompt settings.
- Filter runs by fingerprint and device.
- Re-admit a random 10% of saturated items each tune, to catch drift.

### S7. The device stage's accuracy rule decides on 6 items — *Low–Medium, S*

A GPU must answer at least as many of the 6 speed items as the CPU
([`tune-device.mjs:66`](../benchmarks/tune-device.mjs#L66)). One rounding-induced loss rejects a GPU that is 5×
faster (ADR-031 measured 109 vs. 20 tok/s for Qwen2.5 Coder 1.5B).

**Fix.** When the speed gain is large, decide accuracy by non-inferiority on the 36-item load rung (greedy, 1 seed)
instead of a 6-item count.

---

## 6. Search strategy and search space

### G1. Spend answers where they buy something

| Spend today | Answers | Observation |
|---|---:|---|
| system-prompt axis (9 + 22 + 22 prompts) | 7,500 (42.8%) | ADR-036 found most prompts tie; the screen trims, but this is still the largest item |
| other sampling and prompt axes | 9,336 (53.3%) | top-k next to min-p rarely matters for 0.5–3B models; prompt repeat doubles prefill for little gain on generation tasks |
| speed + device | 114 (0.7%) | these decide every request's latency (M2–M4) |

**Suggestions.**
- **Shrink comprehension's and recall's 22 prompts to about 6.** Retire prompts that never won on any tuned model;
  the profiles already record the winners.
- **Tune top-k only when min-p is 0**, and make prompt repeat opt-in for code.
- **Screen with 1 seed** on rung 1 at T > 0, and decide with 3.
- **Reallocate** the savings to the confirmation rung (S1) and to repeated speed timings (M2).

### G2. Coordinate descent misses interactions

Temperature interacts with min-p, top-p and top-k. When temperature 0 wins first, those three are skipped as no-ops
([`tune.mjs:270–272`](../benchmarks/tune.mjs#L270-L272)). The second pass runs only if something changed
([`tune.mjs:286`](../benchmarks/tune.mjs#L286)). So once temperature 0 wins, a combination such as "T 0.2 with
min-p 0.1" is never tried. KV × flash and
threads × batch interact too.

**Fix.**
- Replace the temperature, min-p and top-p axes with one **sampler-profile axis** of 6–8 known-good combinations,
  for example:
  - greedy;
  - T 0.2 / min-p 0.1;
  - T 0.5 / min-p 0.05 / top-p 0.95;
  - T 0.8 / min-p 0.1.
- Add the deferred "pair check" from the `tune-smarter` plan: the best two values of the two settings that mattered
  most, tried together.

### G3. Start where code does well

Incumbents win ties, and power is limited (S1), so the starting point largely decides the outcome. The load stages
run greedy at per-item budgets with a repeat penalty. The sampling stage starts at T 0.7, top-p 0.9, repeat 1.1 and a
512-token cap (M1, M5).

**Fix.** Start code at T 0, repeat off, and a budget at or above the largest per-item budget. Keep comparing the
final preset against the *server defaults*, since that comparison says whether tuning helped.

### G4. Runtime knobs available but not searched

All of these are in node-llama-cpp 3.22.2's type definitions ([Appendix B](#appendix-b-node-llama-cpp-3222-options-checked)):

| Knob | Why it fits a coding tuner | Suggested steps |
|---|---|---|
| `repeatPenalty.penalizeNewLine` | default **true** penalizes code's newlines (M5) | false (code default), true |
| `dryRepeatPenalty` (DRY) | stops verbatim loops without penalizing legitimate repetition such as brackets and names | strength 0, 0.8; `allowedLength` 2–4 |
| `repeatPenalty.frequencyPenalty`, `presencePenalty` | gentler alternatives to a flat penalty | 0, 0.1 |
| separate `experimentalKvCacheKeyType` / `ValueType` | K is usually more sensitive than V; mixed pairs save memory at lower risk | f16/q8_0, q8_0/q4_0 |
| `responsePrefix` | makes a small model open with a code fence instead of prose | none, "```javascript\n" for code (check against the checkers) |
| `customStopTriggers` | stops after the first complete code block for "return only the code" | off, closing fence (verify multi-block answers) |
| `budgets.thoughtTokens` | needed if reasoning models (Qwen3, R1 distills) join the catalog | 512, 1024, unlimited |
| `swaFullCache` | prefix reuse versus memory on sliding-window models (Gemma family) | off, on, only for SWA models |

`threads` is a single value: llama.cpp's separate prompt-processing thread count is not exposed. The benchmarks
README already lists `n_ubatch` as unsupported.

### G5. The "deep" reasoning directive contradicts itself

"Think through the problem carefully before giving the final answer. **Show only the answer** the user asked for"
([`generation-manifest.js:24`](../src/generation-manifest.js#L24)) is combined with the suite prompt's "Do not
explain unless the user asks" ([`suite.mjs:15`](../benchmarks/suite.mjs#L15)). The model cannot think in text, so
"deep" is a nudge, not reasoning.

**Fix.** Offer a real chain-of-thought step, for example "think step by step in a few short sentences, then give the
final answer on its own line or in a final code block". The checkers already read the last code block and the
"Answer:" line (ADR-052). Give it room the way ADR-046 does.

### G6. Use partial credit as a finer signal (G-003)

Code items have 2–7 test cases (median 3–4), but an item counts only when *all* pass
([`stats.mjs:50–52`](../benchmarks/stats.mjs#L50-L52)). Using the fraction of cases passed as each item's score in
the paired test makes each item more informative. Keep "all pass" as the headline rate.

### G7. Explore GPU offload beyond "load failed"

Smaller offloads are tried only when the full offload *fails to load* ([`tune-device.mjs:54`](../benchmarks/tune-device.mjs#L54)).
A full offload that spills into shared memory loads fine, runs slowly, and then loses to the CPU without a partial
offload ever being tried.

**Fix.** Try 75% and 50% when the full offload is not clearly faster. Record VRAM headroom with `getVramState()`.

### G8. Reuse answers across runs

The measurement cache lives in memory ([`tune-measure.mjs:21–57`](../benchmarks/tune-measure.mjs#L21-L57)), so
continues and re-tunes re-ask incumbents. `answers.jsonl` already holds settings, seed, item and outcome.

**Fix.** Prefill the cache from earlier answers whose exact settings, seed, item and fingerprint (including device)
match.

### G9. Cover how coding assistants are used

Every item is a single turn in a fresh session, so the checkpoint axis can never matter (ADR-029), and follow-up
fixes are never measured.

**Fix.** A few two-turn items, such as "here is the failing test output, fix it", would measure both, and also
exercise prefix reuse.

---

## 7. Validation and governance

### V1. A gate that can detect regressions

1. **Machine-local baseline by default.** Store it under the data folder with a hardware identity (CPU, GPU and
   driver, threads). Allow a committed reference baseline only for a named reference machine.
2. **Per-item outcomes** for each model and task, with the seed fractions.
3. **A paired decision.** Run a sign-flip (or McNemar) test per model and task, Holm across them, with a floor, as
   `compareRuns()` already does for the cross-model bench ([`stats.mjs:101–142`](../benchmarks/stats.mjs#L101-L142)).
   Name the regressed items.
4. **A noise floor.** Re-measure the baseline once (A/A) when it is created, and store the flip rate. A run "fails"
   only beyond that.
5. Keep latency informational, but report it with the M2 method.

### V2. Statistical regression tests in `npm test`

The mechanics tests run with `changeAlpha: Infinity` ([`tests/benchmark-tune.test.js:83`](../tests/benchmark-tune.test.js#L83)),
so nothing protects the statistical behavior. Add seeded simulations (a smaller [`power.mjs`](tuning-repro/power.mjs),
about 3 s) that assert:
- wrong changes ≤ 7% under no difference;
- +10 points chosen at least as often as today (and above 85% once S1 lands);
- an equal but cheaper preset falls back ≤ 10% (once S5 lands).

### V3. Version what decides

Add `tunerVersion` (the decision-rule version), the engine and generation-manifest version, and the GPU name and
driver to `FINGERPRINT_KEYS` ([`model-profiles.js:24–26`](../src/model-profiles.js#L24-L26)). Then changes like
ADR-037 (no system prompt was ever sent) or ADR-063 (new decision rule) mark old profiles stale automatically,
instead of relying on a note.

### V4. Record, then show, the evidence

- Per answer: `stopReason`, `promptTokens`, `firstTokenMs`, decode rate, `gpuVram`, and whether the timing lock was
  settled.
- In Details: each decision's n, p and margin; the truncation rate; the prefill and decode throughput; and a
  "decided on 12 items, provisional" label until the full rung confirms it.

---

## 8. Roadmap

| Phase | Items | Suite change | Effort |
|---|---|---|---|
| **0. Correctness** | D1, D2, D3, D4; record `stopReason`, `promptTokens`, `firstTokenMs`, `gpuVram` and `settled` (M8, M9, V4) | none | 2–3 days |
| **1. Gate and serving safety** | D5 and V1 (paired, machine-local, A/A floor); M1 (budget as a safety cap, truncation rate); M5 (repeat penalty off in load stages, `penalizeNewLine` candidate) | none | ~1 week |
| **2. Speed stage rebuild** | M2 (repeats, interleaving, A/A band), M3 (throughput, pass/fail guard), M4 (task-weighted prefill and decode), S7, G7, M7 (runtime estimator, memory budget) | none | 1–2 weeks |
| **3. Statistical efficiency** | S1 (confirmation rung, tolerant halving), S2 (fractions), S3 (use and refill the pool), S5 (rule, group-level split), S6, V2, V3, G8 | rungs and holdout (G-003) | 1–2 weeks |
| **4. Suite and search space** | S4 (comprehension redesign, codebase groups), M6 (long-context items), G1 (prompt pruning), G2 (sampler profiles, pair check), G4 (DRY, `penalizeNewLine`, mixed K/V, prefix, stops), G5, G6, G9 | yes (G-003) | 2–4 weeks |

Do phases 0 and 1 first. Without them, the other phases can't be trusted or gated. Phases 3 and 4 change what a
profile was measured on, so do each in one suite bump with a regenerated baseline, as G-003 requires.

---

## 9. How to tell the tuner got better

| Measure | Today | Target | How |
|---|---|---|---|
| +10-point value chosen | 61% | ≥ 85% | `power.mjs` (V2) |
| Wrong changes when nothing differs | 5% | ≤ 5% | `power.mjs` |
| Speed A/A false "significant" | 20% | ≤ 5% | built-in A/A (M2) |
| Speed candidates rejected for text only | 9–11 of 18 answers changed | 0 rejections without a pass/fail flip | M3 log |
| Preset truncation rate (suite + long items) | not recorded | ≤ 1% | `stopReason` (M1) |
| Equal but cheaper preset discarded by the held-back check | 46–48% | ≤ 10% | `stats-micro.mjs` (S5) |
| Gate runs on every generation change | never (no baseline) | always, with a stated noise floor | V1 |
| Full tune of one model (one pass) | 17,532 answers | ≤ 12,000 with higher power | `budget-and-preflight.mjs` |

---

## 10. Follow-up, 2026-11-19: what recorded runs say

Method: read the 30 runs in `~/.modelduck/tune-runs` (136,836 sweep answers) and the 8 saved profiles on the
i5-14400F / RX 9060 XT machine, replayed screening rules against the recorded rung data, simulated the screen under
the assumptions of Appendix A, and timed the engines with `npm run engines` and `LlamaServerBackend` directly.
Evidence comes from three small models (SmolLM2 135M, Qwen2.5 0.5B, Qwen2.5 Coder 1.5B); larger models may differ.

| ID | Finding | Evidence | Severity | Effort |
|---|---|---|---|---|
| F1 | The prompt screen no longer prunes | 18.1 prompts enter the screen, 17.9 leave it; ADR-049 expected about 6 | High | S |
| F2 | The system-prompt axis has not moved a profile | 20 sweeps, 49,282 answers (36%), 1 change, undone on the next pass | High | S–M |
| F3 | Four axes never changed anything | reasoning 0/21, `penalizeNewLine` 0/22, KV cache 0/7, DRY 0/8: about 13,600 answers | Medium | S |
| F4 | No saved profile has been through the engine stage | all 8 profiles dated 2026-11-14, before ADR-156; no `.engines.json`; `llama-server` (vulkan) is 20% faster on Qwen2.5 Coder 1.5B | High | none (a re-tune) |
| F5 | The engine verdict ranks by generation speed only | `llama-server` vulkan: +20% generation, −18% prompt (4,875 vs 5,951 tok/s) | Medium | S–M |
| F6 | CPU engines are timed at different thread counts | in-process 4 threads (default), `llama-server` 8; the verdict's 18.8 tok/s (12.6–21.5) vs 25–28 at 4 and 28–34 at 8 threads | Medium | S |
| F7 | The one-pass budget grew past the target | upper bound 18,714 answers (was 17,532; target ≤ 12,000) | Medium | follows F1–F3 |
| F8 | All three code presets are the same, and the app default for code is not it | held-back code items: tuned beats default on 3 of 3 models (+9.7, +2.4, +3.2 points); only Coder 1.5B is significant alone (p = 0.03) | Medium | S (G-001) |
| F10 | About 90% of the answer time goes to items on which every candidate agreed | 90.3% of code time, 85.8% comprehension, 86.8% recall; a learned ranking holds 94% of the later disagreement in 25% of the rung cost; replayed decisions identical at 44% of the cost | High | M-L (G-003) |

### F1. The prompt screen no longer prunes — *High, S* — fixed in tuner v12 (ADR-180)

ADR-049 screened a fully scored axis on a quarter of its items and dropped a candidate 3 items behind the leader,
expecting about 6 survivors of 22. ADR-063 replaced the gap with a sequential one-sided McNemar stop, `changeAlpha`
spread over the axis's looks (about 0.025 per look). System prompts mostly agree item by item, so at 12 items a
prompt rarely collects enough one-sided losses to stop: in the recorded runs 362 prompts entered the screen and 358
answered the full 48 items. The halving rule (one standard error of the leader, S1) does not apply, because the axis
is `full`. ADR-063's "22 prompts screened to 9 survivors" no longer describes what happens.

**Change.** Give a full axis's screen the same tolerant rule the halving rungs use: keep the current setting, the
top half, and anything within one standard error of the leader. Simulated on Appendix A's item mix, that rule keeps
about 8 of 22 and still carries a truly +10-point prompt forward 76% of the time (+5 points: 58%); a fixed top-k
keeps it less often (top-4 57%, top-6 69%). Replayed on the recorded rungs, a top-6 screen would have saved 26,412
of the axis's 49,282 answers without losing its one change; the one-SE rule's saving is of the same order.

### F2. The system-prompt axis has not moved a profile — *High, S–M* — done: off by default in tuner v12 (ADR-179)

Every task of every saved profile uses `SYSTEM_PROMPT`, the starting value. Nineteen of twenty sweeps ended with no
discordant items between the winner and the incumbent (b = 0, c = 0). The one change (Qwen2.5 Coder 1.5B,
comprehension, pass 1, b = 2, c = 12, p = 0.0085) was undone by pass 2. On these models the axis buys nothing for
36% of a tune.

**Change.** After F1, decide with data: run the axis in pass 1 only and skip it in later passes unless pass 1
changed it; or shorten the comprehension and recall lists (22 each) to the prompts that ever led a rung. A list
change is a G-003 change (suite bump, CHANGELOG row, baseline update).

### F3. Four axes never changed anything — *Medium, S* — not built (ADR-180)

| Axis | Sweeps | Answers | Changes |
|---|---|---|---|
| reasoning | 21 | 5,788 | 0 |
| `penalizeNewLine` | 22 | 4,512 | 0 |
| KV cache | 7 | 2,196 | 0 |
| DRY | 8 | 1,112 | 0 |

**Change.** Not removal: three small models are too few to retire an axis. Skip an axis in a later pass when the
same model's earlier pass kept the current value with b = c = 0 on the full rung, and record the skip in the sweep.

**Decision, 2026-11-19.** Not built. A second pass runs only when the first changed something, and in the 30 recorded
runs pass 2 holds 13% of all sweep answers (16,870 of 130,096), so the saving is a fraction of that. Against it, an
axis that tied at b = c = 0 can matter once another axis moves (reasoning needs the token budget the sampling stage
may change), so skipping it risks the interaction the second pass exists to catch.

### F4. No saved profile has been through the engine stage — *High, no code*

The tuner adopts the fastest accurate engine at the device stage (ADR-156 onwards), but every profile predates it.
`npm run engines` on Qwen2.5 Coder 1.5B Q4_K_M: `llama-server` vulkan 196 tok/s against node-llama-cpp vulkan
164 tok/s. Re-running the device stage (12 answers plus the engine timing) on each model would let a profile adopt
it; the later stages then re-measure on that engine, so a full re-tune is the honest path (G-001 baseline update).

### F5. The engine verdict ranks by generation speed only — *Medium, S–M* — API ranking added (ADR-181)

`fastest` and the "best speed engine" line use generation tok/s. `llama-server` vulkan generates 20% faster but reads
prompts 18% slower. With these rates, a 1,200-token prompt and 100-token answer takes about 0.76 s on
`llama-server` and 0.81 s in process, but an 8,000-token recall prompt with a 20-token answer takes about 1.74 s
against 1.47 s: the in-process engine wins long context by about 18% (estimates from the measured rates, not timed).

**Change.** Rank engines per task by expected time per answer, using each task's recorded prompt and output token
counts (already in every profile's task stats), and say which task each engine wins.

**Done, 2026-11-19 (ADR-181).** `GET /api/engines?model=` returns `byTask`, computed that way. The tuner still adopts the
engine by generation speed at its device stage, and the Models list still marks `fastest` by it; moving either to the
per-task ranking is a decision about what a profile means and is not made here. The engine timings come from one
fixed 256-token workload, so `byTask` estimates the ranking, not the seconds.

### F6. CPU engines are timed at different thread counts — *Medium, S* — fixed (ADR-180)

`NodeBackendAdapter.measure` loads with no `threads`, so the engine's default of 4 applies; `LlamaServerAdapter`
starts the server with `threads: 8`. On the 6P+4E i5-14400F, `llama-server` CPU measured 25–28 tok/s at 4 threads,
23–24 at 6 and 28–34 at 8 (three runs each, after a warm-up), while the verdict reported 18.8 tok/s with a spread
of 12.6–21.5 and ranked it below the in-process engine (24.9). The CPU ranking compares thread counts, and a single
noisy timing decides it.

**Change.** Time every CPU engine at the same thread count (the profile's tuned `threads`, else the machine's
measured best), and treat two engines whose ranges overlap as tied, as the speed stage does with its A/A band (M2).

**Done, 2026-11-19 (ADR-180), tie note added (ADR-181).** All three CPU adapters now get `cpuTimingThreads()`: three quarters of the logical
threads, at most 8 (8 on this PC). Measured afterwards on Qwen2.5 Coder 1.5B, in-process CPU at 4, 6 and 8 threads:
25.0, 29.5 and 32.0 tok/s; `llama-server` CPU at 8: 20.6 in the full table (17.9-25.1) against 28-34 timed alone. At
equal threads the two engines are close, so the earlier ranking (24.9 over 18.8) was a thread-count artifact. The
`engines` table still marks the highest median as fastest, but its verdict line now adds "within the measured spread
of ..." when another engine's range reaches the leader's. On this shared machine another process can halve one
engine's number mid-run (in-process CPU read 5.5 tok/s in one table, 32 when timed alone), so a verdict between close
engines should not be trusted from a single table.

### F7. The one-pass budget grew past the target — back under it (ADR-179)

With the system prompt off by default, one full pass is 10,878 answers at the defaults (18,696 with it on; the
target was 12,000). The script's "held-back check" line is stale and prints a negative number now; it assumes the
old step shape.

`budget-and-preflight.mjs` gave 18,714 answers for one full pass (the system-prompt axis 7,500, the held-back
check 5,868). F1 to F3 together remove roughly a third of the sweep answers recorded so far. Its "seconds do not
follow the selection" line is stale: the script computes seconds once without the stages, while `estimateTune`
honours them (D3 stays fixed).

### F8. All three code presets are the same, and the app default for code is not it — *Medium, S (G-001)*

The tuned code preset of SmolLM2 135M, Qwen2.5 0.5B and Qwen2.5 Coder 1.5B is identical: temperature 0, repeat
penalty 1, DRY 0, newline penalty off, top-k 40, min-p 0.05, top-p 0.9, 512 tokens. The app's default for a model
nobody tuned is temperature 0.7, repeat penalty 1.1 and the newline penalty on. On the 41 held-back code items the
tuned preset against that default scored 14.6 vs 4.9, 39.0 vs 36.6 and 63.4 vs 60.2, and in the paired comparison
the tuned preset won more items on every model (13 against 7, 11 against 8, 11 against 5). Only the last is
significant by itself (p = 0.03); the three models share the same 41 items, so they are not independent evidence.
Comprehension and recall differ little (changes of 0 to 1.6 points, one of them downward), and their presets vary
by model.

**Change.** For a model with no profile, serve code requests (`/api/code/verify` and the code task's route) with that
preset instead of the general default. It is a serving default, so it needs the G-001 gate and a decision from the
owner: it changes answers for every untuned model. Tuning a model would still override it. The held-back evidence
is for three small models only, so a fourth, larger model should be checked before a default is changed.

### F9. Where tuning time goes, and what was done about it (ADR-182)

Measured 2026-11-19 from the recorded runs and the live gate baseline (SmolLM2 135M).

- **Generation is the time.** In the one recorded long run with timing, 90% of the wall time was generation, 3.7%
  judging and 5.7% model loads. Running several answers at once within one model did not help on this PC (ADR-032,
  ADR-101, ADR-119), so the lever is how many tokens are generated, not how they are scheduled.
- **The code task is the time.** Code, bug-fix and repository items are about 73% of the answers in the live baseline
  and 91% of its answer time; comprehension and recall emit 1 to 3 tokens. A full pass at the defaults is about
  5,300 code answers and 4,800 others.
- **By time, not by answers, the token budget is the costly axis.** `maxTokens` was 16% of the sweep answers and 47% of
  their time (about 1 s per answer against about 0.2 s elsewhere); the system-prompt axis was 36% of the answers and
  19% of the time. Higher caps do win sometimes (1024 won 3 of 10 code sweeps), so the grid is not pruned.
- **What was done.** (1) The system prompt is not tuned by default (ADR-179): 42% fewer answers per pass. (2) An answer
  that ended by itself under a cap is reused under every larger one (ADR-182): 3.8% of the recorded answer time. An
  earlier estimate of 22.8% was wrong: it counted aborted answers as finished ones and ignored the order the caps
  were measured in; the strict rule in the recorded order gives 3.8%, and 7,313 of 7,359 reusable answers were
  byte-identical to the finished one (all 6,388 sampled ones).
- **Not worth doing.** Stopping a looping answer as soon as `detectLoop` sees it saves 0.1% to 3% of time across all
  recorded runs (the 20% seen in the live baseline is one unusual CPU run: 41% of its answers hit the cap).
  Skipping confirmation saves almost nothing: it ran 7 times in 212 sampling and prompt sweeps, so the preflight's
  upper bound overstates it.
- **The preflight is pessimistic.** The Tune settings text says one pass is "up to 8.7 h" at 3 s per answer, which is
  a CPU figure; full tunes recorded on this PC took 19 to 81 minutes on the GPU.

### F10. About 90% of the answer time goes to items that cannot change a choice — *High, M–L (G-003)*

Measured 2026-11-20 from the 30 recorded runs on this PC (three small models), by stepping back from "how many
answers" to "how much does each answer tell us". A tune is noisy black-box optimisation with an expensive evaluator;
the question that matters is information per second, and the tuner currently spends it evenly.

**What the data says.**

- **Most answers are concordant.** In sampling and prompt sweeps, 90.3% of the code task's time, 85.8% of
  comprehension's and 86.8% of recall's went to items on which every candidate got the same result. Such an item
  contributes nothing to a paired comparison. The tuner's own exclusion (ADR-064, "saturated": never flipped in any
  recorded sweep) removed 11 of 48 code items and none for comprehension or recall.
- **Information is concentrated, and cheap to find.** Ranked by flips per second, trained on the earlier half of
  the sweeps and tested on the later half, the best-ranked code items hold 83% of the later sweeps' disagreement in
  25% of the item cost (a random order: 45%). Learned inside one tune, from only the earlier sweeps of that tune
  (first two sweeps at full cost), the ranking captures 94% of the disagreement at 25% of the rung cost for code,
  70% for recall and 53% for comprehension.
- **It does not transfer between models.** Ranking items by the other two models' sweeps was worse than random for
  the strongest model (10% of the information at any budget): which items sit on a model's decision boundary is
  that model's own. So a fixed "informative item list" cannot ship; the ranking has to be learned per model, online,
  which is what ADR-064 already assumes.
- **Decisions survive it.** Replaying the 127 sampling and prompt sweeps that have complete outcomes (final rung,
  paired exact test, Holm-style bar of 0.2 like the tuner's), measuring only the best 25% of the rung's cost plus a
  10% random tripwire gives the same decision in 124 of them with no false change, but misses 3 of the 4 real
  changes. Adding one rule, "test a challenger on the full rung when the subset shows it ahead with one-sided
  p <= 0.25 to 0.35", gives the same decision in all 127 (all 4 changes found, none invented) at 44% of the full
  rung cost. A stricter trigger (p <= 0.15) misses one change at 33%.

**Design: adaptive informative rungs. Built 2026-11-20 as the opt-in `--adaptive` (ADR-188, ADR-189). First A/B, Coder 1.5B code task: 36% fewer answers (977 against 1,524), held-back result not lower; other models and tasks are being checked.**

1. For each task, keep per-item counts of sweeps seen and sweeps on which the candidates disagreed, and the item's
   measured answer time, from the sweeps of this tune (stored in the progress state so a resume keeps them).
2. From the third sweep of a task on, order the search rung's items by `(flips + 0.15) / (seen + 1) / ms`, keep the
   category pattern of the stratified order (ADR-070's code views), take items until a quarter of the rung's
   estimated cost is reached, and add a random tenth of the rest as a tripwire.
3. A challenger that is ahead on that subset (net wins, one-sided exact p <= 0.3) is tested on the whole rung before
   it may win; every other challenger is judged on the subset. The held-back check (ADR-054) on unseen items stays
   as it is and guards against any over-claim.
4. The choice of items uses only earlier sweeps' outcomes, so within a sweep the order is fixed before the data and
   the sequential test stays valid.

**What would decide it.** An A/B on the three core models: one tune each with and without the option, comparing the
settings chosen, the held-back rates against the defaults and the wall time; accept only if the held-back rates are
not lower on any task and the code tune gets at least 30% faster. The replay is optimistic in three ways: it learns
from the same run and starts at the third sweep, it ignores the nested rungs and early stopping, and it has only 4
real changes to find. It is evidence for the experiment, not for shipping.

**Ideas tried and set aside, with the reason.**

| Idea | Result |
|---|---|
| Ask each candidate counterfactually (replay the sampler on recorded logits) | When one sampling setting changes, the answer is identical in 70% (repeat penalty), 92% (newline penalty) and 100% (DRY, 206 pairs) of the pairs, but those axes are about 4% of the time, so the saving is small for a very large change |
| Stop an answer as soon as it loops (`detectLoop`) | 0.1% to 3% of the time across all runs; the 20% seen in one live baseline was a CPU run in which 41% of the answers hit the cap |
| Skip no-change axes in the second pass (F3) | Pass 2 is 13% of the answers, and an axis can matter once another moves |
| Run several answers at once inside one model | Measured earlier: no speedup on this PC (ADR-032, ADR-101, ADR-119) |
| Reuse an answer across token caps | Built (ADR-182): 3.8% of the time, exact |
| Verify saved answers per family instead of all or nothing | Built (ADR-185): kept 94%, 56% and 18% of the saved answers of the three models where all of them used to be discarded |
| Tune the core models side by side | Built (ADR-184), opt-in |
| Rust for the tuner | No: generation is 90% of the wall time and runs in native code already; the tuner's own code is under 1% |

### Reviewed and left as is

The gate (`tune:gate`) checks a rotating 12-item window per task and re-measures the full rung when any checked item
flips; the other answers come from a cache keyed by the generation-path files, so a generation change invalidates
them. Its latency deltas (+245 ms, +262 ms on 2026-11-19) come from running three models in parallel, which the code
documents as lower-fidelity latency.

---

## Appendix A: Reproduction

All scripts live in [`docs/tuning-repro/`](tuning-repro/) and import the repository's own modules. Run them from the
repository root.

| Script | Sections | Needs | Runtime |
|---|---|---|---|
| [`quick-continue.mjs`](tuning-repro/quick-continue.mjs) | D1, D2 | nothing | < 1 s |
| [`presets-and-tolerance.mjs`](tuning-repro/presets-and-tolerance.mjs) | D2, D4 | nothing | < 1 s |
| [`budget-and-preflight.mjs`](tuning-repro/budget-and-preflight.mjs) | 2, D3, G1 | nothing | < 1 s |
| [`suite-usage.mjs`](tuning-repro/suite-usage.mjs) | S3, S5, M4, M6 | nothing | < 1 s |
| [`power.mjs`](tuning-repro/power.mjs) | S1 | nothing (`node docs/tuning-repro/power.mjs 400`) | ~16 s |
| [`stats-micro.mjs`](tuning-repro/stats-micro.mjs) | S2, S4, S5 | nothing | ~30 s |
| [`real-engine.mjs`](tuning-repro/real-engine.mjs) | M2, M3, M4, M9 | `npm install`; a folder with `SmolLM2-135M-Instruct-Q4_K_M.gguf` | ~10 min on 4 cores |
| [`repeat-penalty.mjs`](tuning-repro/repeat-penalty.mjs) | M5 | `npm install`; a folder with `qwen2.5-0.5b-instruct-q4_k_m.gguf` | ~4 min on 4 cores |

The two model files were downloaded from the catalog's repositories and matched the catalog's pinned SHA-256. The
simulations use fixed seeds, so they reproduce the tables exactly.

**Simulation assumptions.**
- 40% of items are discriminating (single-answer pass rate 0.2–0.8), 30% near-always-fail (0.02) and 30%
  near-always-pass (0.98).
- A "gain" is the average improvement over the whole item set, produced by a logit shift on discriminating items.
- In the cluster study, a setting re-rolls whether each function is understood with a given probability. Items pass
  with 0.9 when it is understood and 0.1 when it is not.
- Other mixes change the numbers, not the direction.

<details>
<summary>Raw output: real engine (SmolLM2 135M Q4_K_M, CPU, 3 threads)</summary>

```
model SmolLM2-135M-Instruct-Q4_K_M.gguf, 6 speed items: javascript, read-sumTo-1, needle, bug-sum-to, read-clamp-1, recall-locker-first

E1 A/A: median latency per repeat (ms): 1014, 1102, 1110.5, 1098, 1127, 1075
E1 A/A: costDelta called identical settings "significantly different" in 6/30 ordered pairs; digests identical across repeats: true
E1 per-item latency spread:
  javascript: mean 815 ms, CV 9.4%
  read-sumTo-1: mean 594 ms, CV 6.1%
  needle: mean 2804 ms, CV 4.6%
  bug-sum-to: mean 1506 ms, CV 8.8%
  read-clamp-1: mean 569 ms, CV 4.7%
  recall-locker-first: mean 1361 ms, CV 6.7%

E2 reference (threads 3, batch 512) on 18 items
E2 {"threads":1}              changed answers:  9/18 (bug-sum-to, code-long-calculator, bug-long-binary-search, repo-cart-total, …) · median 4344 ms vs 1700.5 · speed delta significant: true (4748.1 ms)
E2 {"threads":2}              changed answers:  9/18 (bug-sum-to, code-long-calculator, bug-long-binary-search, repo-cart-total, …) · median 2049 ms vs 1700.5 · speed delta significant: false (238.2 ms)
E2 {"batchSize":64}           changed answers: 11/18 (read-sumTo-1, bug-sum-to, read-clamp-1, code-long-calculator, …) · median 1653.5 ms vs 1700.5 · speed delta significant: false (36.3 ms)
E2 {"batchSize":128}          changed answers:  4/18 (code-long-calculator, bug-long-binary-search, bug-long-merge-intervals, repo-tokenize-digits) · median 1499 ms vs 1700.5 · speed delta significant: true (-352.1 ms)
E2 {"flashAttention":"on"}    changed answers:  0/18 · median 1705.5 ms vs 1700.5 · speed delta significant: false (-278.8 ms)
E2 {"useMmap":"off"}          changed answers:  0/18 · median 1672.5 ms vs 1700.5 · speed delta significant: false (-237.5 ms)

E3 per item: prompt tokens, output tokens, time to first token, total, engine tok/s vs (n-1)/decode-time
  javascript             prompt    47 · out   75 · TTFT   278 ms (41% of 676 ms) · engine 188.44 tok/s vs corrected 185.9 · stop eogToken
  read-sumTo-1           prompt    94 · out   32 · TTFT   387 ms (65% of 599 ms) · engine 150.94 tok/s vs corrected 146.2 · stop maxTokens
  needle                 prompt  1412 · out   12 · TTFT  2443 ms (95% of 2570 ms) · engine 94.49 tok/s vs corrected 86.6 · stop eogToken
  bug-sum-to             prompt   103 · out  173 · TTFT   334 ms (24% of 1375 ms) · engine 166.19 tok/s vs corrected 165.2 · stop eogToken
  read-clamp-1           prompt    89 · out   32 · TTFT   336 ms (63% of 536 ms) · engine 160 tok/s vs corrected 155.0 · stop maxTokens
  recall-locker-first    prompt   605 · out   16 · TTFT  1006 ms (89% of 1132 ms) · engine 126.98 tok/s vs corrected 119.0 · stop maxTokens
```

The speed deltas of rows whose answers changed compare answers of different lengths, so read only the
changed-answer counts there.

</details>

<details>
<summary>Raw output: repeat penalty (Qwen2.5 0.5B Q4_K_M, CPU, 3 threads, greedy)</summary>

```
repeatPenalty 1.1: 27.1% of 48 code items · median 56 tokens · 125 s
repeatPenalty 1: 33.3% of 48 code items · median 62.5 tokens · 120 s
paired: 3 items fixed by turning the penalty off, 0 broken; exact McNemar p=0.25
```

</details>

<details>
<summary>Raw output: suite usage and answer budget</summary>

```
code           items 136 · searched/final 48 · held back 35 · never used 53 (39%) · families 7 · held items sharing a family with tuned items 9/35
               never used by category: {"code":16,"bugfix":13,"code-repo":12,"code-long":3,"bugfix-long":3,"bugfix-repo":3,"public-code":3}
comprehension  items 64 · searched/final 48 · held back 16 · never used 0 (0%) · families 8 · held items sharing a family with tuned items 16/16
recall         items 62 · searched/final 46 · held back 16 · never used 0 (0%) · families 0 · held items sharing a family with tuned items 0/16

longest prompt: 4704 characters (about 1176 tokens)

device                                     12  0.1%
quality (context, KV cache)               180  1.0%
speed (flash, mmap, batch, threads)       102  0.6%
sampling, 3 tasks                        7596  43.3%
prompt, 3 tasks                          9240  52.7%
  of which the systemPrompt axis         7500  42.8%
held-back check                           402  2.3%
one pass, upper bound                   17532  ≈ 14.6 h at 3 s/answer
```

</details>

---

## Appendix B: node-llama-cpp 3.22.2 options checked

These were read from the published package's type definitions (`dist/evaluator/LlamaContext/types.d.ts`,
`dist/evaluator/LlamaChatSession/LlamaChatSession.d.ts`, `dist/bindings/Llama.d.ts`,
`dist/gguf/insights/GgufInsights.d.ts`), not from memory.

- **Context:** `threads` (a number, or `{ ideal, min }`); `batchSize`; `flashAttention`;
  `experimentalKvCacheKeyType` and `experimentalKvCacheValueType` (set separately); `swaFullCache`; `sequences`;
  `batching`; `lora`; `performanceTracking`.
- **Prompt:** `temperature`, `minP`, `topK`, `topP`, `seed`; `xtc { probability, threshold }`; `repeatPenalty`
  `{ lastTokens, punishTokensFilter, penalizeNewLine (default true), penalty, frequencyPenalty, presencePenalty }`;
  `dryRepeatPenalty { strength (recommended 0.8), base, allowedLength, lastTokens, sequenceBreakers }`;
  `tokenBias`; `customStopTriggers`; `responsePrefix`; `trimWhitespaceSuffix`;
  `budgets { thoughtTokens, commentTokens }`; `evaluationPriority`.
- **Memory:** `getVramState()` (`total`, `used`, `free`, `unifiedSize`); `getRamState()`;
  `getLlamaMemoryUsage()` (`gpuVram`, `cpuRam`); `GgufInsights.estimateContextResourceRequirementsV2()` (context
  size, offloaded layers, batch size, sequences, flash attention, K and V types, mmap, `swaFullCache`).
