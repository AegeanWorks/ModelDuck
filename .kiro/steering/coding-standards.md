# ModelDuck — Coding Standards and Conventions

## Language and runtime

- **JavaScript (ES modules)**, Node.js 20+.
- All files use `import`/`export`; no CommonJS `require`.
- The project has exactly one production dependency: `node-llama-cpp 3.22.2`.
- Tests use Node's built-in `node:test` runner — do not add Jest, Vitest, etc.

## File naming

- Source modules: `kebab-case.js` in `src/`.
- Test files: `kebab-case.test.js` in `tests/`.
- Benchmark files: `kebab-case.mjs` in `benchmarks/`.

## Error handling

Every user-visible failure must be an `AppError` from `src/errors.js`.
- `AppError` carries `statusCode`, `code`, `why` and `fix`.
- Never throw a plain `Error` from a route handler or engine method.
- The HTTP layer converts AppErrors to JSON; unrecognised errors become `500`.
- Load and generation errors go through `src/engine-errors.js`
  (`toLoadError` / `toGenerationError`).

## Atomic file writes

All state files (settings, profiles, tune steps, server settings) must use
`src/fs-atomic.js`:
- Write to a temp file, `fsync`, then `os.rename` (atomic swap).
- Keep a `.bak` backup of the previous version.
- Quarantine corrupted files rather than deleting them.
- Never write state without acquiring the home-folder lock first.

## State machines

All subsystem states (engine, downloads, benchmark jobs) are declared in
`src/state-machine.js`. Legal transitions are listed there. When adding a new
state or transition:
1. Add it to `state-machine.js`.
2. Add or update the corresponding entry in `docs/state-machines.json`.
3. Update `docs/state-machines.md`.

## API and security rules

- Only loopback bindings are accepted by default.
- Every request checks `Host` and `Origin` headers (`isCrossSiteRequest`).
- LAN or CORS mode requires Require Authentication to be on.
- API key hashes (SHA-256) are stored; raw keys are shown once and discarded.
- No request ever writes outside `--home`; no outbound network requests
  except model downloads the user starts.

## Tests

- Run before every commit: `npm test`
- Tests must be hermetic (no real model files, no real network).
- Use `beforeEach`/`afterEach` with `tmp` dirs and `cleanup` hooks.
- Per-test wall-clock budget: 20 ms unit, 1 000 ms integration.

## Benchmark gate (G-001)

Any change that can affect generation, prompt construction, settings application
or the chat UI must also pass `npm run tune:gate`. Do not skip it.

## Code that Kiro must not touch without explicit instruction

- `benchmarks/baseline-model.json`
- `benchmarks/baseline-chat.json`
- `benchmarks/baseline-profiles.json`
- `benchmarks/history.jsonl`
- `.aikit/task_ledger.json`
- `.aikit/decisions.md` (append-only ADR register)
