# Project Guidelines

Rules for this project only, written by people or AI agents. They add to AIKit's principles and
rank below them: a guideline never overrides a principle (PRINCIPLE-000 R6, PRINCIPLE-001 R4).
Add one with `python aikit.py guideline <name> "<rule>" --source <user|ADR-NNN|person>`, or by
hand as one line below in the form `- **G-NNN** (source): rule`; IDs are never reused.

Persisted state carries a format version. A loader refuses a version it does not support,
without modifying or quarantining that file; older versions migrate when a migration exists.

## Rules
- **G-001** (user, ADR-027): Every change that can affect generation, prompt construction, settings application or the chat UI must run `npm run tune:gate` on the three core models and compare each task's quality and speed with that model's stored profile baseline; a task-rate drop beyond the tune tolerance is a regression. Cross-model comparison (`npm run bench` or `npm run bench:full`) is optional and never gates.
- **G-002** (user): Every benchmark run is stored in benchmarks/history.sqlite and appended to benchmarks/history.jsonl; after committing the benchmarked change, run npm run bench:link to attach the run to its commit, and keep the JSONL history tracked.
- **G-003** (user, ADR-027): Tune results are comparable only when suiteVersion, the task-subset hash and the runtime match; any prompt, check, task subset or sweep change bumps SUITE_VERSION, updates benchmarks/CHANGELOG.md and requires a deliberate profile-baseline update. The optional cross-model baseline may lag the suite version.
- **G-004** (user): Presets are benchmark candidates: they fill the settings form only and are never applied automatically until a benchmark run has recorded their quality and speed.
- **G-005** (user, ADR-027): A tune has two stages: model-load settings first (one load config per model, chosen for speed and memory without losing quality), then sampling settings per task on that config; both stages must be recorded before a profile is applied.
- **G-006** (user): The project's LICENSE file stays unchanged: never modify or replace the current license.
