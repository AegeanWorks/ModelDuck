# How Kiro Was Used to Build ModelDuck

> This is the write-up for the Devpost "how Kiro was used" field.
> Paste the section below the horizontal rule into the Devpost form.

---

## Kiro write-up (paste into Devpost)

ModelDuck was built using **Kiro IDE** in both Vibe and Spec modes across the
entire development period. Here is a concrete account of each Kiro feature used.

---

### Kiro IDE — Vibe and Spec sessions

**Vibe sessions** were the daily driver for iterative work. Because the steering
documents (see below) were always loaded, every session opened with Kiro already
knowing the module conventions, the error-handling contract (`AppError`), the
atomic file-write pattern (`fs-atomic.js`), the test budget (20 ms unit /
1 000 ms integration), and the files it must never overwrite (baseline JSONs,
the ADR register). This eliminated the ramp-up overhead that makes AI coding
assistants frustrating on complex codebases.

Representative Vibe sessions:
- Designing and implementing the GGUF header pre-validation guard
  (`src/gguf-guard.js`, ADR-019) — a bounded walk of the binary header to
  refuse malformed counts before any parser runs
- Working out the cross-site / DNS-rebind protection logic (ADR-018) — Host
  and Origin header checks that stop a web page from silently proxying requests
  to the local model server
- Debugging the generation manifest fingerprint mismatch across multi-turn
  sessions (ADR-008)
- Writing adversarial unit tests: malformed GGUF headers, corrupt settings
  files, concurrent download race conditions

**Spec sessions** structured the larger multi-file features:
- **Benchmark tuner architecture** — the requirements → design → task breakdown
  for `benchmarks/tune.mjs` and its 14 supporting files. Kiro drafted the
  milestones; each one ended with a passing `npm test`.
- **Parallel tune scheduler** — `src/tune-scheduler.js` + `src/tune-lock.js`:
  device probe first, then 1 CPU lane and up to 2 GPU lanes; speed measurements
  pause competing tunes to keep CPU measurements comparable.
- **LAN authentication hardening** — ADR-009 + ADR-018: Kiro mapped all the
  ways an unauthenticated local request could reach settings or model controls,
  then proposed the `isCrossSiteRequest` check and the LAN-requires-auth gate.

The Spec workflow (requirements → design → tasks) meaningfully improved
development quality compared to pure vibe coding: the design phase caught
circular dependencies and state-machine gaps before a line of code was written.

---

### Steering documents

Three always-loaded steering documents live in `.kiro/steering/`:

| File | What it tells Kiro |
|---|---|
| `project-overview.md` | Architecture, all directories, dev commands, regression gates |
| `coding-standards.md` | ES modules only, `AppError` contract, `fs-atomic` pattern, test budgets, files that must never be changed without instruction |
| `kiro-agent-mode.md` | Session workflow, what Kiro should always do, what it must never do without explicit approval |

The steering strategy that made the biggest difference: listing the **off-limits
files** explicitly (`benchmarks/baseline-*.json`, `benchmarks/history.jsonl`,
`.aikit/decisions.md`). Without this, a Vibe session on the benchmark pipeline
could silently update a baseline and invalidate weeks of measurements. With it,
Kiro consistently flagged when a proposed change would touch those files and
asked for explicit confirmation.

A secondary benefit: the coding standards document meant Kiro never proposed
`require()`, never reached for an npm package when the standard library covered
the need, and always used `AppError` for user-visible failures — style
consistency across 34 source files with zero manual review passes.

---

### Spec-driven development

`.kiro/specs/kiro-agent-mode-integration.md` formalises the requirements and
design for how Kiro sessions interact with this workspace — including the
steering file inclusion model, hook definitions and task breakdown.

The staged tuner was the most complex Spec. It spans: device probe → context
+ KV cache → speed settings (threads, batch, flash attention) → sampling per
task → prompt per task. Each stage had its own requirements (what counts as a
win, what stops early, how ties are broken) before Kiro wrote any code.
The spec caught an ambiguity in the stopping rule — "stop when no candidate
beats the control" vs "stop when no candidate beats *the current best*" — that
would have produced wrong results silently if we had gone straight to code.

---

### Agent hooks

`.kiro/hooks/` (described in the steering and spec) can automate:
- **PostFileSave** on `src/**/*.js` → run `npm test` automatically
- **PostTaskExec** → remind Kiro to check whether the completed task affects
  generation and prompt to run `npm run tune:gate`

The hooks prevent the most common quality regression: shipping a source change
without re-running the benchmark gate.

---

### What Kiro accelerated most

The **statistical test harness** for the tuner was the clearest win. Holm-
corrected pairwise comparisons, stopping rules, noise-floor reporting, and
reproducibility checks across versioned benchmark suites required reasoning
about statistical contracts — not just writing code. Kiro compressed what would
have been multiple days of library research and prototype iteration into a
single Spec session. The resulting system (`benchmarks/stats.mjs`,
`benchmarks/tune-measure.mjs`) correctly attributes a score change to a
parameter only when the test hash, runtime version and model file all match the
baseline — a constraint that is easy to state but surprisingly hard to implement
without gaps.

---

### What Kiro was not used for

- Running the application, downloading models or executing benchmarks
- Making git commits or pushes (all version-control operations were manual)
- Replacing pinned baseline files
