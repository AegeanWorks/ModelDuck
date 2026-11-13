# Using Kiro Agent Mode with ModelDuck

This document is the operational guide for running Kiro's Vibe or Spec sessions
on the ModelDuck codebase.

---

## Before starting any Kiro session

1. **Read the project overview** in `.kiro/steering/project-overview.md`.
2. **Read the coding standards** in `.kiro/steering/coding-standards.md`.
3. Run `npm test` and confirm it is green. Do not start a session on a broken tree.
4. For generation-affecting work, record whether `npm run tune:gate` is currently passing.

---

## Recommended session types

### Vibe session — small, focused changes

Use Vibe for:
- Fixing a specific test failure.
- Adding a missing API field.
- Refactoring one module.
- Writing a new test file.

Vibe is fast. Keep sessions under ~10 file changes.

### Spec session — structured feature development

Use Spec for:
- Adding a new tuner stage.
- Extending the OpenAI API surface.
- Adding a new benchmark phase or task.
- Refactoring a subsystem (e.g. replacing the download manager).

A Spec session should produce: requirements → design → implementation tasks.

---

## Kiro workflow for a typical feature

```
1. Open Kiro → Spec session
2. Describe the feature in one sentence
3. Kiro generates requirements — review and edit
4. Kiro generates design — confirm architecture matches src/ conventions
5. Kiro generates task list — reorder if needed
6. Execute tasks one by one; run npm test after each
7. For generation-affecting changes: run npm run tune:gate last
```

---

## What Kiro should always do in this project

- Read the relevant `src/` modules before editing them.
- Use `AppError` for every user-visible failure.
- Use `src/fs-atomic.js` for every state-file write.
- Add or update tests in `tests/` for every behaviour change.
- Keep `docs/state-machines.json` and `docs/state-machines.md` in sync when
  touching `src/state-machine.js`.
- Respect the `.gitignore` — never stage `*.gguf`, `benchmarks/results/`,
  or `benchmarks/history.sqlite`.

## What Kiro must never do without explicit user approval

- Replace a baseline file (`benchmarks/baseline-*.json`).
- Append to `.aikit/decisions.md` (the ADR register belongs to the AIKit gate).
- Modify `benchmarks/history.jsonl`.
- Change `package-lock.json` to a different version of `node-llama-cpp`.
- Push directly to `origin/master`.

---

## Hooks available in this workspace

Two hooks live in the workspace's `.kiro/hooks/`, which is the AIKit folder that
holds `projects/modelduck`. They match only ModelDuck paths:

- **modelduck-test-on-save** (PostFileSave on `src`, `benchmarks`, `tests` or
  `public` `.js`/`.mjs`): runs `npm --prefix projects/modelduck test`. The suite
  is hermetic, takes about 10 s, and needs no model or network.
- **modelduck-tune-gate-reminder** (PostFileSave on the generation path:
  `engine`, `sampler-chain`, `checkpoint-policy`, `config`,
  `generation-manifest`, `tune*`, `tasks`, `suite`): reminds Kiro that
  `npm run tune:gate` is due before commit (G-001), and that `--update-baseline`
  needs the user's explicit request.

Neither hook starts the server or downloads a model.

## Fast paths Kiro should know

- `npm run tune -- --model <id> --quick --budget 5`: a time-boxed tune that
  saves the best settings so far. It ends with a `Time …` line that splits the
  wall time into generate, load and judge.
- `--parallel <2-4|auto>`: opt-in wide answers. A probe first requires
  byte-identical answers and at least 15% less wall time. It often refuses on a
  CPU, and that is the intended result.
- Bench & Tune → Shipped presets → **Apply**: one click, never automatic
  (G-004).
- `npm run bench:multistep -- --model <id>`: opt-in multistep chains. They are
  outside `PROMPTS` and `TASKS`, so they change no gated hash. Keep it that way:
  do not add them to `TASKS`.

---

## Useful context for Kiro

- The state machine is the single source of truth for engine states.
  Read `src/state-machine.js` and `docs/state-machines.json` before touching
  engine load/unload logic.
- The generation manifest (`src/generation-manifest.js`) fingerprints every
  reply. Any change to prompting, history handling or template selection must
  account for manifest compatibility.
- LAN and CORS security rules are in `src/server.js` (`isCrossSiteRequest`).
  Do not relax them without understanding `docs/THREAT-MODEL.md`.
- Benchmark baselines are pinned. A test-hash change requires a deliberate
  `--update-baseline` pass and a `benchmarks/CHANGELOG.md` entry.
