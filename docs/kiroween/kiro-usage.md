# Kiro Usage in ModelDuck

This document explains specifically how Kiro (the AI-powered development
environment) was used during ModelDuck's development for Kiroween 2026.

---

## Kiro technology used

### Vibe sessions (conversational coding)

Kiro's Vibe mode was the primary mode for iterative development. Each session
started with the steering context (project overview, coding standards, agent
mode guide) already loaded, so Kiro immediately understood:
- The module conventions (`AppError`, `fs-atomic`, `state-machine.js`)
- The test budget (20 ms unit / 1 000 ms integration)
- The benchmark gate (`npm run tune:gate`)
- Files that must not be overwritten (baseline JSONs, the ADR register)

Representative Vibe session topics:
- Designing the GGUF header pre-validation guard (`src/gguf-guard.js`, ADR-019)
- Working out the cross-site / DNS-rebind protection logic (ADR-018)
- Writing unit tests for `src/fs-atomic.js` and `src/state-machine.js`
- Debugging the generation manifest fingerprint mismatch across sessions

### Spec sessions (structured feature development)

Spec sessions were used for the larger, multi-file features:
- **Benchmark tuner architecture** — the requirements → design → task breakdown
  for `benchmarks/tune.mjs` and its 14 supporting files
- **Parallel tune scheduler** — `src/tune-scheduler.js` + `src/tune-lock.js`
- **Archive chat overflow** — `src/chat-store.js` ADR-020
- **LAN authentication hardening** — ADR-009 + ADR-018 security model

Each Spec session produced a task list of ≤6 milestones, each ending with a
passing `npm test`.

### Steering documents

Three always-loaded steering documents direct every session:

| File | Contents |
|---|---|
| `.kiro/steering/project-overview.md` | Architecture, directories, dev commands |
| `.kiro/steering/coding-standards.md` | ES modules, error handling, atomic writes, test budget |
| `.kiro/steering/kiro-agent-mode.md` | Session workflow, do/don't list, hook hints |

These documents were themselves created with Kiro and committed to the
repository so future sessions (and future contributors) start from the same
shared model of the codebase.

### Spec file

`.kiro/specs/kiro-agent-mode-integration.md` formalises the requirements and
design for how Kiro sessions interact with this workspace — including the
steering file inclusion model, hook definitions, and task breakdown.

---

## What Kiro did that would have taken much longer by hand

1. **Statistical test harness for the tuner.** The Holm-corrected pairwise
   comparison, stopping rules, and noise-floor reporting required multiple
   iterations to get right. Kiro's ability to reason about the statistical
   contract (not just write the code) compressed what would have been days of
   iteration into hours.

2. **State-machine inventory.** `docs/state-machines.md` documents 25 implicit
   lifecycle machines across the codebase. Kiro helped trace every state
   transition from the source and identify gaps.

3. **Test coverage for edge cases.** Many of ModelDuck's 80+ test files cover
   adversarial inputs (malformed GGUF headers, corrupt settings files, race
   conditions in the download manager). Kiro generated the test scaffolding and
   the edge-case scenarios, which were then verified against the real code.

4. **Security hardening.** ADR-018 and ADR-019 came from a systematic threat
   analysis Kiro helped conduct, using `docs/THREAT-MODEL.md` as the starting
   point.

---

## Kiro workspace artefacts committed

```
.kiro/
  steering/
    project-overview.md
    coding-standards.md
    kiro-agent-mode.md
  specs/
    kiro-agent-mode-integration.md
```

---

## What Kiro was explicitly not used for

- Running the application (all runs were done manually).
- Downloading or evaluating model files.
- Running benchmarks.
- Making commits or pushes (all git operations were user-controlled).
- Replacing baseline benchmark files.
