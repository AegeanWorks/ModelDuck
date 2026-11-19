# ModelDuck Implement List — 2026-11-04
Source: 107 Approved+Proposed verified this session (all deep-checked except 13 target-checked KEEP, 3 stale wrong-target, 2 duplicate, 1 deep-checked+stale). Registry valid.

## Wave 1 — implement now (Low risk, mostly Low effort)
### A. Correctness (4)
- IDEA-1200 Template-exact accounting loud failure (High/Low) — engine.js:1010-1017 returns 0 disabling strict guard
- IDEA-1163 Model-keyed grammar cache (Med/Low) — engine.js:98 single slot, no model key, never cleared
- IDEA-1381 Downloader fsync discipline (Med/Low) — downloader.js:275 raw rename, fs-atomic best-effort only
- IDEA-1627 Determinism lockdown batch-1 + triple-run (Med-High/Low) — matrix.mjs:23 batch 512, no gate

### B. OpenAI contract package (4 as one)
- IDEA-1080 Stop-sequence gate (High/Med) — openai.js:79-102 ignores stop
- IDEA-1085 Typed finish taxonomy (Med/Low) — openai.js:115-117 length|stop only
- IDEA-1264 Parameter contract refusal (Med-High/Low) — silently ignores logit_bias etc
- IDEA-0859 (Deferred unpark) per-request response_format — reuses #grammarFor

### C. Provenance package (4 as one)
- IDEA-1067 Install receipt (Med-High/Low) — downloader.js:275-279 no receipt
- IDEA-1194 Artifact receipt digest+quant+backend+runtime (Med-High/Med)
- IDEA-1195 Partial resume identity (Med-High/Med) — size-only resume
- IDEA-0855 (Deferred unpark) full provenance introspection

### D. Settings/library (5)
- IDEA-1070 Symlink boundary (Med-High/Low) — registry.js:97-99 isFile drops symlinks
- IDEA-1097 Schema-fenced settings (Med/Low) — settings.js:19-30 version never read
- IDEA-1160 Reply-budget clamp (Med-High/Low)
- IDEA-1162 Schema preflight 400/422 (Med-High/Low)
- IDEA-1675 Per-model template registry (Med/Low)

### E. Streaming/load + memory honesty (7)
- IDEA-1197 Batched SSE backpressure (High/Low) — http.js:137-143 ignores write return
- IDEA-1094 Cancelable load (High/Med) + IDEA-1095 teardown receipt + IDEA-1158 phase machine (trio)
- IDEA-1637 GGUF preflight+estimate glue (Med-High/Low)
- IDEA-1064 Quant ladder (Med-High/Med) + IDEA-1065 RSS calibration (High/Med) + IDEA-0954 KV contract

### F. Bench/docs honesty (8 cheap)
- IDEA-1617 Q8_0 lossless ref gate (High/Low)
- IDEA-1504 Code-needle chain scoring (High/Low)
- IDEA-1580 Fixed-budget quotas (Med-High/Low)
- IDEA-1618 Q4_K_M drift disclosure, IDEA-1623 fixed-bytes Q5 disclosure, IDEA-1496 temp-as-cost preset, IDEA-1621 imatrix disclosure, IDEA-1644 threat-model doc, IDEA-1676 reasoning-off default

### G. Land Integrating (4)
- IDEA-0853 multi-part resume, IDEA-0862 hash half, IDEA-0882 atomic promotion, IDEA-0903 memory-fit preflight

## Wave 2 — needs decision (auth/UX/scope)
- IDEA-0995 HF URI resolver (biggest user unlock, needs guardrails)
- IDEA-0997 Thinking pipeline (unlocks 1266)
- IDEA-1051→1052→1053→1055 LAN pairing chain (unblocked by 1054) + IDEA-1024 graceful drain
- IDEA-1520 canonical sampler chain (subsumes 1380/1523), IDEA-1522 Modelfile, IDEA-1524 probe-measure-pin

## Explicitly NOT implementing
- Duplicate: 1449 (=1345), 1523 (=1380/1520)
- Stale/wrong-target (re-file to crucible/ChatDuck/neurocore): 1475, 1578, 1592, 1662
- ChatDuck-side (reject here): 1166, 1167, 1196, 1199, 1226, 1227 + Deferred-A rejects 1066, 1068, 1075, 1081, 1083, 1086, 1092, 1165
- Hold (needs design/runtime): 1074, 1076, 1082, 1087, 1098, 1192, 860/861/871, 904/905/940/941

Total tagged this session: 32 ops (4 Approved upgrades, 9 Proposed-A, 19 Proposed-B incl. 3 stale). Registry valid.

