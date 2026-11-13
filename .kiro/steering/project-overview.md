# ModelDuck — Project Overview for Kiro

## What ModelDuck is

ModelDuck is a local GGUF model server and coding-model tuner. It loads a model,
serves an OpenAI-compatible API (`/v1/chat/completions`, `/v1/completions`,
`/v1/models`), and tunes it for code quality. Everything runs on the CPU or a
Vulkan GPU; no cloud account, no telemetry, no model weights bundled.

The companion chat client is [ChatDuck](https://github.com/AegeanWorks/Chatduck).
ModelDuck itself is the control panel: Models, Bench & Tune, Settings, Server.

## Repository

- GitHub: https://github.com/AegeanWorks/ModelDuck
- License: Aegean License 1.1 (AL-1.1) — personal-use source-available
- Runtime: Node.js 20+, single dependency (`node-llama-cpp 3.22.2`)

## Architecture in one paragraph

`src/main.js` parses CLI flags, acquires a home-folder lock, starts
`src/server.js` (HTTP + SSE), and optionally opens a browser window.
The inference core lives in `src/engine.js` (node-llama-cpp session lifecycle).
Everything else (`downloader.js`, `model-registry.js`, `server-settings.js`,
`tuned-settings.js`, `tune-scheduler.js`, …) communicates through
`src/state-machine.js` and the REST API; the UI (`public/`) is a no-framework
vanilla JS app served as static files.

## Key directories

| Path | Purpose |
|---|---|
| `src/` | Server, engine, download, settings, benchmark runners |
| `public/` | Vanilla JS/CSS control panel (no build step) |
| `benchmarks/` | Seeded quality-and-speed benchmark suite (node:test) |
| `tests/` | Unit and integration tests (node:test, 88 test files) |
| `docs/` | Threat model, state-machine inventory |
| `assets/` | Logo, social preview, screenshots, demo video script |
| `scripts/` | Screenshot capture, parallel test runner, UI smoke check |

## Development quick-start

```bash
npm install          # first run only
npm start            # starts on http://127.0.0.1:4141
npm test             # full test suite
npm run dev          # file-watch restart mode
npm run ui:smoke     # headless control-panel sanity check (needs Node 22+)
npm run tune -- --model <id> --quick --budget 5   # time-boxed tune, best-so-far saved
npm run bench:multistep -- --model <id>           # opt-in multistep chains, not gated
```

## Regression gates

1. **npm test** — full unit + integration suite (must be green before any commit)
2. **npm run tune:gate** — re-measures three core models' baseline settings
   (G-001); required before committing any generation-affecting change

## Where user data lives

| Item | Default path |
|---|---|
| Models | `~/.modelduck/models/` |
| Settings | `~/.modelduck/settings.json` |
| Tuned profiles | `~/.modelduck/profiles/` |
| Tune runs | `~/.modelduck/tune-runs/` |

Override with `--home <dir>` or `MODELDUCK_HOME=<dir>`.
