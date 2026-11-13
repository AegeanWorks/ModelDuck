# Spec: Kiro Agent Mode Integration for ModelDuck

**Status**: Active  
**Created**: 2026-11-10  
**Purpose**: Define how Kiro's Vibe and Spec sessions interact with the
ModelDuck codebase, what steering context is provided, and how agent-mode
tasks are structured.

---

## Requirements

### R-001 — Steering documents are always loaded

Every Kiro session on this workspace must have access to:
- `.kiro/steering/project-overview.md` — architecture, directories, commands
- `.kiro/steering/coding-standards.md` — ES module conventions, AppError, fs-atomic
- `.kiro/steering/kiro-agent-mode.md` — session workflow, do/don't lists

These files are `inclusion: always` (default) so they appear in every session.

### R-002 — Agent does not break the regression suite

After any Kiro-assisted change, `npm test` must still pass. The steering
documents instruct Kiro to run the test suite and report failures before
declaring a task done.

### R-003 — Agent does not replace pinned benchmarks

Kiro must never overwrite `benchmarks/baseline-*.json` or
`benchmarks/history.jsonl` without an explicit instruction that names
`--update-baseline`. The steering documents list these files as off-limits.

### R-004 — Spec sessions follow ModelDuck's ADR-first pattern

For any feature that changes a contract, a dependency, a data format or the
architecture, the Spec must include a step that drafts a new ADR entry for
`.aikit/decisions.md`. The user approves the ADR text before it is appended.

### R-005 — Hooks can automate quality gates

`.kiro/hooks/` may contain PostFileSave and PostTaskExec hooks that run
`npm test` and remind the agent to run `npm run tune:gate` when relevant.
Hooks must not start the ModelDuck server or download model files.

---

## Design

### Steering file inclusion

| File | Inclusion | Trigger |
|---|---|---|
| `project-overview.md` | always | every session |
| `coding-standards.md` | always | every session |
| `kiro-agent-mode.md` | always | every session |

All three files are under 4 KB and load within the standard context budget.

### Session workflow (Vibe)

```
User describes change
  → Kiro reads affected src/ modules
  → Kiro proposes diff
  → User accepts/rejects per hunk (Supervised mode) or reviews after (Autopilot)
  → Kiro runs npm test via terminal
  → Kiro reports result; requests tune:gate if generation-affecting
```

### Session workflow (Spec)

```
User describes feature
  → Requirements phase: Kiro lists functional + non-functional requirements
  → Design phase: Kiro maps modules to change, new files needed, test plan
  → Tasks phase: Kiro breaks work into ≤6 milestones
  → Execution: each task ends with npm test; tune:gate on last task if needed
  → Wrap-up: draft ADR text if contract changed
```

### Hook definitions (to be created separately)

**PostFileSave — run tests on src save**
- Trigger: `PostFileSave`
- Matcher: `src/.*\.js$`
- Action: `command` → `npm test`

**PostTaskExec — tune gate reminder**
- Trigger: `PostTaskExec`
- Action: `agent` → "If this task changed generation, prompting, settings
  application or the chat UI, remind the user to run `npm run tune:gate`."

---

## Tasks

### Task 1 — Steering files committed to .kiro/steering/

- [x] `project-overview.md` — architecture, directories, gates
- [x] `coding-standards.md` — ES modules, AppError, fs-atomic, test budget
- [x] `kiro-agent-mode.md` — session types, do/don't, hook hints

### Task 2 — This spec file committed to .kiro/specs/

- [x] Requirements, design and task breakdown documented

### Task 3 — .kiro/ added to git tracking

- [x] Confirm `.kiro/` is not in `.gitignore`
- [x] `git add .kiro/` and commit (steering and this spec are tracked)

### Task 4 — Hook files for PostFileSave

- [x] `modelduck-test-on-save`: PostFileSave on ModelDuck `.js`/`.mjs` →
  `npm --prefix projects/modelduck test`
- [x] `modelduck-tune-gate-reminder`: PostFileSave on generation-path files →
  agent reminder for `npm run tune:gate` (G-001); never `--update-baseline`
  without an explicit request

Both are in the workspace root's `.kiro/hooks/` (the AIKit folder), not in this
repository: Kiro loads hooks from the open workspace, and that is the AIKit
folder. A PostFileSave matcher replaced the planned PostTaskExec reminder,
because the reminder is due when a generation-path file changes, not when an
unrelated task completes.

---

## Acceptance criteria

1. `ls .kiro/steering/` lists three `.md` files.
2. `ls .kiro/specs/` lists this spec.
3. `git status .kiro/` shows the directory as tracked (not ignored).
4. A fresh Kiro session in this workspace loads the steering context automatically.
