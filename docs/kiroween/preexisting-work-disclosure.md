# Pre-existing Work Disclosure — ModelDuck / Kiroween 2026

This document distinguishes work that existed before the Kiroween 2026 hackathon
period from work that was genuinely created during it with Kiro assistance.

---

## What is entirely pre-existing (not new hackathon work)

### AIKit (portable_agent_kit)

The parent repository (`portable_agent_kit`) is AegeanWorks' AIKit framework —
an AI governance, delivery-gate and disruption-recovery system. It is a
separate public project with its own history, license (AL-1.1) and test suite.
It is not part of ModelDuck; ModelDuck is registered as a child project inside
it. AIKit provides:
- `python aikit.py` CLI for project management
- `.aikit/` metadata conventions (project.json, decisions.md, guidelines.md, etc.)
- Disruption-recovery scripts, regression gates, principle files

None of AIKit's source code is included in the ModelDuck distribution or the
test build.

### node-llama-cpp

ModelDuck's only production dependency is `node-llama-cpp 3.22.2`, a
pre-existing open-source Node.js binding for llama.cpp maintained by
ItamarRocha. It is a standard npm package. Its license is MIT (included in
`node_modules/node-llama-cpp/LICENSE`). ModelDuck uses it as a black box; no
fork or modification was made.

### Public benchmark datasets

`benchmarks/public-items.mjs` includes items derived from:
- GSM8K (MIT © OpenAI)
- MMLU (MIT © Hendrycks et al.)
- HumanEval (MIT © OpenAI) — translated from Python to JavaScript
- MBPP sanitized (CC BY 4.0 © Google LLC) — translated to JavaScript
- TruthfulQA (Apache-2.0 © Lin, Hilton, Evans)

These datasets are pre-existing publicly available research artifacts.
Full attribution is in `benchmarks/NOTICE-benchmarks.md`.

### Benchmark item translations (HumanEval, MBPP)

The JavaScript translations of HumanEval and MBPP test cases were produced
prior to the hackathon period as part of ModelDuck's benchmark suite
development. The translations are covered by the respective dataset licenses
(MIT and CC BY 4.0).

---

## What was built during the hackathon period with Kiro

The following represent the genuinely new Kiro-assisted work:

### Core application (substantial new code)

ModelDuck itself was developed as a new project. The following modules were
created during the development period:
- `src/` — all 34 source modules
- `public/` — the control panel (index.html, app.js, styles.css)
- `benchmarks/` — the full benchmark and tuner pipeline
- `tests/` — 80+ test files
- `docs/` — threat model, state machine inventory
- `scripts/` — screenshot capture, parallel test runner, UI smoke check

The architectural decisions are recorded in `.aikit/decisions.md` (ADR-001
through the current ADR count), each dated.

### Kiro workspace

The `.kiro/` directory was created specifically for Kiroween 2026:
- `.kiro/steering/project-overview.md`
- `.kiro/steering/coding-standards.md`
- `.kiro/steering/kiro-agent-mode.md`
- `.kiro/specs/kiro-agent-mode-integration.md`

### Hackathon submission documents

- `JUDGES.md`
- `docs/kiroween/submission.md`
- `docs/kiroween/kiro-usage.md`
- `docs/kiroween/preexisting-work-disclosure.md` (this file)
- `docs/kiroween/final-checklist.md`

### Key features developed with Kiro assistance

| Feature | ADR | Kiro contribution |
|---|---|---|
| GGUF header pre-validation guard | ADR-019 | Design + implementation of `src/gguf-guard.js` |
| Cross-site / DNS-rebind protection | ADR-018 | Threat analysis + `isCrossSiteRequest` logic |
| Generation manifest fingerprinting | ADR-008 | Statistical design + `src/generation-manifest.js` |
| Parallel tune scheduler | — | Architecture + `src/tune-scheduler.js` |
| Memory-fit pre-load check | ADR-021 | GGUF KV-shape math + `src/memory-fit.js` |
| State-machine inventory | ADR-388 | Tracing 25 implicit machines across the codebase |
| Archive chat overflow | ADR-020 | Design + `chats.archive.json` protocol |

---

## AegeanWorks components reused

ModelDuck uses the **AIKit project conventions** (`.aikit/` metadata format,
the `decisions.md` ADR pattern, the `guidelines.md` project-rules convention)
but does not include any AIKit Python source code. These conventions are
lightweight bookkeeping formats, not code.

---

## Summary table

| Item | Status | License |
|---|---|---|
| AIKit framework | Pre-existing, not in distribution | AL-1.1 |
| node-llama-cpp 3.22.2 | Pre-existing npm package | MIT |
| GSM8K / MMLU / TruthfulQA items | Pre-existing datasets | MIT / Apache-2.0 |
| HumanEval / MBPP items (JS translation) | Pre-existing in suite | MIT / CC BY 4.0 |
| ModelDuck application code | New hackathon work | MIT |
| ModelDuck benchmark pipeline | New hackathon work | MIT |
| ModelDuck tests | New hackathon work | MIT |
| `.kiro/` workspace | New for Kiroween 2026 | MIT |
| Submission docs | New for Kiroween 2026 | MIT |