## Wave 3 — analysis of 2026-11-19 (engines, serving, process)
Method: read the engine, serving and installer code; grepped the server's exposure and the UI; ran `tune:gate`, `ui:smoke` (4 of 5 runs passed) and the engine tests; compared the code with the README and ADR-151..168. Each item cites what was seen. Not a security finding list: the server's cross-site, DNS-rebinding and loopback checks (`src/http.js`) were read and hold.

### Gaps (a feature the app should have and does not)
1. **No manual engine choice.** `POST /api/models/:id/load` ignores `body.engine`; the engine comes only from a tuned profile (`src/server.js`, the `applied?.settings` spread). An untuned model always runs in-process even where `llama-server` is ~1.3–2.6× faster here. The UI has no engine selector.
2. **No engine listing outside the CLI.** What is installed, its version, whether it can run here and what it measured exists only in `npm run engines` and `<model>.engines.json`.
3. **The "best speed engine for this model" verdict is CLI-only.** The Bench engine table shows the rows, not the answer (ADR-166 era `bestEngineLine`).
4. **A crash after start has no reason.** `LlamaServerBackend` keeps stderr in a local variable used only for start failures; a later `engine_crashed` says "it exited with N" and nothing else.
5. **Installer covers four platform keys** (win32-x64, linux-x64, darwin-arm64, darwin-x64). Windows-on-ARM and Linux-on-ARM silently get the in-process engine only.
6. **Attached servers (vLLM-style) cannot be saved in a profile**, by design (ADR-159), and the tune adopting one is verified against fakes only.
7. **Auto-install runs only from `start.bat`.** macOS and Linux users must know to run `npm run engines:install`.

### Verification debt (built, not proven)
- CUDA and Metal builds, Ollama against a real server, a real ik_llama.cpp or BitNet build, POSIX hard-kill of the app, and the downloaded-but-unrun shimmy and mistral.rs binaries (running them needs the user's permission).
- The port-retry's bind-failure match (ADR-168) is checked against test text, not the real binary's message.

### Bugs and fragilities
- `ui:smoke` failed once in five runs ("the Bench suite did not render three tasks", a 15 s wait); the endpoint itself answers in ~0.2 s. Cause not found.
- Attached-server prompt speed includes queueing (a 30 k tok/s figure appeared); labelled in the report but it can mislead a ranking by prompt speed.
- Download timeout is a 30-minute total, not an idle limit.
- `src/engine-env.js` is named by no test.

### Process and structure
- Two ledger tasks (`engines-add`, `engine-start-hardening`) are open; closing them needs a named human reviewer for the UI (the kit forbids an unnamed `--reviewed`).
- README is 37,490 of 37,500 characters: no headroom. Any README change must first move text into `docs/`.
- Size hotspots: `public/app.js` 4,075 lines, `src/engine.js` 1,777, `src/server.js` 1,288, `src/external-engines.js` 826 (backends, `ServerEngine` and `RoutedEngine` in one file).

### Plan (each phase ships alone: failing-first test, ADR, gates, commit)
| # | Work | Why first | Size | Needs from the user |
|---|---|---|---|---|
| 1 | Keep llama-server's stderr tail and put it in `engine_crashed` (gap 4) | Smallest, helps every later debug | S | none |
| 2 | `GET /api/engines` (id, label, version, available, last speed from `<model>.engines.json`) and `engine` accepted by the load route, refused with a Why/Fix when unknown or not servable (gaps 1, 2) | The API the UI needs; makes "serve with the fastest" usable before a tune | M | none |
| 3 | Bench/Models UI: engine selector on load, "best for this model" line, registered builds visible (gaps 1, 3) | The hackathon-visible part | M | a named UI reviewer for `ui finish` |
| 4 | Platform notice: say plainly, in `engines:install` and the Server tab, when no prebuilt exists for this machine (gap 5); optionally auto-run the installer from `npm start` on first launch for macOS/Linux (gap 7) | Removes a silent degrade | S | decide whether `npm start` may download |
| 5 | Idle-timeout download and a `--retry` on transient network errors | Slow links | S | none |
| 6 | Real-hardware pass: run shimmy, mistral.rs, LM Studio, Ollama through `--openai-engine`; record numbers in `docs/ENGINES.md` | Turns candidates into measured facts | M | permission to run the downloaded binaries (or use LM Studio, already installed) |
| 7 | Find the `ui:smoke` flake: log timing of the suite fetch and render on a loaded machine; raise or fix the wait | Keeps the gate trustworthy | S | none |
| 8 | Split `src/external-engines.js` (backends vs `ServerEngine`/`RoutedEngine`) and `src/engine-env.js` test | Maintainability before more engines | M | none |
| 9 | README headroom: move the quick-reference detail into `docs/` | Unblocks every later README edit | S | none |
| 10 | Close the two ledger tasks | Clean state | S | the UI reviewer's name |

Not planned: more engine descriptors until phase 6 shows which candidates are worth shipping; pushing anything.
