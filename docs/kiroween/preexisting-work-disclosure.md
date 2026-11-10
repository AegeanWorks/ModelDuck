# Pre-existing Work Disclosure

> Paste the section below the horizontal rule into the Devpost
> "pre-existing work" or "additional info" field.

---

## Pre-existing work disclosure (paste into Devpost)

ModelDuck was started on **October 30, 2026** (the first day of the submission
period). All application source code, tests and documentation were written
during the hackathon period with Kiro assistance.

The following pre-existing components were used but not created for this
hackathon:

**node-llama-cpp 3.22.2** — the only production dependency. A pre-existing
MIT-licensed npm package by ItamarRocha that provides Node.js bindings for
llama.cpp. ModelDuck uses it as a black box; no fork or modification was made.

**Public benchmark datasets** — items in `benchmarks/public-items.mjs` are
derived from GSM8K (MIT © OpenAI), MMLU (MIT © Hendrycks et al.), HumanEval
(MIT © OpenAI, translated to JavaScript), MBPP sanitized (CC BY 4.0 ©
Google LLC, translated to JavaScript), and TruthfulQA (Apache-2.0 © Lin,
Hilton, Evans). Full attribution is in `benchmarks/NOTICE-benchmarks.md`.
The JavaScript translations of HumanEval and MBPP were written before the
hackathon period.

**AIKit project conventions** — ModelDuck lives inside the
[AegeanWorks/AIKit](https://github.com/AegeanWorks/AIKit) monorepo as a child
project. AIKit provides project-management CLI tooling (Python, separate repo,
AL-1.1 license). None of AIKit's source code is included in ModelDuck; only
its lightweight `.aikit/` bookkeeping conventions (ADR register, project
metadata) are used. These are not code.

Everything else — all 34 `src/` modules, the vanilla JS control panel, the
80+ test files, the full benchmark and tuner pipeline, the security hardening,
the state-machine inventory, and the `.kiro/` workspace — was written during
the hackathon period.
