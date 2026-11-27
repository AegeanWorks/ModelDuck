# Decisions

Why this project is built the way it is, oldest first. One entry per decision that changes a
contract, a dependency, a data format or the architecture; IDs are consecutive and never reused.

<!-- Entry format:
### ADR-NNN: <decision in one line>
- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**: <what forced the decision>
- **Decision**: <what was decided>
- **Consequences**: <what follows, including what it costs>
-->


### ADR-001: Ship a local web app instead of a desktop shell
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The user needs a dependable replacement for LM Studio and Ollama, and asked for the easiest possible install. Electron or Tauri would add a second runtime, packaging pipeline and hundreds of megabytes before the first chat works.
- **Decision**: Serve the UI from the same Node process that runs inference. On Windows, start.bat opens it in an installed Edge/Chrome app window; otherwise the default browser opens. There is no build step and no UI framework.
- **Consequences**: One `npm install` and one `npm start` are enough. Closing the browser window leaves the local server running until Ctrl+C, which the README states. A future native shell can wrap the same HTTP surface without changing the engine.

### ADR-002: One CPU-first llama.cpp context, one generation at a time
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: A 16 GB machine without a usable GPU must load small GGUF models predictably. Multiple contexts multiply KV-cache memory, and parallel generations on the same CPU make every reply slower.
- **Decision**: Use node-llama-cpp with GPU disabled unless `MODELDUCK_GPU=auto`; load one model and one context, reject a second concurrent generation with an actionable 409, and rebuild the chat session from the atomic conversation store when the active conversation changes. Context creation retries at smaller sizes before failing.
- **Consequences**: RAM use stays close to one model plus one context. Switching conversations loses the KV cache and pays prompt processing again. The UI and OpenAI endpoint share one fair queue and cannot corrupt each other's session.

### ADR-003: Benchmark quality and speed on three model classes
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Token throughput alone cannot show whether a change improved the product. The user requires every generation-affecting change to exercise at least three small, different model types and compare the result.
- **Decision**: Add `npm run bench`, a deterministic nine-task suite (instruction following, arithmetic, facts, reasoning, JSON, JavaScript syntax, formatting, list cardinality, long-context recall) run through the real LlamaEngine on SmolLM2 135M, Qwen2.5 0.5B and Qwen2.5 Coder 1.5B. Quality is compared exactly with `benchmarks/baseline.json`; speed is the median generated tokens per second and warns beyond a 20% drop.
- **Consequences**: The gate takes minutes and needs the three model files, so it is an explicit pre-checkpoint step rather than part of `npm test`. Generated code is syntax-checked by `node --check`, never executed. A deliberate quality change requires a reviewed baseline update.


### ADR-004: Keep benchmark history in SQLite with an append-only JSONL export
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Quality and speed only help if each change can be compared with the commit that produced it. A single baseline file has no trend, and a binary database alone is not reviewable in a diff.
- **Decision**: `npm run bench` records each run in a local `benchmarks/history.sqlite` database (`runs`, `model_results`, `prompt_results`, `commits`) and appends the same run to `benchmarks/history.jsonl`. A run made before its commit is marked pending; `npm run bench:link` attaches it to the new HEAD. The JSONL file is tracked and can rebuild the database with `npm run bench:report -- --rebuild`.
- **Consequences**: Progress is queryable per model and per commit without storing model weights. The SQLite file is ignored so binary churn stays out of git, while the tracked JSONL keeps the record reviewable. Node 22+ is needed for `node:sqlite` in the benchmark tooling; the app itself remains Node 20+.


### ADR-005: Separate model-reload and model-usage benchmark gates
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Loading parameters and sampling parameters change different things. Mixing them hides whether a quality delta came from the model file, the KV cache, the context configuration, the sampler or a changed test.
- **Decision**: `npm run bench:model` runs one-factor reload variants and `npm run bench:chat` runs generation/sampling variants on the configuration chosen by the first phase. Both record a SHA-256 test hash over prompts, checks and matrix entries; the changelog plus `SUITE_VERSION` distinguishes test edits from parameter changes.
- **Consequences**: A model change is judged before sampling tuning. Baselines are separate. A test edit requires a deliberate baseline update and cannot masquerade as a model improvement.

### ADR-006: API server settings, keys, CORS and JIT loading
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: LM Studio-style local serving needs a controllable port, optional API keys, LAN access, CORS and lazy model loading without making the browser UI depend on them.
- **Decision**: Persist `server-settings.json` with port, auth, LAN, CORS, JIT and idle policy. Store only SHA-256 hashes of API keys, return a raw key once, protect `/v1/*`, and keep JIT unload from touching a busy engine. MCP toggles are stored but no MCP transport is claimed.
- **Consequences**: Auth/CORS and JIT are opt-in and configurable without restarting the UI. Port/LAN changes need a restart. The local UI remains loopback-first.

### ADR-007: GPU backend selection with CPU fallback
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: node-llama-cpp can use CUDA, Vulkan and Metal, but a missing driver or build must not prevent local chat. ROCm is not exposed by the binding.
- **Decision**: Add `gpuBackend` (`cpu`, `auto`, `cuda`, `vulkan`, `metal`) and `gpuLayers`. Explicit backends fail with an actionable error; `auto` falls back to CPU. AMD uses Vulkan because ROCm is unavailable in this runtime.
- **Consequences**: CPU remains the default. GPU builds may require vendor toolchains, which is reported rather than hidden.

### ADR-008: Fingerprint every generation and every changed benchmark input
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The benchmark test hash covered prompts, checks and most matrix fields, but not the global or per-variant system prompt, promptIds, the GGUF chat template, the runtime version or the truncated history the model actually received. A score change could therefore be attributed to settings when the governing prompt, template or runtime had changed.
- **Decision**: Add a generation manifest in `src/generation-manifest.js`. `engine.chat` builds the effective system prompt, the exact bounded history and the repeated prompt through the same helpers and returns a SHA-256 manifest covering model identity, chat-template hash, runtime version, prompt/history digests and sampling settings. Chat messages and the SSE done event store a digest-only summary; OpenAI responses expose the short digest as `system_fingerprint`; benchmark prompt results store manifest, prompt, history and template digests. The test hash now includes the global and per-variant system prompts, promptIds, effective sampling defaults and the manifest version. Baselines record runtime and manifest versions and refuse a mismatch unless `--update-baseline` is deliberately passed.
- **Consequences**: Two runs are comparable only when the test definition, runtime and manifest version match. Regenerating a baseline after a runtime or test change is explicit and logged. Message files and history rows grow by a small digest summary, not by a second copy of the prompt or history.

### ADR-009: LAN auth covers UI routes; session reuse is gated by exact history
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Authentication only covered `/v1/*`, so enabling LAN serving exposed `/api/*` and the browser UI to unauthenticated state changes. The engine also had a `historyLength` reuse check that was never advanced, so every multi-turn request rebuilt the chat session and lost KV-cache reuse.
- **Decision**: When authentication is enabled, `/v1/*` always needs a key and `/api/*` needs one when the TCP peer is not loopback. The loopback UI stays key-free; a LAN browser receives 401, is prompted once, and sends `X-API-Key` from session storage. Session reuse is allowed only when the bounded history is complete (no 40-message/48k-character truncation), the system prompt/context signature matches, and the stored history length equals the prior message count. A completed turn advances that count; aborts, errors and truncated histories dispose the session. JIT keep-last documentation now states that disabling it refuses a second model because the engine intentionally holds one.
- **Consequences**: LAN clients can use the UI or API with a key while the host needs none. Long conversations rebuild rather than risk a manifest/session mismatch. Reused sessions keep the KV cache and still match the generation manifest, which is derived from the same bounded history.

### ADR-010: Read-only benchmark report inside the app
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Per-test percentages, runtime, suite/test identity and linked commits were only visible through the CLI. The user asked for the benchmark results to be visible as part of the product, and the existing baselines/JSONL already contain the data.
- **Decision**: Add `src/benchmark-report.js`, a read-only summary over `baseline-model.json`, `baseline-chat.json` and `history.jsonl`. `GET /api/benchmarks` returns both phases with quality, speed, runtime, per-test percentages, suite/test hash and linked commit, plus recent runs. A **Bench** dialog renders it. Missing baselines return an empty report; the route never writes files, loads a model or touches SQLite.
- **Consequences**: The panel always reflects the last deliberate baseline, not an in-progress run. It works on Node 20 without `node:sqlite`. LAN auth applies because the route is under `/api/*`. No benchmark suite or test hash changes, so existing baselines stay valid.

### ADR-011: Surface detected GPU backends in Settings
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: `/api/gpu` could report which backends the installed runtime sees, but the Settings dialog never asked for it. Users had to guess whether CUDA, Vulkan or Metal was actually available before selecting a backend.
- **Decision**: On opening Settings, request `/api/gpu` and show the detected backend names, mapping the runtime's `false` entry to CPU and adding the ROCm note. Detection failures fall back to a CPU-only message. The CPU default and stored backend choice do not change.
- **Consequences**: The dialog is read-only and reflects the current runtime, not a benchmark. A missing or broken backend is visible before a failed model load. Detection happens only when Settings opens, so it adds no startup work.

### ADR-012: Verify manifests against a real model without changing baselines
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Unit tests prove the history helpers, but the benchmark runs one isolated prompt per conversation. Nothing exercised the live `engine.chat` path for session reuse, 40-message truncation, prompt repetition and template/runtime identity against a GGUF file.
- **Decision**: Add `npm run verify:manifest -- --models-dir <folder>`. It defaults to Qwen2.5 0.5B Q4 (or the first installed model), patches `setChatHistory` only to count calls, and checks: the second turn reuses the session; a 45-pair history truncates to 40 messages with the expected digest; prompt repetition duplicates the text; the manifest carries the GGUF template hash and node-llama-cpp version. It writes no history and changes no baseline.
- **Consequences**: The diagnostic needs an installed model and takes a few prompts, so it stays opt-in. It fails with exit 1 on a mismatch, while the benchmark suite and baseline hashes remain untouched.

### ADR-013: Add OpenAI text completions without changing chat behavior
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The OpenAI-compatible surface exposed models and chat completions only. LM Studio-style clients and simple prompt tools often call `/v1/completions`, which needs raw continuation rather than a chat template.
- **Decision**: Add `LlamaEngine.complete()` using `LlamaCompletion` with a fresh context sequence, the same one-generation guard, sampling settings, abort handling and manifest builder as chat. Add `POST /v1/completions` with non-streaming and SSE `text_completion` responses, single-string prompt validation, usage, finish reason and `system_fingerprint`. Chat remains on `LlamaChatSession`.
- **Consequences**: Clients can use either OpenAI endpoint; completions still enter the same CPU queue and cannot overlap a chat. The completion manifest has no system prompt or history, so it records empty values plus the prompt/settings/model identity. Prompt arrays and token-ID arrays are rejected with an actionable error rather than silently misread.

### ADR-014: Preserve actionable generation errors
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Chat and text completion wrapped every thrown error in a generic generation failure, so a deliberate 413 context overflow or invalid-schema error reached clients as a 500. A failed LlamaCompletion constructor could also leave its context sequence undisposed.
- **Decision**: Move the generation error mapping into `src/generation-error.js`. It returns an existing AppError unchanged and only wraps unexpected failures as 500 or 507 memory errors. `engine.chat` and `engine.complete` use it. If completion construction fails before the completion object exists, dispose the context sequence explicitly.
- **Consequences**: API and SSE clients receive the original status, code, why and fix for actionable failures. Generic runtime failures keep the friendly message. Sequence memory is released on the constructor-failure path.

### ADR-015: Single-model lookup and cached model listing
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: OpenAI clients expect `GET /v1/models/{id}`, and the list route rescanned the model folder on every request even though the registry already keeps a scan cache.
- **Decision**: Serve `/v1/models` from `registry.listPublic()`, add `GET /v1/models/{id}` with id or file-name lookup and a 404 for unknown models, and return quant, size and chat-template hash alongside the standard OpenAI model fields.
- **Consequences**: Model listing no longer touches disk on each request; a new model becomes visible after the normal registry refresh. Single-model lookups are cheap and unknown ids fail cleanly.

### ADR-016: Release idle chat sequences before a completion
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: With the default `sequences=1`, a lingering UI chat session owns the only context sequence. A following `/v1/completions` request failed with "No sequences left", even though generation is serialized.
- **Decision**: Before allocating a completion sequence, if `context.sequencesLeft` is zero, dispose idle chat sessions. A completion has no chat history to preserve, and the next chat turn rebuilds its session from the atomic store.
- **Consequences**: Completions and chat can alternate with the default single sequence. Alternating endpoints loses the chat KV cache; the generation manifest remains exact because the rebuilt session uses the same bounded history.

### ADR-017: Unify load and generation error mapping
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: ADR-014 preserved actionable generation errors, but model loading still wrapped GPU-backend and configuration AppErrors as generic model_load_failed 500s. Keeping two separate mappers also risked the same divergence.
- **Decision**: Rename the mapper module to `src/engine-errors.js` and expose `toLoadError` alongside `toGenerationError`. Both return an existing AppError unchanged and only wrap unexpected failures into the friendly 500/507 messages for their operation.
- **Consequences**: Explicit GPU-backend failures keep `gpu_backend_failed`, memory failures keep 507 codes, and unexpected load/generation failures stay friendly. The old `generation-error.js` was removed; ADR-014 remains as the historical generation-only decision.

### ADR-018: Refuse cross-site and rebound requests; exposure needs authentication
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: IDEA-1054. A live probe showed that with Enable CORS on, any web page in the host's browser could read server settings and mint a readable API key even with Require Authentication on, because `/api/*` trusts loopback sockets and CORS applied to every route. LAN mode skipped the Origin and Host checks, so cross-site text/plain POSTs and DNS-rebound pages reached `/api/*`. Settings accepted LAN or CORS with authentication off.
- **Decision**: `isCrossSiteRequest` refuses any request whose Origin differs from its Host (`403 cross_site_refused`), except `/v1/*` while CORS is on; CORS headers and preflight apply to `/v1/*` only. A loopback socket must always name a loopback Host; only LAN mode admits other machines. `ServerSettingsStore.update` refuses LAN or CORS without Require Authentication (`400 auth_required_for_exposure`), and `load` switches such a saved file's LAN and CORS off with a warning and saves it.
- **Consequences**: The same-origin UI (loopback or LAN) and Origin-less API clients are unchanged. Local pages on another port can no longer call ModelDuck unless CORS is on with a key. Contract change: the tests `server settings clamp values...` and `CORS preflight is answered only when enabled` now enable authentication alongside CORS, because CORS without it is no longer a valid setting.

### ADR-019: Bound the GGUF header before parsing; one download per model
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: IDEA-967 and IDEA-882. A live probe showed that node-llama-cpp 3.22.2's `readGgufFileInfo`, which every scan runs (including at startup), trusts header counts: a 100-byte file claiming 2^62 tensors exhausts the heap and one claiming 2^62 metadata entries never returns, so one planted `.gguf` would crash every launch. Separately, `DownloadManager.start` accepted a second job for a model already downloading; both appended to one `.part` file and a double-size file was promoted as complete.
- **Decision**: `src/gguf-guard.js` walks the v2/v3 header with buffered reads before the parser runs, refusing any count or length larger than the remaining file, unknown value types, nested arrays, tensors outside 1-4 dimensions and offsets past the end (`422 gguf_header_rejected`). The registry lists such files as `blocked` with the reason; the engine refuses to load them and import deletes the copy and refuses. `start` returns the existing active job for the same catalog id, and the UI disables the Download button during its request.
- **Consequences**: The guard costs about as much as the metadata parse it precedes (107 ms for a 151k-token vocabulary) and runs only on a scan-cache miss; four real GGUF models (Qwen2.5, nomic-embed, moondream2 text and projector) pass it. Arrays of arrays are refused, matching every known GGUF writer. A repeated download request is idempotent instead of corrupting the model.

### ADR-020: Archive chats past the limit instead of dropping them
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: IDEA-1047. `ChatStore` capped conversations at 200 by insertion order on load (`slice`) and on create (`length = 200`). A live probe showed chat 201 deleting the oldest-created chat even when it was used that day, and loading a 250-chat file dropping 50, including the most recently used. The cap exists because `chats.json` is rewritten on every message.
- **Decision**: Keep the 200 most recently used chats in `chats.json` and move the rest to `chats.archive.json`, which is written only when the archive changes and always before `chats.json`; on load a chat found in both files keeps its active copy. `restore(id)` moves an archived chat back (counting as used now) and archives the next least recent. `GET /api/conversations` adds `archived`, `/api/state` adds `archivedConversations`, opening an archived chat restores it, and delete reaches archived chats. The sidebar lists them under an Archived group, searchable like the rest.
- **Consequences**: No chat is lost to the cap and the per-message write stays bounded. The archive grows with history and is loaded into memory at startup; a very large archive would call for paging (out of scope). An interrupted save can at worst duplicate a chat, which load removes.

### ADR-021: No on-demand runtime build, stalled-download watchdog, pre-load memory fit
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The analysis of the research reports (IDEA-1061, 1063, 853, 903) found four gaps:
  - `getLlama()` was called without `build`, so node-llama-cpp's default `"auto"` could download and compile llama.cpp when no prebuilt binary fits. The README promised that "everything stays on your computer".
  - A download that stopped sending data stayed "downloading" forever and held one of the two slots.
  - A load that did not fit either pushed the machine into swap or silently retried smaller contexts.
  - Three README sentences claimed more than the code enforces.
- **Decision**:
  - Both `getLlama` calls pass `build: "never"`. A missing binary becomes `runtime_binary_missing`, whose fix names the explicit `npx node-llama-cpp source download` step. The runtime loader is injectable for tests.
  - `DownloadManager` aborts a job after `idleTimeoutMs` (60 s) without data and reports it as **stalled**, keeping the `.part` file for resume.
  - `src/memory-fit.js` estimates weights + KV (2 × layers × KV heads × head size × bytes per element × context) + a 256 MiB reserve. The KV shape comes from GGUF metadata, which the registry now records as `kvShape`.
  - The engine compares the estimate with free RAM plus the currently loaded model. Above 75 % it refuses with `507 model_will_not_fit` and the largest context that fits. `force` (the UI's **Load anyway**) overrides the refusal. GPU offload and unknown shapes are never refused.
  - The loaded state carries `fit` and `contextFallback` ({requested, actual, reason}), and the UI raises a toast for a reduced context or a tight fit.
  - The README now scopes its network, benchmark and preset-trust claims.
- **Consequences**:
  - A real Qwen2.5-1.5B Q4 model loads with `build: "never"` from the installed prebuilt binary, and its metadata yields the expected 28 KiB per token of F16 KV.
  - The estimate is not yet calibrated against measured peak RSS (brief 2's ±15 % gate). With mmap, part of the weights is evictable, which is why the user can override the refusal.
  - The refusal now covers the case where Windows `os.freemem()` is low and the machine would swap.

### ADR-022: Public benchmark items, live runs and data-driven recommendations
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: IDEA-1037 and the user's request for public benchmark items, visible optimal configurations and live progress. The private suite measured code, comprehension, recall and facts but had no external reference points; the Bench panel was read-only; presets were hand-picked and a speed-only variant could be suggested without proving it kept the base model's answers.
- **Decision**:
  - Suite v6 adds 34 items from permissively licensed datasets (GSM8K, MMLU, HumanEval, MBPP, TruthfulQA), each with `source.dataset`, `source.id` and `source.license`, plus `NOTICE-benchmarks.md`. HumanEval and MBPP are translated to JavaScript and keep their original cases; public categories are reported separately.
  - `benchmarks/recommend.mjs` ranks full-suite variants for best quality, best overall (70 % quality + 30 % speed within 15 points), best coding (`code`, `bugfix`, `public-code`) and fastest within a 5-point loss. Speed is normalised only over variants that clear the quality floor, so a fast but poor model cannot distort the balance.
  - Results separate **own questions** from **public benchmark items** by origin (`items.byOrigin`), derived from the prompt category/source so older results remain readable without changing the test hash. The overall rate still includes both.
  - A model-phase variant can be saved to `benchmarks/chat-base.json` (`POST /api/benchmarks/base`, **Use for chat**, or `--select-base`). The next chat phase builds its fixed sampling matrix on that measured model, quantization, KV cache, context and reload settings; `--base-variant` uses one for a single run without saving.
  - `run.mjs --events` writes JSON progress lines on stdout and human logs on stderr. `src/benchmark-runner.js` owns one child process and exposes start, status, cancel and dispose; `src/server.js` adds loopback-only run/status/cancel routes that refuse while a reply is generating.
  - The Bench panel starts either phase, polls progress and renders recommendation cards whose **Fill settings** action only fills the form. `results/latest-<phase>.json` preserves the latest run of each phase for advice.
  - `npm run bench` runs only the required model phase on the three core models (SmolLM2 135M, Qwen2.5 0.5B, Qwen2.5 Coder 1.5B). `--full-matrix` / `bench:full` adds Qwen2.5 1.5B, Llama 3B and Phi 3.8B; `bench:all` adds the optional model-usage phase, needed only when sampling or prompting changes. `bench:update:model` replaces the model baseline alone.
  - Baselines change only through `--update-baseline` or the explicit checkbox; the app never replaces them automatically.
- **Consequences**: Suite v6 has a new test hash, so the existing v4 baseline is not comparable until both phases are deliberately rerun. Public items may be contaminated by training data, so their categories never feed the overall quality claim and are reported as a separate origin. The default gate covers three models; a six-model baseline needs `--full-matrix` and is deliberately a different test hash. One benchmark runs at a time and its child is stopped on cancel or app shutdown. Recommendations describe measured settings for the named model file; they do not load a model or prove a preset passed outside the measured matrix. A model-only baseline update leaves the chat baseline on its previous suite; `bench:all` is required before treating both phases as one comparable gate. Selecting a different chat base changes the chat test hash, and the chat run refuses with an actionable error when the selected model file is not installed.

### ADR-023: Expose checkpoint interval and max instead of only on/off
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The settings and benchmark exposed only `checkpoints: true|false`. node-llama-cpp also takes `checkpoints.interval` (default 8192 tokens) and `checkpoints.max` (default 32). At the benchmark's 2048-token context the default interval never fires, so the old on/off variants did not actually compare checkpoint reuse.
- **Decision**: Add `checkpointInterval` (128–32768 tokens, default 8192) and `checkpointMax` (1–64, default 32) to settings, the Settings panel, `LlamaEngine.load`, state, recommendation settings and the saved chat base. Both chat and completion sequences pass `{ max, interval }` to `getSequence`. Suite v7 adds `ckpt-512`, `ckpt-2048` and `ckpt-max4` smoke variants on Qwen2.5 0.5B, keeping `no-checkpoints` as the off baseline.
- **Consequences**: A smaller interval and a larger max cost memory but reuse more prefix state; the v7 core baseline measures the trade-off. The test hash changes, so the v6 model baseline is replaced deliberately. Old settings files normalize to the defaults, and loading a chat base without the new fields uses the same defaults.

### ADR-024: Single-model diagnostic runs never replace the baseline
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The core matrix takes about 33 minutes on this CPU even after the three-model default. Checking one installed model should be possible without waiting for the whole gate or shrinking the shared baseline.
- **Decision**: `--model <catalogId>` (and the Bench panel's **Single model** selector) keeps only variants from that model family, writes `results/latest-single-model.json`, and records a normal history entry with `matrixScope: single:<catalogId>`. It does not read, compare or replace `baseline-model.json`; `--update-baseline` is refused and `--full-matrix` cannot be combined with it. The Bench report renders the last diagnostic as its own phase with the same type/origin/test tables.
- **Consequences**: A one-model run is a diagnostic, not a gate; its test hash is scoped to the filtered matrix and is not compared to the shared baseline. The panel can show the last core baseline, the optional chat baseline and one diagnostic side by side. Choosing a model that has only a base variant runs just that variant.

### ADR-025: Last-number math checks, larger public set and per-dataset results
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Every GSM8K item scored 0% while several replies contained the final value, and one reply that wrote working was parsed as its first number. The `number` check took the first numeric token, and `maxTokens: 24` cut reasoning off before the answer. The public set was also small (8 GSM8K, 8 MMLU, 6 TruthfulQA, 12 code), so a dataset could not be read separately from its category.
- **Decision**: `number` checks now take the **last** numeric token after stripping thousands separators, and GSM8K prompts ask for reasoning followed by `Answer: <number>` with 512 tokens instead of forcing a one-shot 24-token answer. Suite v8 grows to 130 items: 70 own and 60 public (GSM8K 16, MMLU 12, TruthfulQA 12, HumanEval 12, MBPP 8), with extra own items in every category. Results record `items.byDataset` from each prompt's `source.dataset`, and the Bench panel shows a public-dataset table plus a dataset column in the per-test table. Public code and bug-fix test cases are still original checks; float cases are chosen to compare exactly in JavaScript.
- **Consequences**: A model that writes working and ends with the answer is no longer failed for its first intermediate number; a model that only writes a wrong final number still fails. The larger suite makes the core run longer (130 items instead of 91), while the 16-item smoke subset stays fast. The v8 test hash replaces the v7 baseline deliberately. Public per-dataset rates remain marked as possibly contaminated by training data and are not mixed into the own-question rate.

### ADR-026: Single-model runs optimise settings on the smoke set, not model quality
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: ADR-024 ran one model's existing matrix variants as a quality diagnostic. That missed the point: the user wants a quick way to find the best loading settings for one chosen model, including models such as Qwen Coder that had only a base variant in the shared matrix. Running all 130 items for 17 settings would also take as long as the core gate.
- **Decision**: `--model <catalogId>` builds a 17-variant sweep for that model (base, Q8/Q4 KV, 4k/8k context, 4/16 threads, batch 128/256/1024, flash on/off, mmap on/off, checkpoints off, checkpoint every 512, and 512/max 4), and forces the 16-item smoke set on every variant. The result is a settings recommendation for that model, written to `results/latest-single-model.json`; the Bench panel labels it **Single-model settings** and shows the model-specific advice cards. It never reads or replaces the shared baseline.
- **Consequences**: A single-model optimisation takes a few minutes and works for any installed benchmark model, including one without shared variants. Its quality comparison is a 16-item smoke signal, not a full quality verdict; the core/full matrix remains the quality gate. The chat base can be selected from the resulting recommendation as before.

### ADR-027: ModelDuck optimises settings per model and task; cross-model comparison is optional
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The benchmark grew into a cross-model quality ranking (core and full matrices, a shared baseline, a ~45-minute v8 gate). The user's goal is different: for the model they chose, find the settings that work best for each kind of task and use them. ADR-026's single-model sweep was the first step but changed one setting at a time, never tuned sampling, gave one answer per model and applied nothing.
- **Decision**: A **tune** produces a per-model profile with one load configuration and four task presets: **chat**, **code**, **math** and **recall**. Stage 1 tries load settings one at a time on a mixed subset, keeps those that are faster or lighter without losing an item, then verifies their combination; context is sized for the recall task. Stage 2 searches sampling settings (temperature, top-p, top-k, min-p, repeat penalty, token budget) per task on that task's fixed subset, seeding non-zero temperatures three times, and picks the best pass rate, then the fastest within tolerance. Profiles are stored per model, carry the hardware, runtime and suite hash, and are marked stale when any changes; a measured profile is applied when its model loads (G-004). Guidelines G-001, G-003 and G-005 are rewritten by the user's instruction: the gate becomes the tune of the three core models against their stored profiles, and the cross-model matrix becomes the optional `bench:compare`. The user stopped the v8 cross-model baseline run; suite v8 lands without a v8 cross-model baseline, which may now lag.
- **Consequences**: Switching task in chat changes sampling only and never reloads the model. Until `tune:gate` exists (task-tuner-v1, milestone 5), `npm test` is the only gate and generation changes note that the tune gate is pending. `baseline-model.json` stays at v7 as an optional reference.

### ADR-028: Tuned profiles are reused; a changed test warns instead of re-tuning
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: A full tune takes tens of minutes on a CPU. The user asked that tune statistics be saved for later use, that models not be re-tuned again and again, and that a change to the test be reported with a warning.
- **Decision**: `npm run tune` (and a `tune` job from the app) first reads the saved profile. When it covers every requested task the tune is skipped. When a fresh profile lacks some tasks, only those are tuned on its saved load config and merged in, with their sweeps and run counts added. A profile whose fingerprint differs (suite version, task-item hash, node-llama-cpp version, CPU, thread count, platform, architecture, model file or size) is still used, and `GET /api/profiles/:id` and the CLI report one plain-language warning per change, such as "The test suite changed (v8 → v9)". Mixing new tasks into a stale profile is refused; `--force` (`force: true`) re-tunes every task and replaces the profile. The load stage answers with each item's own token budget until sampling is tuned, and every candidate emits a progress event with its rate and latency.
- **Consequences**: A model is tuned once per machine, runtime and test version unless the user asks again. A suite bump no longer silently invalidates presets; it surfaces as a warning and a re-tune suggestion. Statistics accumulate in the profile file across partial tunes.

### ADR-029: The user chooses the tune steps; impossible and failed settings never win
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: The user wants to decide which values each setting is tried at. A full combination grid of the fine steps would take months to years on a CPU, so the user chose the setting-by-setting search (try every value of A, keep the best, then B, …) with their own Stage 1 steps. llama.cpp refuses a quantized V cache without flash attention (`llama-context.cpp`), and node-llama-cpp marks custom KV cache types as experimental and able to fail. Checkpoints are only taken for recurrent, hybrid or sliding-window models (node-llama-cpp `LlamaContext` docs), so they cannot change a single-turn test on the current models.
- **Decision**: Stage 1 defaults are the user's steps: context 2048/4096/8192/16384, KV f16/q8_0/q4_0, flash on/off, mmap on/off, batch 64–2048, threads 1/2/4/6/8/10/12 capped at three quarters of the logical threads. Checkpointing is an optional axis, off by default. Steps live in `~/.modelduck/tune-grid.json`, edited through `GET/PUT /api/tune/steps`, `npm run tune -- --interactive` or `--grid <file>`; values outside the settings ranges are dropped and reported rather than clamped. A quantized KV cache with flash off is skipped and listed, a load that fails marks every item failed with its reason, and a candidate whose answers all failed can never be chosen. Every tune prints an estimate first and records the steps it used in the profile.
- **Consequences**: A Stage 1 pass is 24 configurations (about 40–70 minutes on SmolLM2); Stage 2 still uses the original fine sampling steps until the user changes them and dominates the tune time. Profiles show which steps produced them.

### ADR-030: A tune runs quality → speed → sampling → prompt, and every finished step applies on its own
- **Date**: 2026-10-30
- **Status**: Accepted
- **Context**: Threads, batch size, flash attention and mmap change how fast llama.cpp answers, not what it answers, so measuring them on 24 quality questions each wasted most of Stage 1. The user ordered the work as quality, then speed, then prompting; chose the sampling steps; asked for 21 one-sentence system prompts to be tried, unselected, on every benchmark, plus reasoning off/on and prompt repetition; and asked to stop after any step and use what was found with defaults for the rest.
- **Decision**: Stage 1 (quality) tunes context and KV cache on the mixed quality rungs. Stage 2 (speed) tunes flash attention, mmap, batch, threads and optional checkpointing on a fixed six-item workload with greedy answers; a candidate whose answer text (digest) differs from the stage's start is excluded, and it yields a Fastest preset and a Light preset that uses at most half the logical threads (setting `speedPreset`). Stage 3 (sampling) tunes temperature 0–1 by 0.2, token budget 64–2048, repeat penalty 1.0–1.2, min-p 0–0.2, top-p 0.8–1.0 and top-k off/20/40 per task, skipping min-p, top-p and top-k when temperature is 0 because they cannot change a greedy answer. Stage 4 (prompt) gives every system prompt (the suite prompt plus the user's 21) a full score on each task's whole set, then tunes reasoning off/auto and promptRepeat 1/2. Stages 3–4 break quality ties on answer length in tokens; stages 1–2 on paired latency. Tunes start at three quarters of the logical threads at most. The profile is saved after every finished axis with its progress and stage status, stores only tuned keys, and `--stages` (or `stages` in the API) runs a subset; a later run resumes at the next unfinished axis. A task's tuned system prompt replaces the user's in chat while tuned settings are on.
- **Consequences**: Stopping a tune at any point leaves a usable profile; untuned settings keep their defaults. A full SmolLM2 tune is roughly 2–4.5 hours with the user's steps; repeat penalties below 1.0 stay out of range. Older profiles without progress are re-tuned from the start when continued.

### ADR-031: Stage 0 probes CPU against GPU per model before tuning
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: On this PC (i5-14400F, 16 GB RAM, Radeon RX 9060 XT 16 GB, node-llama-cpp Vulkan build installed) a one-off measurement gave SmolLM2 135M ≈154 tok/s on the CPU vs ≈46 on Vulkan, but Qwen2.5 Coder 1.5B ≈22 vs ≈124 and Phi-3.5 mini ≈9 vs ≈32. The fastest device depends on the model, and every later stage runs faster on the right one. GPU rounding can change answers, so the speed stage's identical-answers rule would always reject it.
- **Decision**: A tune now starts with a device stage: the fixed six-item speed workload, answered greedily, on the CPU (at the thread cap) and on each GPU backend in the steps (default Vulkan) with all layers offloaded; half the layers is tried only when all fail to load. A GPU is chosen only when its per-item throughput (tokens per second, which answer length does not distort) is measurably higher and it answers at least as many items correctly as the CPU; a backend that cannot start or load counts as did-not-run. The choice (`gpuBackend`, `gpuLayers`) is stored with the probe and a one-line reason, joins the profile's load settings, is applied at load, chat and JIT time, and all later stages run on it. `--stages device` answers "where does this model run fast" in about a minute. Untuned models keep the GPU off.
- **Consequences**: The first real probe kept SmolLM2 on the CPU (143 tok/s) and moved Qwen2.5 0.5B (172 vs 48 tok/s), Qwen2.5 Coder 1.5B (109 vs 20) and Phi-3.5 mini (28 tok/s; the CPU load was refused with 3.4 GB of RAM free) to Vulkan, so their tunes run several times faster. Time per answer is the wrong measure across devices because their answers differ in length; a first version that used it kept Coder 1.5B on the CPU at a fifth of the speed.

### ADR-032: The engine can answer on several sequences, but tunes answer one question at a time
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The user asked to run benchmark questions in parallel to speed tunes up. The engine allowed one generation at a time and, before each chat, disposed every other cached session. node-llama-cpp gives a disposed sequence back to its context asynchronously, so a chat starting right after another ended could fail with "No sequences left".
- **Decision**: The engine runs up to as many generations as the model was loaded with sequences (the app loads one, so chat behaves as before), only ever disposes idle sessions, waits for every running generation on unload, and waits up to two seconds for a reclaimed sequence before failing. The tune evaluator can answer several items at once on a multi-sequence load, with the timing stages forced to one at a time. Measured on this PC, 12 tune items took 32 s one at a time on SmolLM2 (CPU) but 153 s two at a time and failed with "No sequences left" four at a time, and 3.1 s vs 2.9 s vs 3.2 s on Qwen2.5 Coder 1.5B (GPU); tunes therefore keep answering one question at a time and the option is not exposed.
- **Consequences**: No tune speedup from parallel questions on CPU or this GPU; the GPU device stage (ADR-031) is where the time is saved. The sequence-reclaim wait also protects consecutive chats. Running different models at once on different devices remains a separate idea to measure.

### ADR-033: Tunes run side by side in CPU and GPU lanes; timing stages run alone
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: Parallel questions within one model did not help (ADR-032), but different models on different devices barely slow each other: on this PC SmolLM2 on the CPU and Qwen2.5 Coder 1.5B on the GPU kept 86% and 84% of their speed together (about 1.65× the combined throughput of running them one after another), and two GPU models kept 88% and 93% (about 1.6×). Device and speed stages time answers, so other load would bias them. Other PCs have different CPUs and may have no GPU, so the lane counts must be settings.
- **Decision**: `TuneScheduler` (`POST /api/tune/start` with one model, a list or `"all"`; `GET /api/tune/status`; `POST /api/tune/cancel`) runs `tune-run` children: device probes one at a time first, then each model's remaining stages in a CPU or GPU lane chosen from its probe. Lane counts are tune settings (`lanes: { cpu: 1, gpu: 2 }` in `tune-grid.json`; CPU 1–4, GPU 0–4, where 0 sends GPU models to the CPU lane); a PC without a GPU simply probes every model onto the CPU, and `device.backends: ["cpu"]` skips GPU probing. A file-based timing lock in `<home>/tune-lanes/` makes device and speed stages exclusive: the holder waits until every other registered tune has paused between answers, the others pause before each untimed answer while it is held, and files from dead processes are ignored. `--force` goes only to a model's first run so its tune resumes from the fresh probe. A tune refuses to start beside a running reply or benchmark, and a benchmark beside a running tune.
- **Consequences**: Running all models takes roughly 1.6× less time on this PC while device and speed measurements stay free of other tunes' load. Lock and registration files live in the data folder and clean themselves up; a crashed tune's files are skipped by pid.

### ADR-034: A tune can run only chosen settings
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: Whole stages could already be chosen (`--stages`), but the user wants to run a single section, for example only the context size, or only the quality and speed settings, without redoing anything else.
- **Decision**: `--settings <names>` (API and scheduler: `settings`) runs only those settings, in stage order, each re-measured even if tuned before, on top of every other setting's current best. Valid names are listed by `settingNames()` (device, contextSize, kvCache, flashAttention, useMmap, batchSize, threads, checkpointing, temperature, maxTokens, repeatPenalty, minP, topP, topK, systemPrompt, reasoning, promptRepeat); unknown names are refused. Only settings measured now or before are stored, never untouched defaults. A partial selection never marks a stage finished; a stage finished before stays finished and its statistics are refreshed only when the stage is complete. An explicit selection always runs (no skip), still refused on a stale profile without `--force`.
- **Consequences**: Re-tuning one setting takes minutes. Light keeps its earlier thread count unless threads were re-measured. A real run re-tuning only the context size of a SmolLM2 profile swept four sizes, stored only `contextSize` and left every other stage untouched.

### ADR-035: Suite v9 adds 44 of our own coding and bug-fix questions, long ones included
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The user asked for many more of ModelDuck's own coding and bug-fix questions, including long coding tasks and long bug fixes. The code task tuned on 24 own items, all short, with 256-token budgets.
- **Decision**: Suite v9 adds 16 coding items, 6 long coding items (`code-long`: an expression evaluator, a CSV parser, word wrap, a checkout with offers, matrix multiplication, an INI parser), 16 single-bug fixes and 6 long multi-line fixes with two or three interacting bugs (`bugfix-long`), in `benchmarks/own-items-v9.mjs`. Long items get 1024 tokens. Every case is checked against a reference solution in `tests/reference-solutions-v9.js`, and every buggy function is proven to fail its own tests (a crash counts as failing). Function names shared by two items carry the same rules; a new anagram item uses `areAnagrams` because `isAnagram` already meant something stricter. The long categories join the code task and `CODING_CATEGORIES`.
- **Consequences**: 174 items, 114 own. Saved tune profiles carry the v8 suite and task hashes, so they keep working with a "test suite changed" warning until re-tuned (ADR-028); the optional cross-model baseline lags further. Long items make the code task's tune slower per answer.

### ADR-036: The prompt stage tries one-sentence directives
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: In the first full tune of Qwen2.5 Coder 1.5B, none of the 21 thinking prompts (ADR-030) beat the suite's own format directive on any task; on long-context recall all 21 tied it. The user asked for directive-style prompts instead, and to re-run only the prompt stage.
- **Decision**: The default `systemPrompt` steps are the suite prompt followed by 21 one-sentence directives (`DIRECTIVE_PROMPTS`: answer scope, format, final-answer placement, grounding in the given text, exact function names, minimal bug fixes, edge cases), each still tried on every task, fully scored. `THINKING_PROMPTS` stays exported and a saved `tune-grid.json` keeps whatever list it holds.
- **Consequences**: Profiles tuned before keep their chosen prompt; re-running `--settings systemPrompt,reasoning,promptRepeat` measures the directives.

### ADR-037: The engine keeps the system message when it sets a session's history
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The engine created each `LlamaChatSession` with the system prompt, then called `setChatHistory(history)` with the earlier turns. node-llama-cpp's `setChatHistory` replaces the whole history, including the system message the constructor put first, so no system prompt ever reached the model: chat, the benchmark and every tune answered under the model template's own default. A prompt-only tune of Qwen2.5 Coder 1.5B scored all 22 system prompts identically on every task, which exposed it.
- **Decision**: The engine sets the history to the session's own system items followed by the earlier turns. `tests/engine-system-prompt.test.js` mirrors node-llama-cpp's behaviour and failed before the fix; on the real model a pirate system prompt now changes the answer.
- **Consequences**: Benchmark scores and tuned prompt and sampling choices measured before this fix were measured without a system prompt; re-tune the prompt stage (`--settings systemPrompt,reasoning,promptRepeat`) or the whole profile.

### ADR-038: Suite v10 grows math and recall, adds codebase items, and tunes on 12/24/48 items
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: Tune choices rested on at most 24 items per task (recall 11, math 21), so no difference reached significance (p 0.375 to 1). The user asked for enough items for the statistics to mean something, and for a coder that works well inside complex codebases.
- **Decision**: Suite v10 adds 30 own math word problems (`reasoning`, last-number check), 40 recall items generated from a fixed seed (lookups at several depths and lengths, reverse lookups, latest status, two-balance sums, counts) and 12 codebase items in `benchmarks/repo-items-v10.mjs`: three small multi-file codebases with a distractor file each, asking for a new function on the existing helpers (`code-repo`), a fix for a reported bug (`bugfix-repo`) or the name of the function holding a bug. A `jsTests` check may carry `setup`, the codebase run before the answer, so the answer must fit it. Every answer is re-derived in `tests/benchmark-suite-v10.test.js`; every shipped bug fails and every named culprit cures its probe. `TASK_RUNGS` becomes 12/24/48.
- **Consequences**: 256 items; math and recall have 51 each, code 100, chat 54, and every task's last rung scores at least 48. A tune takes roughly twice as long per stage. Saved profiles get the suite-changed warning until re-tuned.

### ADR-039: Suite v11 adds items on three larger codebases
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The goal is a coder that works well inside complex codebases. Suite v10 had 12 codebase items on three small projects of four or five files.
- **Decision**: `benchmarks/repo-items-v11.mjs` adds three codebases of six or seven files, each with a distractor file: a bank ledger (money, ids, accounts, rules, transfers, reports), an order and shipping service (units, stock, shipping rates, discounts, orders, dates) and a Markdown renderer (escaping, inline formatting, blocks, rendering, theme). Each gets two functions to write on the existing helpers, one reported bug to fix and one bug to locate, built with the v10 builders. `tests/benchmark-suite-v11.test.js` checks every reference answer, every shipped bug and every culprit probe.
- **Consequences**: 268 items; 24 codebase items, code task 112. Saved profiles get the suite-changed warning until re-tuned.

### ADR-040: Part runs re-measure chosen parts on top of the saved rest
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The user wants to run one part of the tune for every model: only the CPU-versus-GPU probe, one setting, or only the prompt stage. Choosing a stage that was already done skipped it, and Run all started every stale profile over, so a prompt-only run after a suite change discarded each model's device, load and sampling results and measured prompts on defaults.
- **Decision**: A part run (some stages, or some settings, for one model or for all) measures the chosen parts again on top of the saved rest, even when they are done or the profile is stale; a partial stage resumes instead of starting over. `planTune` returns the parts it re-runs (`rerun`) and removes their progress so they start fresh; `isPartRun` is shared with the server, whose `forceStale` now starts stale profiles over only for a whole tune. A profile may carry `measuredUnder`, the fingerprint each part was measured under when they differ; `loadProfile` reports staleness across all of them, lists the old parts in `staleParts` and adds a warning naming them. This lifts ADR-034's refusal of an explicit selection on a stale profile; the test "an explicit selection of settings always runs" now expects the part run to proceed.
- **Consequences**: A device-only run of a stale Qwen2.5 Coder profile re-measured the probe under suite v11 and kept every other result, recorded as measured under the older suite. A full re-tune still needs `force` (Re-tune ⚠) on a stale profile.

### ADR-041: The prompt stage tries reasoning off and fully on
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The prompt stage compared reasoning `off` with `auto`, which only adds a short "reason carefully, keep it concise" nudge. The user asked for reasoning to be tuned off and on.
- **Decision**: The default `reasoning` steps are `off` and `deep` ("think through the problem carefully before giving the final answer"). `auto` stays a valid step for a saved grid.
- **Consequences**: Profiles tuned before keep their chosen reasoning; re-running `--settings reasoning` (or the prompt stage) measures the new pair.

### ADR-042: A setting changes only on a significant gain, and a tune that cannot load stops
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: On an axis's last rung the highest rate won and the current setting only won exact ties, so a challenger one lucky item ahead replaced it. With 22 system prompts scored at once, the best of many noisy rates is optimistic (the winner's curse), and earlier tunes moved settings on gains with p from 0.375 to 1. Separately, a real run with a broken Vulkan binary failed every answer, yet the tuner chose a prompt among 22 failures and saved 0% over the task's preset.
- **Decision**: A challenger that wins on quality alone replaces the current setting only when it beats it in the paired McNemar test (more items it alone gets right than items only the current one gets right) at `changeAlpha` (0.2) divided by the number of challengers; otherwise the current setting stays and the sweep records `kept`, naming the best challenger, both rates, p and the bar. Speed and memory ties keep their own rules. When every candidate of a rung fails, the current setting included, `Measurements.stop` ends every further measurement, the result carries `stopped`, and `runTune` refuses to save and reports why with a fix. The tuner's mechanics tests run with `changeAlpha: Infinity` (the rule off), since they check selection on 4-8 items; the rule and the stop have their own tests.
- **Consequences**: Tuned settings move less often and only on evidence, so presets stay at the suite defaults unless a change is real. A real run with the GPU broken stopped after 11 s with the reason and left the profile byte-identical.

### ADR-043: Context size is a memory budget, not a quality setting
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The longest test question is about 1,300 tokens, so every context size from 2,048 to 16,384 answered the same, and the choice among them was noise; Qwen2.5 Coder ended up at 16,384, costing memory with no measured benefit. Longer questions (8k-16k tokens) would make every long-context answer slow on a CPU and still only push the choice to whatever the longest question needs.
- **Decision**: The `contextSize` axis is a budget step. `budgetContext` picks the largest listed size whose estimated load (weights, KV cache at the chosen type, runtime reserve) fits within 60% of the free memory of the chosen device (VRAM on a GPU, RAM on the CPU, the loaded model's own share counted as free; `LlamaEngine.availableMemory`), capped at the model's trained context; with nothing fitting, or memory or the KV shape unknown, it uses the smallest size and says so. No question is asked at any other size; the KV cache is still measured at the budgeted size, and the descent's second pass recomputes the budget for the chosen KV cache. The sweep records the reason. Without a budget hook (tests, the gate) the axis is measured as before. Separately, the timing-lock test "without a timing stage, a tune never pauses" now allows 1 s instead of 50 ms: only a pause could take long there, and 50 ms failed now and then on a loaded Windows disk.
- **Consequences**: A real context-only run of SmolLM2 on the CPU chose 8,192 because it was the largest that fit comfortably in the 1.1 GiB of free RAM. Profiles keep their earlier context until the context size is run again.

### ADR-044: Parts remember their device, and a tune checks the GPU before it starts
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: A stage button can re-run the device probe alone (ADR-040). When it moves a model from GPU to CPU, the quality, speed, sampling and prompt results were measured on the GPU, and nothing said so. Separately, a broken Vulkan binary was found only after a full round of failed answers.
- **Decision**: A profile carries `measuredOn`, the backend each measured part was measured on (`measuredOnAfter`: parts measured now get the current backend, the rest keep theirs, or for an older profile the backend it was on). `loadProfile` lists parts on another backend than the profile's in `deviceParts` with a warning; the Bench panel dots those chips and offers "Re-run Quality → Prompt", which runs those four stages on top of the saved device result. A tune that does not probe the device starts the saved GPU backend first (`LlamaEngine.startBackend`, which shares the start-up code with a load) and stops with the reason when it cannot, before measuring or saving anything.
- **Consequences**: With the GPU broken, a quality-only run of the Coder stopped in 5 s with "vulkan could not be loaded" and the profile unchanged. Profiles tuned before this record have no `measuredOn` until their next run; a device re-run on them still flags the rest, using the device they were on.

### ADR-045: A tune's time left comes from its own pace
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The tune printed "Estimate at ~3 s/answer … one pass ≈ 9.3 h" before starting. On the GPU an answer often takes about 0.2 s, so the figure was far off, and the app showed no time at all while a tune ran.
- **Decision**: `expectedAnswers` counts the answers a run asks in one pass, only for its chosen stages or settings (a memory-budget axis asks none; sampling and prompt count every seed, so it is an upper bound). The tune measures its own pace, and `timeLeft` turns answers so far, expected answers and elapsed time into "about 25 min left", "less than a minute left", or "finishing up (a second pass)" once the count passes the estimate instead of inventing a number. The CLI prints it on every candidate line and adds it to each progress event; the Bench panel shows it on the running model's row. `estimateTune` no longer counts the budgeted context axis.
- **Consequences**: A real CPU sampling run of SmolLM2 settled at about 19-20 minutes after the first minute; since the count is an upper bound, real runs finish sooner than the first estimates.

### ADR-046: Reasoning is tried with room to answer
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The prompt stage tried reasoning off against deep (ADR-041) at the task's tuned answer length, often 512 tokens. A model told to think before answering can be cut off before it answers, so deep lost for lack of room rather than on merit.
- **Decision**: An axis may `widen` a value on top of the current settings and name the further settings it changes in `extraKeys`. The reasoning axis tries every value other than off with an answer length of at least `REASONING_TOKENS` (1024), or the task's own length if larger, and the stored preset keeps that length, so a winning deep is not cut off in use. Temperature and answer length are already re-tuned against each other by the descent's second pass.
- **Consequences**: Reasoning trials cost more tokens. A synthetic task that deep solves only with room now picks deep with 1024 tokens.

### ADR-047: The Bench row lists every reason, and the single-model control leaves the panel
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: A model row showed only its first warning, so a device change behind a suite change was visible only in Details. The benchmark gate still offered "Optimise one model" (ADR-026), a 17-variant reload sweep on the smoke set that the settings tuner now does per stage, with statistics.
- **Decision**: The row shows each warning's first clause on its own line; "Measured before that" (which only explains the suite line) and "The tune's test items changed" (which always comes with a suite change) stay in Details. The "Optimise one model" selector and its code leave the panel; `npm run bench -- --model <id>` still runs the sweep from the command line, and saved single-model reports still display.
- **Consequences**: Rows can be two or three lines taller when several things changed. The panel has one way to tune a model.

### ADR-048: The tuner names the best model per task and runs one task's stage
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: Tuned profiles held each model's rate per task, but nothing compared models, and the Sampling and Prompt buttons always ran all four tasks.
- **Decision**: Under the model table, "Best model per task on this PC" ranks the tuned models per task by rate (then the lower end of the 95% range), with the range, device and runner-up. Only models tuned on the current test suite are compared, since rates on other items are not comparable; when none is, the older best is shown and marked "older test suite". In a model's Details, each task has Sampling and Prompt buttons that run that stage for that task only (`tasks: [task]`), on top of the saved results.
- **Consequences**: Until models are re-tuned on the current suite the table shows older results, marked; overlapping ranges mean the leaders may be equally good.

### ADR-049: System prompts are screened on a quarter of the items
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The system-prompt axis scores every prompt on the task's full set (ADR-030), 22 prompts on 48 items per task and seed, the costliest step of a tune. With the significance rule (ADR-042), a prompt clearly behind early almost never ends up beating the current one.
- **Decision**: A fully scored axis first answers `screenFraction` (25%) of its items, a prefix of the task's stratified order. A candidate `screenGap` (3) or more items behind the leader there stops; the current setting never does. Survivors answer the rest, and the decision and its statistics use the full set as before. The sweep records each dropped candidate with its screen score. A screen under 8 items is skipped, since a 3-item gap there is noise.
- **Consequences**: With about six survivors of 22, a task's prompt step asks about 480 answers instead of 1,056. The time-left estimate (ADR-045) still counts the full set, so it stays an upper bound.

### ADR-050: Every tune run is recorded with every answer
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: A profile keeps only each part's latest result and its sweep log; how a run went, how long it took, what it measured answer by answer, and runs that stopped or failed were lost. The user wants every tune's data kept, with detailed results.
- **Decision**: `src/tune-runs.js` records each run in `<home>/tune-runs/`: `<id>.json` holds the request (stages, tasks, settings, force, re-run parts), fingerprint, expected answers, timing, outcome (done, stopped, failed, or interrupted when its process died while running), this run's sweeps and the resulting presets, rewritten atomically after every finished setting; `<id>.answers.jsonl` gets every newly measured answer (settings, seed, item, passed, time, tokens, digest, error), appended as it comes. `Measurements` reports new answers through `onAnswers`; `runTune` opens the record once a run really starts and closes it with its outcome. Nothing is deleted automatically. Run ids are timestamp and process id, and any other id is refused.
- **Consequences**: A full tune writes a few megabytes of answers. The real end-to-end check waits until the tune:gate baseline run, which must not share the machine with another tune, has finished.

### ADR-051: A stopped run can be continued where it left off
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: A tune saves after every finished setting, and a part run's parts that were not reached stay pending, so a stopped run's remaining work is known. But choosing the same stages again starts a part run, which measures done parts again (ADR-040).
- **Decision**: `planTune(..., { continueRun })` resumes the saved progress and measures only what is not done in the chosen stages and tasks, even on a stale profile, and skips when nothing is left; chosen settings run again. The CLI takes `--continue`, the scheduler passes it to each tune, and `POST /api/tune/start` takes `continue: true`, which never starts a stale profile over, whatever `forceStale` says. A continued run is recorded as its own run with `continueRun` in its request.
- **Consequences**: A real SmolLM2 speed run stopped after three settings continued at threads, measured nothing it had finished, and marked the stage done.

### ADR-052: Checkers read an answer the way a person would
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: Correct replies failed on wording: an exact check passed 2 of 6 correct forms ("**3546**", "The PIN is 3546.", "PIN: 3546" failed), a choice check read "Answer: B" as A because it took the first letter, a number check took the last number so a check line after the answer failed it, and a code check tested the first fenced block even when it was a usage example. Scoring wording biases tuning toward terse prompts rather than right answers.
- **Decision**: Exact and one-of checks compare against the places a person would look (the whole reply, its first and last line, any "Answer:" line), each also without an "Answer is" lead-in, a short "Label:" or a short "The X is (in)" sentence start, after removing Markdown emphasis, code marks and list markers; never "contains anywhere", so "3546 or 4596" and "not 3546" still fail. A choice check reads "Answer/Option/Choice B", "the answer is (B)", or a leading "B", "(B)", "B)" or "B.", and treats "B or C" as no choice. A number check prefers the number after the last "Answer", else the last number. A code check tests the last fenced block that defines the entry function, else the first block. Choice and number checks mark replies with nothing readable as `unreadable`, apart from wrong answers. The suite version moves to 12 with the new questions of the same change.
- **Consequences**: The correct-form probe now passes 6/6 exact, 4/4 one-of, 7/7 choice and 4/5 number (the last gives no "Answer:" though asked to). Scores of earlier suites are not comparable.

### ADR-053: Suite v12 adds chat and long-context questions
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: The chat task had 54 items, but 24 were public multiple choice and 11 short facts; only 6 tested following an instruction or a format. Long context had 51 items, 40 of them generated lookups and only 3 of another kind.
- **Decision**: `benchmarks/own-items-v12.mjs` adds 30 chat items (instruction and format: bullets, JSON, YAML, a Markdown table, word limits, lowercase, no digits, no letter e, a start or end word, translation, tense, ordering, a polite refusal, a summary) with three new check types (`bulletCount`, `maxWords`, `containsAll`), and 12 long-context items generated from fixed seeds (two-step manager-to-room lookups, which delivery came first in a shuffled dated log, whether a parcel is listed, a budget code defined at the top and asked about a person far below). Every chat item has a reference reply that passes and a plausible wrong one that fails, and every long-context answer is read back from its own document, in `tests/benchmark-suite-v12.test.js`. With the answer readers of ADR-052 this is suite v12.
- **Consequences**: 310 items; chat 84, long context 63. Saved profiles show a suite-changed warning until re-tuned, and the tune:gate baseline must be made on v12.

### ADR-054: Each preset is checked on items it was never tuned on
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: A task's preset was chosen on its rungs and its gain over the defaults was measured on the same items, so the reported gain was optimistic (the best of many tries fits its own items), and a preset that only fitted those items was applied anyway.
- **Decision**: `taskHoldout` holds back one quarter (rounded) of every category/family/dataset bucket of a task, at evenly spaced positions across the bucket rather than its tail, so every kind of item is checked unseen; rungs come only from the rest. A family is an item's `group`, such as one code-comprehension function. Once a task's sampling and prompt stages are both done (and when either changed), the tune scores the final preset and the untuned settings on the held-back items, paired, and records `holdout` (items, rate, range, default rate, paired change and p). A preset worse than the defaults there falls back: the task's stored settings become empty, so the defaults apply, and the record says so. The time-left estimate counts these answers. The rung test of ADR-038 asks for at least 36 tuning items; in suite v14 code and comprehension tune on 48 and recall on 46.
- **Consequences**: Suite v14 holds back 35 code, 16 comprehension and 16 long-context items (v12's chat/math split is historical). The task hash changes, so saved profiles are stale until re-tuned, and the tune:gate baseline is made after this change.

### ADR-055: A running tune is shown live
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: The Bench panel polled the tune status every two seconds and showed only each model's last event (stage, setting, time left); which values were being tried, how they scored and what was decided were visible only after the run.
- **Decision**: The scheduler keeps a live summary per model from the tune's events: answers so far against the expected count, the latest time left, the setting being tried with each value's latest round (score, time, tokens), and the last 30 decisions with their reasons. It calls subscribers after every change. `GET /api/tune/stream` sends the job at once and then after each change as server-sent events, gathering changes within 250 ms and sending a keep-alive comment every 15 s, and stops listening when the page goes away. The panel listens to it while open and falls back to polling if the stream fails.
- **Consequences**: The panel shows a running tune's sections as it goes. A tune started outside the app (the CLI, the tune gate) is not part of the scheduler and is not shown live.

### ADR-056: Each task's result is broken down by question type
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: A task's preset was reported as one rate, so a setting that helped one kind of question (say, writing functions) and hurt another (fixing bugs) looked like a small net change. The benchmark is what sets ModelDuck apart, and its question types were invisible in the tuner.
- **Decision**: The tune takes `typeOf(itemId)` (the tune job passes each suite item's category), and a task's statistics and its held-back check carry `byType`: per question type, the items and right answers for the chosen settings and for the defaults. Details and a run's detail show them under "By question type" in plain words (for example "Work in a codebase", "GSM8K word problems"), with the types the preset answers worse than the defaults marked.
- **Consequences**: Per-type counts are small (often under 15), so they show where to look rather than prove a difference; the task-level paired test stays the decision rule.

### ADR-057: The shared quality settings are checked on every task
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Device, quality and speed settings are shared by all of a model's tasks; only sampling and prompt are per task. The quality stage (context and KV cache) chooses on a mix of every task's items, so a setting much better on one task could win while clearly hurting another.
- **Decision**: After the quality stage, each task's share of the last load level (`rungs.loadByTask`) is scored with the chosen settings and with the settings before the stage, paired, from the answers the sweep already measured. A task worse at `changeAlpha` (0.2, uncorrected, so every task is protected) sends the quality settings back to those before the stage. The profile's load carries `perTask` (each task's rate before and after, p, worse) and `reverted` (the task that lost); Details and a run's detail state it.
- **Consequences**: A shared setting can no longer trade one task for another unnoticed. Since the check uses already-measured answers, it costs nothing extra.

### ADR-058: The app describes the benchmark suite
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: The suite is what sets ModelDuck apart, but what it asks was only visible in the source: which question types each task has, how many items, where they come from, how answers are checked and how many are held back.
- **Decision**: `suiteSummary()` in `benchmarks/tasks.mjs` derives, per task, the items, the held-back items, the items tuned on and the rung sizes, and per question type the items, held-back items, sources (own or the public dataset) and check types, from the suite itself. `GET /api/benchmarks/suite` returns it, and a Benchmark tab in the Tune and benchmark dialog shows it in plain words.
- **Consequences**: The description cannot drift from the suite, since it is computed from the same items and split the tuner uses.

### ADR-059: Per-type results say when they are too few to tell
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: ADR-056 shows right answers per question type, but most types have under 15 items, so a row where the preset is two answers behind the defaults was marked as worse even when that is within noise.
- **Decision**: Each `byType` entry carries `p`, the exact McNemar test of that type's own paired answers (items the defaults got right and the preset lost, against the reverse). Details and a run's detail add a column: "clearly better" or "clearly worse" when p < 0.05, otherwise "too few to tell"; only a clearly worse type is marked.
- **Consequences**: Profiles tuned before this have no `p`; their rows show "–" and keep the old marking. The task-level paired test stays the decision rule.

### ADR-060: Suite v13 fills the thin question types and gives math 48 tuning items
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: The Benchmark tab (ADR-058) showed knowledge with 3 items, long functions and long bug fixes with 6 each, and math tuning on 38 items while chat and code tune on 48, so per-type results (ADR-056, ADR-059) could rarely tell anything apart.
- **Decision**: `benchmarks/own-items-v13.mjs` adds 9 knowledge questions, 6 long functions to write (an LRU cache, a query-string parser, a dependency sort, a text table, the next calendar day, a Sudoku check), 6 long functions with more than one bug each, and 13 math word problems. Each long function passes its cases with a reference in `tests/reference-solutions-v13.js`, each buggy function fails at least two of its cases, and each math answer was worked out independently when math was part of the suite; suite v14 no longer runs those items. In suite v13, 64 math items held back the last quarter of each bucket (16) and math tuned on 48.
- **Consequences**: Suite v13 had 356 items (superseded by v14's 262); saved profiles and the tune:gate baseline went stale. The current totals are pinned by `tests/benchmark-suite-v14.test.js`; the v6/v9/v10/v11/v12 tests now prove their own items survive in `PROMPTS`.

### ADR-061: Codebase items that span functions or start from a failing test
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Every codebase item asked for one named function, either a new one, the corrected one or the culprit's name, so a model was never asked to change several functions together or to work back from a failing test to a cause in another file, which is most of real maintenance.
- **Decision**: `benchmarks/repo-items-v13.mjs` adds a planner codebase (seven files with a distractor) and twelve items on it and the v11 codebases: six changes that need more than one function or file changed (task priorities, the day a task was done, hours per tag, a transfer fee, stacked discount codes, numbered lists) and six fixes given only a failing test and its real output, whose cause lies outside the function the test calls. A `jsTests` check may carry `harness`: the reply's code blocks are all kept, in order, and a hidden `scenario` function defined after them runs the cases, so any function the reply redefines replaces the codebase's own; a reply with no function definition is unreadable. `tests/benchmark-suite-v13-repo.test.js` proves every case passes with a reference reply, fails on the unchanged codebase, that each quoted output is what the shipped codebase really produces, and that a reply split over two code blocks passes in the sandbox.
- **Consequences**: Suite v13 has 356 items; code has 124, still tuned on 48. Older items keep the single-block reading of ADR-052.

### ADR-062: A value that falls behind stops on its rung, and a sweep ends with nothing left to compare
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: A full tune takes hours, and successive halving carried every value up to the next rung even when the answers already showed it far behind. A value can only win by being at least as good as the leader, and the prompt screen already stopped a candidate 3 items behind on its first 12 items (ADR-049); the 12- and 24-item rungs of every other axis had no such rule, so a clearly worse temperature or thread count still answered 48 items.
- **Decision**: When any rung of at least `MIN_SCREEN_ITEMS` (8) items ends, a candidate `screenGap` (3) or more items behind the leader stops and is recorded in `dropped` with its score and gap. The current setting is never stopped, since the decision, the paired test and the fallback need it. If only the current setting remains, the sweep ends there, records `endedEarly`, and keeps it without measuring later rungs. `stageBest` is updated only from a winner measured over the axis's whole last rung, so a short sweep cannot raise the bar for later axes; the tolerance, paired decision and fallback rules are unchanged. The time-left estimate still counts one pass, so it stays an upper bound (ADR-045). Items, rungs and the search space are unchanged, so no suite version bump (G-003).
- **Consequences**: A value 3 or more items behind after 12 items costs 12 answers per seed instead of 48, and after 24 items costs 24; a sweep whose challengers all fall behind ends after the first rung. Tests "a candidate clearly behind on a rung stops there, and the sweep ends when only the current setting is left" and "a candidate within reach of the leader is measured on the next rung" pin both halves. Fully scored axes (system prompts) also end early now when every other prompt has fallen behind, and their sweep shows only the screen rung.

### ADR-063: A value stops on sequential evidence, and changes need a Holm-corrected paired gain
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: ADR-062 stopped a value that was 3 items behind on a rung. That gap is a heuristic with no error bound: a lucky 3-item gap cost a value the rest of the axis, while a value that was consistently worse could still cost every rung. The final change bar divided `changeAlpha` by every value first tried, including values already screened out.
- **Decision**: A rung is checked at `looks` (4) equal item blocks. The current setting answers first, so every challenger is compared with a complete reference. A challenger is scored at each look and stops as soon as it is significantly worse than the best completed value in a one-sided exact McNemar test, with `changeAlpha` (or `stopAlpha`) spread equally over the axis's looks; a non-finite stop alpha turns the screen off. A stopped value is recorded with its score, gap, p and item count and leaves the sweep; if only the current setting remains, the sweep ends. The final decision computes the paired p of every surviving challenger against the current setting and Holm-adjusts them; a quality-only change needs the chosen challenger's adjusted p ≤ `changeAlpha`, which is recorded as `pAdjusted` beside the raw `pValue`. `paired` now skips items the two runs do not share, so a prefix can be compared with a complete run.
- **Consequences**: Stops need evidence rather than a 3-item gap: a marginal value may be measured longer, but a real loser stops at 6, 9 or 12 items instead of the rung's end. Holm keeps the bar at 0.2 for the best survivor instead of dividing it by every value first tried (22 prompts screened to 9 survivors no longer implies 0.2 / 21). The mechanics tests run with `changeAlpha: Infinity`, which also turns the screen off. Sweeps gain `pAdjusted` and stopped candidates carry `partial`.

### ADR-064: A tune searches only items that can still tell settings apart
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Many suite items are saturated for a given model: the weakest answers almost none and the strongest almost all, so no setting changes them. They still cost a full rung for every candidate and add noise to the choice. Every saved tune run already keeps its answers in `<home>/tune-runs`.
- **Decision**: `itemOutcomes()` aggregates every non-error answer of a model's saved runs and marks an item saturated when at least two looks all passed or all failed. `withDiscriminatingRungs()` rebuilds each task's search rungs from the other items, keeping the 12/24/48 sizes, and keeps the whole tuning set in `rungs.final`; a task left with fewer than 12 discriminating items keeps every item. `tune()` scores the final preset and the defaults on `rungs.final` and the holdout on the held-back items, so reported rates and `tune:gate` (which builds `tuneRungs` unfiltered) stay on the whole set. The profile records `tunedOn` per task: the ids searched, the ids excluded, and whether it fell back. The first tune of a model has no history and uses the whole set.
- **Consequences**: Later tunes of the same model ask fewer answers per candidate without changing the reported rate or the gate. The search subset is not part of the task hash, so existing profiles are not marked stale; a profile now says which items it learned from. A resumed profile's earlier parts may have been measured on an earlier subset, but its final statistics are always on the whole set. The tune reads every saved answer of the model at start, line by line; a long history makes that read longer.

### ADR-065: A Quiet speed preset caps the threads for laptop heat and noise
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Fastest and Light were the only measured presets. Light leaves half the threads free; on a laptop the user may want a much quieter run, and thread count is the main lever the speed stage already measures.
- **Decision**: The speed stage derives a third preset from the same thread measurements: the fastest setting at no more than a quarter of the logical cores, capped like Light. It is stored as `speed.quiet` (Fastest and Light keep their shapes), the Settings preset list offers Fastest/Light/Quiet, and the setting is validated in `config.js` and `tuned-settings.js`. A profile from before Quiet falls back to Light when Quiet is chosen. Quiet differs from Fastest only in threads.
- **Consequences**: No extra answers are needed; the preset is a different point on the same measured curve. A Quiet model is slower but cooler and quieter. Capping GPU layers for power is not part of it yet.

### ADR-066: A model too large for VRAM tries smaller GPU offloads
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: The device stage tried every layer on the GPU and, only when that failed to load, half. A model that fit at 75% or 25% of its layers was treated as an all-or-nothing CPU model.
- **Decision**: When the all-layer load fails, the device stage tries three quarters, half and a quarter of the layers in that order (distinct counts, below the full count), stopping at the first that loads. The usual verdict then decides: the offload must be measurably faster than the CPU and answer at least as many items. Each attempt appears in the probe with its verdict.
- **Consequences**: Up to three extra loads are spent only after a failure. A partial offload can turn "will not fit" into "fits and is faster" on an 8–16 GB card. A larger offload that loads is preferred, because it leaves less work on the CPU.

### ADR-067: A tuned profile travels as a checked recipe
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Profiles were local to one machine. Two users with the same model, runtime and similar hardware cannot share a measured configuration, and a user replacing a computer loses the evidence behind it.
- **Decision**: `GET /api/profiles/:id/export` returns a `modelduck-profile` recipe: the applied settings, the fingerprint, the tuned-item subset and a compact receipt (stages, per-task rate and holdout), without the sweep log or resume state. `POST /api/profiles/import` accepts only an installed model's recipe, checks the kind, schema and catalog id, keeps only known settings whose values `normalizeSettings` leaves unchanged, drops unknown tasks, and sanitizes the receipt to finite numbers. An imported profile has `stages: null` and `search.imported`, so it applies but is never presented as tuned here; its fingerprint still drives the usual stale warnings. Import is loopback-only, and the body is limited to 512 KB.
- **Consequences**: A profile can be shared and lands as an ordinary file. The importer trusts no settings it cannot validate and no number it cannot read. The receiving machine still needs the same model installed; a different runtime, suite or CPU warns as stale rather than silently applying.

### ADR-068: A preset's clearly worse question types are named outside Details
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: By-type results and their p-values already existed in the collapsed Details table (ADR-056, ADR-059), but a user choosing a task in chat or scanning the model table could apply a preset that was clearly worse on one kind of question without noticing.
- **Decision**: `typeWarnings(profile)` names, per task, the question types whose paired test is below 0.05 and whose preset answers fewer items than the defaults. The tune overview and the profile route return it; the model row and Details show it; the chat reply label shows the preset's rate and marks a warning. No question type is inferred from the user's message: the task picker stays the only routing choice.
- **Consequences**: A type regression is visible where the preset is chosen, not only after opening a table. The warning is a description, not an automatic switch; a preset that is worse on a type still applies until the user runs that task's stage or chooses the defaults.

### ADR-069: The Bench panel recommends what to run on this PC
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Choosing a model and quantization is the largest efficiency decision, and the tuned profiles already hold each model's task rate and tokens per second. The app asked users to compare the table themselves, and the catalog said nothing about whether a model fits.
- **Decision**: `GET /api/recommendations?task=` ranks installed models that fit by measured task rate, then tokens per second, then memory, using `estimateLoad`/`fitVerdict` at the profile's own context and KV cache; a model without a KV shape is judged on weights plus the runtime reserve. Catalog models that are not installed and whose weights plus reserve fit are listed as estimates, recommended first, with the note that the KV cache adds more. The Bench panel shows "Recommended for this PC" with measured and estimated rows apart.
- **Consequences**: The ranking is evidence where evidence exists and is labeled as an estimate where it does not; no model is downloaded or loaded by the recommendation. A first tune is still what turns an estimate into a measured row.

### ADR-070: Coding is tuned on its own views, prompts and items
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: The code task is 136 heterogeneous items: writing functions, long functions, codebase changes, bug fixes, bug hunting and public benchmarks. One overall rate let a preset get better at short functions while getting worse at fixes and still win. The prompt stage tried the same generic directives on every task, and public code items may be in a model's training data.
- **Decision**: (1) `CODE_GROUPS` maps the code categories to three views — write (`code`, `code-long`, `public-code`), fix (`bugfix`, `bugfix-long`) and repo (`code-repo`, `bugfix-repo`). After a code task's axis chooses a candidate, the tuner compares it with the current setting on each view with at least 8 items. If it is clearly worse on any view (paired p < 0.05, more losses than gains), a candidate that is not worse on any view takes its place; if none passes the axis's floor, the current setting stays. The sweep records `groups` and, when the guard acts, `groupGuard`. (2) `promptAxes(steps, task)` gives code `[SYSTEM_PROMPT, ...CODE_PROMPTS]` and reasoning off/auto/deep; a user's custom prompt or reasoning list is used unchanged. (3) `runTune` adds every `public-code` item to the search exclusion set, so the search is chosen on ModelDuck's own code items; `rungs.final` keeps them, so the final statistics and `tune:gate` still score the whole code task, and `tunedOn` records the excluded ids.
- **Consequences**: A code preset can no longer buy an overall gain by silently sacrificing fixes or codebase work; the guard only runs when the last rung has at least two views with 8+ items, and a stopped or partial rung skips it. Coding tries fewer, more relevant prompts and one extra reasoning candidate. The gate and reported rates are unchanged in scope, and no suite hash changes; only the search subset changes, and it is recorded. Thin views still rely on the by-type warning rather than the guard.

### ADR-071: Chat moves to ChatDuck; ModelDuck keeps the control panel
- **Date**: 2026-10-31
- **Status**: Accepted
- **Context**: ChatDuck is now the dedicated static chat client for any OpenAI-compatible server. ModelDuck's bundled chat shell duplicated that job and kept a second conversation store, a second Markdown renderer and chat-only routes alive.
- **Decision**: Remove `ChatStore`, `POST /api/chat`, `POST /api/chat/abort`, `/api/conversations*`, the chat sidebar/main/composer, `public/markdown.js`, and the chat-only tests. Keep `/v1`, models, tuning, settings and the Bench panel. The ModelDuck page becomes a control panel (Models, Bench & Tune, Settings, Server) with a link to ChatDuck.
- **Consequences**: The suite passes with `npm test`. Existing `chats.json` / `chats.archive.json` files are left on disk but no longer read; ChatDuck keeps conversations in the browser. The OpenAI API and every tuning route are unchanged.

### ADR-072: The coding suite is code, code comprehension and long context
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: ModelDuck is a coding-model optimiser. Chat, math, factual history and prose comprehension measured general ability, diluted the tuning objective and could let a preset win on unrelated questions while losing on code. The v13 suite also had only generic reading-comprehension items, not code reading.
- **Decision**: Suite v14 keeps three tasks: `code` (write, fix and codebase work, 136 items), `comprehension` (64 new code-reading items: read a small function and report its result for eight inputs), and `recall` (long-context lookup, 62 items). The prose `squad` item is removed. Chat, math, factual, public knowledge, public truthful and prose-comprehension categories are excluded from `PROMPTS`; the historical item files remain as provenance but are not run. The API default task and recommendation default become `code`; the task ids are `code`, `comprehension` and `recall`.
- **Consequences**: Suite total is 262 items; rungs are 12/24/48 for code and comprehension and 12/24/46 for recall, with a held-back quarter. `x-modelduck-task` accepts code, comprehension or recall; chat/math headers now fail with an unknown-task error. Test hashes, task hashes and saved profiles are stale, and the model/tune baselines must be regenerated deliberately. The UI, Bench suite summary and tune settings use the three tasks; the recommendation panel asks for code by default.

### ADR-073: The Bench dialog is a sectioned workspace
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: Six horizontal tabs, five large stage cards and stacked report cards made the Bench dialog dense on a desktop and hard to scan, while narrow screens lost the full-screen dialog treatment. The control panel needs one clear place for tuning, model profiles, runs, settings, the suite and the gate.
- **Decision**: The Bench dialog uses a vertical section rail above 980px and a horizontal, scrollable rail below it, with six sections: Tune, Models, Runs, Tune settings, Benchmark and Benchmark gate. Tune presents stages as a flat two-column ledger and includes a collapsible **How tuning works** section that explains the stages, rungs, clear-gain rule, held-back check and non-training scope. Runs uses a list/detail split; Models and the suite use flat rows and tables; the gate uses one column with its live controls above the reports. Old card panels are flattened. At 640px and below the dialog becomes a full-screen sheet. `aria-orientation` follows the rail, and both arrow pairs move between tabs.
- **Consequences**: Every section is reachable without horizontal tab crowding, the page keeps the warm workbench theme, and the smoke test covers all six panels and 390px reflow. The dialog is larger (1280px maximum) but still bounded by the viewport.

### ADR-074: Tuning exposes scope, a quick pass, pause and a held-back guard
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: A full tune can take hours across three tasks. Users need to tune only the task they care about, see a useful preset before the full run finishes, understand the cost before starting, pause a long queue, and stop when a preset falls back on unseen questions.
- **Decision**: The Tune panel selects Code, Comprehension and Long context independently and sends the selected task ids. A preflight endpoint returns expected answers and a one-pass estimate for the selected tasks, stages and models. **Quick pass** runs the first rung of every selected stage, saves the partial profile immediately and then continues automatically on the full rungs. **Pause** and **Resume** stop and restart the queue between models; the running child finishes its current answer. **Run in background** closes the dialog after starting. **Stop on a held-back regression** stops the remaining tasks when the first held-back check falls back to the defaults. The tune-run child accepts `--quick` and `--guard`; the scheduler owns the automatic full continuation.
- **Consequences**: Task scope reduces a code-only tune to the code task, quick pass makes a provisional preset visible early, and a pause does not discard current work. The full continuation still measures the same stages on the full rungs, and the guard leaves the remaining task statuses partial so a later continue can finish them.

### ADR-075: Tuning uses measured cost, a durable queue and baseline guardrails
- **Date**: 2026-11-01
- **Status**: Accepted
- **Context**: The preflight only showed a full-pass estimate at a fixed three seconds per answer, so Quick pass looked as expensive as a full tune; a queue could not be reordered and vanished when the app restarted; and a guardrail only compared fresh held-back answers, not the model's saved profile, and stopped only the current model's remaining tasks.
- **Decision**: The estimate endpoint returns quick and full costs, per installed model, from the first rung and full rungs. It reads each model's latest completed/stopped run summaries and uses median seconds per answer with low/high range; models without history use 3 s/answer. The scheduler writes a `tune-queue.json` snapshot, restores it paused after a restart, and exposes `POST /api/tune/priority` plus row arrows for pending models. A guard compares the final task rate with the saved profile's rate as well as the held-back defaults; `guardQueue` stops every queued and running model through the guarded status.
- **Consequences**: Quick pass now has an honest early estimate, queue order survives an app restart, users can reorder pending models, and a regression can halt the whole operation. A restored queue resumes with `--continue`; completed items are skipped. Measured pace is a whole-run average, not per-stage loading time, so the low/high range is deliberately shown instead of a single promise.

### ADR-076: Tuning decides on task-weighted speed, greedy code starts, partial credit and clustered guards
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: The verification follow-up showed the speed stage ranked candidates on six short, prefill-bound items, so batch sizes and thread counts that are fast for short prompts won even when slower for decode-heavy code answers; code sampling started at temperature 0.7 which incumbents then kept; the paired test ignored the fraction of checks passed on multi-check code items; and item-level p-values in the guards treated eight inputs of one function as eight independent witnesses. No suite, check or prompt text changed, so no new items were needed.
- **Decision**: (1) The speed stage records per-item prompt tokens, builds median prompt/output token profiles per task from the reference run, and ranks candidates by usage-weighted predicted latency (code 0.5, comprehension 0.25, recall 0.25, overridable via `taskWeights`), falling back to raw latency without throughput data; records carry `predictedMs`, `taskProfiles` and `taskWeights`. (2) Code sampling starts at temperature 0 (resume still wins). (3) `score()` records seed-averaged partial check credit; `paired()` prefers credit, then fractions, then majority votes, reducing to exact McNemar on binary diffs. (4) `pairedClustered()` sums diffs per function/codebase cluster and runs the sign-flip test on the sums; hold-out, per-task and view guards use it when `clusterOf` is available (comprehension prompts carry their function as `group`), falling back to the item test otherwise. (5) The deep reasoning directive asks for a few short sentences of thought then the final answer on its own line (final fenced block for code), which the checkers already read.
- **Consequences**: `TUNER_VERSION` is 5, so saved profiles and baselines are stale and must be regenerated deliberately; no suite hash changes. A code-weighted choice can keep a raw-slower incumbent, and a one-function regression no longer reverts a task or falls back a preset on its own. Partial credit only sharpens the paired test; headline rates stay all-or-nothing.

### ADR-077: Comprehension becomes 32 functions x 2 inputs with whole-function holdout
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: Code comprehension was 8 functions x 8 inputs. A setting that changes how a model reads one function flips several of its inputs together, so item-level p-values were 3-4x too optimistic (S4), and the held-back set reused the same 8 functions the search tuned on (S5). The suite still has 64 comprehension items, 12/24/48 rungs and a 16-item holdout.
- **Decision**: The bank is 32 small functions with 2 inputs each (the 8 originals trimmed to two discriminating cases, 24 added in the same exact-check style with values computed from the shown code). `split()` holds back every fourth whole bucket when every bucket has at most 2 items, so whole functions stay unseen while the tuned pool keeps 48 items and full rungs. Other tasks keep per-item stratified holdout. Suite version is 16; the task-subset hash changes with the item definitions, so saved profiles and baselines are stale and must be regenerated deliberately.
- **Consequences**: Guards and sweep statistics see 4x more independent clusters for comprehension; the held-back check no longer leaks functions. Rung sizes, holdout share and the smoke set are unchanged. `withDiscriminatingRungs` is unaffected; one task test pins `readmitFraction: 0` so hash luck cannot lift a nearly-saturated pool above the fallback floor.

### ADR-078: A pair check tries the two most influential settings together
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: Coordinate descent misses interactions: once temperature 0 wins first, a combination such as "T 0.2 with min-p 0.1" is never tried, and the same holds for repeat x maxTokens or promptRepeat x reasoning. The second planning pass deferred this as the "pair check".
- **Decision**: After the passes converge, `descend()` ranks swept axes by paired net flips (then rate spread), takes winner and runner-up of the top two, and sweeps the three new combos on the last rung. The normal machinery (halving, Holm, tolerance, unproven-change guard, confirmation) decides, so a combo stands only with evidence. Overlapping knob sets are refused; quick passes skip it and the full continuation runs it. Resume treats it as a named sweep (`pair:a+b`) that the measurement cache makes nearly free to repeat.
- **Consequences**: `TUNER_VERSION` is 6; saved profiles and baselines are stale again and still await deliberate regeneration. Each sampling/prompt/quality stage with at least two swept axes spends up to 3 last-rung combos more answers; stages with fewer axes are untouched.

### ADR-079: Long-context KV confirmation items outside the search
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: The KV cache was chosen on prompts of ~1k tokens but served at up to 16k tokens, and a quantized cache degrades with context length (M6). The load rungs cannot see this: they run short items.
- **Decision**: Three seeded recall needles at about 4k, 8k and 16k tokens (one `long-context` family, exact checks) join the suite but stay out of the tuning pools, the holdout, the speed workload and the smoke set; rungs, holdout and budget counts are unchanged. After the quality stage, when a non-f16 KV cache was chosen, the tune scores f16 against it greedy with one seed on the long items that fit the budgeted context, sized with headroom; any item lost reverts the cache to f16. Suite version is 17 and the tuner version is 7, so saved profiles and baselines are stale and await deliberate regeneration.
- **Consequences**: KV choices are confirmed at served lengths instead of chosen lengths. The confirmation costs at most two greedy single-seed scores on up to three items, with one larger-context reload; sizes above the budget are skipped.

### ADR-080: Literature-backed tuner search changes (sampler, DRY, fence, mixed K/V, give-ups)
- **Date**: 2026-11-02
- **Status**: Accepted
- **Context**: An external literature and GitHub review (scratch/lit-review-code-tuning.md) found the tuner grid missed the literature-optimal regions for code: top-p dominates temperature (our low-T profiles ran untruncated at top-p 1); token repetition penalties harm code while sequence penalties (DRY) fit it; K-precision dominates V in KV caches (Kq8/Vq4 is the Pareto point); response-prefix plus closing-stop recipes keep code-only output; and agentic failure reads as empty answers, which the score did not count. `thoughtTokens` and prompt pruning were verified but deferred: no reasoning models in the catalog to measure a budget on, and winner history is too thin to retire any directive.
- **Decision**: (1) Sampler profiles pair T<=0.4 with top-p 0.8, T<=0.8 with 0.9, T>0.8 with min-p 0/top-p 0.85; combo count is unchanged. (2) Code sampling starts with `penalizeNewLine: false` next to the existing repeat-1.0/T-0 starts, and the tuned preset records it (recipes carry the key now). (3) A code-only `dry` axis (off vs strength 0.8, base 1.75, allowedLength 4) and a code-only `codeFence` axis (off vs "```" prefix plus closing stop, moved together) join the search, wired through config, engine chat and completion paths, OpenAI preset apply and profile recipes. (4) Mixed KV label `q8_0:q4_0` (key/value types resolved separately in V2 estimates, load fit and context creation; memory math uses the K/V mean) replaces symmetric q4_0 in the quality defaults, which stays a valid opt-in. (5) `score()` records `giveUpRate` (0 tokens or blank text, errors excluded) beside `truncationRate`.
- **Consequences**: `TUNER_VERSION` is 8; saved profiles and baselines are stale and await deliberate regeneration after the running v7 pilot validates the gate mechanics. The new axes cost a handful of extra sampling answers on the code task only; other tasks are untouched. Runtime acceptance of DRY, fence and mixed KV on real hardware awaits short engine benchmarks, which need a free engine.

### ADR-081: The 27-shot gallery is pre-redesign history; fresh captures wait for a clean tree
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: The 27 gallery stills (taken 2026-11-01) predate the UI redesign (redesign.css deleted, styles/app rewritten) and carried empty commit fields; the working tree is mid wave-12 with uncommitted UI changes, so any capture now would bake dirty pixels.
- **Decision**: Backfill all 27 `media.json` entries with the gallery commit `4ba064d` and a pre-redesign caption note; add a currency line to the README gallery link; defer regeneration to `npm run ui:shots` on a clean tree. No dossier ingest: there is no current proof to place.
- **Consequences**: The gallery stays honest history with resolvable commits; fresh proof is one scripted command away once the tree settles.

### ADR-082: Stage 3 qwenFS merge stays a hermetic toy; widened serving is rejected
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: The verified map asks for a qwenFS -> ModelDuck toy (`qfs/merge.py` widen 2048 -> 3072 zero-pad, norm gains x sqrt(2048/3072), FS layers front plus vocab append; `qfs/circuit.py` ballast/padded-rails; `qfs/disk.py` layout; limits max 32 scripted sessions with no search) without touching the benchmark suite, the test hash, or the fixed-shape GGUF runtime.
- **Decision**: Add `src/checkpoint-merge.js` (pure `widenResidual(W,k)` / `appendVocab(E,n)` / `rescaleNorm(gain)` on plain toy arrays, EPS-sized, no safetensors ingest, no runtime widen, no model download, no retraining) plus hermetic `tests/checkpoint-merge.test.js` (shapes, norm-equivalence, seeded scripted-session digests via `src/generation-manifest.js` `digest()` reuse). Do not wire it into `src/engine.js`; do not touch `benchmarks/suite.mjs` / `matrix.mjs`.
- **Consequences**: Transferred: toy widen/append/rescale shapes and norm-equivalence plus digest determinism. Rejected on record: production widened serve (GGUF-only ingest plus fixed-shape runtime cannot serve a 3072-wide model). Suite v17 test hashes are unchanged; `npm test` and `python aikit.py check modelduck` gate the change.

### ADR-083: Long-context quality-vs-length curve as a measurement-only tool
- **Date**: 2026-11-03
- **Status**: Accepted
- **Context**: LSA's measurement shape is accuracy at several context lengths (paper §4, RULER 4k→10M). The harness had the pieces (M6 4k/8k/16k needles in ADR-079, prefill/decode split in the tuner) but no quality-vs-length report and no harness-fixed way to compare two load settings on the recall task.
- **Decision**: Add `benchmarks/context-curve.mjs` (`npm run bench:curve`): greedy one-seed score of the 65 locked recall items under 2+ load variants (default contextSize 16384, CPU lane; first use: kvCache f16 vs q8), grouped into <2k / 2-8k / 8k+ buckets by measured prompt tokens, with the tuner's prefill/decode medians. Comparability is structural: one `curveTestHash` over the shared definition (suite, prompts, items, system prompt, seed) — load settings are never hashed, so a variant pair can only differ in load; runtime/model/item drift refuses instead of printing. Reports land in `benchmarks/curves/`; baselines, profiles, tune runs, history and the suite are untouched (no version bump). Hermetic unit tests in `tests/benchmark-context-curve.test.js`.
- **Consequences**: First measurement (Qwen2.5-0.5B Q4, seed 42, `curves/qwen2.5-0.5b-instruct-q4-*.json`): quality identical 33.8% (22/65) with zero per-item outcome diffs across all 65 items including the needles — q8 KV holds quality to 16k on this model (the M6 question answered for it); 8k needle passes, 16k fails in both. Speed split was confounded by run order (f16 first on a cold box, q8 second warm; 5-10x per-item gaps on identical prompts) and was not claimed as a KV effect. Swapped-order needles confirmation has since landed (`curves/qwen2.5-0.5b-instruct-q4-needles-swapped.json`, q8-first): quality identical again at 66.7% (2/3, 4k/8k pass, 16k fails in both), prefill 58.68 vs 48.01 t/s (+22% q8, noisy) — the 5x gap is confirmed as box-state, not a KV effect. Only three items sit above 2k, so the length curve is thin at the top; longer-code items would strengthen it without touching the suite pools.

### ADR-084: tune:gate resolves models from the real models folder
- **Date**: 2026-11-04
- **Status**: Accepted
- **Context**: The gate isolates profiles/runs in a temp home but passed only `home` to `openTarget`, so `resolvePaths` derived `models` from the temp home and the registry scanned an empty folder: every model reported "not installed" and the gate could never pass, masking the real comparability verdict underneath.
- **Decision**: Default `--models-dir` to the real models folder (`resolvePaths({}).models`) when the flag is absent; the temp home still isolates profiles/runs, and an explicit `--models-dir` still wins. Two-line change confined to `benchmarks/tune-gate.mjs`; no baseline, suite or comparison logic touched.
- **Consequences**: The gate now reaches its comparability check, which honestly reports the next pre-existing state (WIP `baseline-profiles.json` at tunerVersion 7 vs current 8) instead of a phantom missing-model error. Deliberate baseline regeneration stays maintainer scope and is not run here.

### ADR-085: A sampler change re-opens the prompt it was measured with
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The prompt stage scores each candidate on the sampler in force at that moment, and the profile applies prompt and sampler together. Part runs are independent (ADR-040), so re-tuning `temperature` after the prompt stage leaves the saved prompt, and its stats, measured on the old sampler. The coder profile shows it: its prompt was screened at temperature 0.7 while the profile serves 0.4. A 48-item paired screen of 17 prompt variants and 5 sampler variants at the served settings found no better candidate (the accepted prompt ties the best at 59%; every challenger p >= 0.2), so the remaining defect is that the stored choice is unproven under the settings it is used with, not that another candidate is better.
- **Decision**: Record the sampler signature (`sampledWith`: the task's sampled keys of the settings) when a prompt stage finishes. On every task pass, when the current signature differs, discard the prompt's status, done list and stats while keeping its settings as the incumbent, so the prompt is measured again on the sampler the profile applies. A sampling-only run marks it pending; the next tune measures it. Profiles saved before this change carry no signature and are left untouched.
- **Consequences**: A sampling re-tune can cost one prompt re-measurement (at most 9 code candidates x 48 items x 3 seeds) instead of silently serving an unproven prompt; `stages.prompt` reads "pending" until it is measured again, and `pendingWork` keeps such a profile from being skipped. Tests cover the same-sampler no-op, the invalidation and the re-measurement.

### ADR-086: One state-machine module; states drive the UX and the API
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: A 25-machine audit found the engine phase, download jobs and benchmark jobs as bare string literals compared at each use site, plus boolean clusters in the UI. That is how a canceled download could be marked complete, a load could stay `loading` forever when the pre-`try` unload threw, two concurrent starts could share one `.part`, a freshly created API key was erased before it could be copied, and a settings close discarded edits silently. Only `GET /api/health` exposed host facts; subsystem state was unreadable to an agent.
- **Decision**: Add `src/state-machine.js` with immutable machines for the engine phase, one download job and one benchmark child: named states, legal transitions, terminal states, an actionable `invalid_state_transition` error and a JSON catalog. Assert transitions at the engine's status writes, use `moveTo` in the downloader (terminal states never move; cancel before promotion returns) and benchmark runner (one terminal outcome per job; a replaced job's child cannot null the new one). Add a synchronous download-start reservation. Fix the engine's pre-`try` load failure and teardown-throw paths, clear `fit`/`contextFallback` on teardown, expose `phase`, JIT tracking, registry scan counters and the machine catalog in `/api/health`. In the UI: keep a created key visible until close, track `settingsDirty` and ask before discarding, serialize confirms, give pollers timeouts/in-flight guards and a visible failure after three download failures, render `restartRequired` from the server's listener comparison, and disable LAN/CORS unless authentication is on.
- **Consequences**: Illegal transitions now fail loudly with a typed error instead of producing a lying status; the three subsystems share one vocabulary and `/api/health` makes it agent-readable. New test files pin the catalog, the terminal-state rules, the concurrent-start refusal, the health fields and the settings discard flow. `docs/state-machines.md` records all 25 machines and which findings were checked-and-not-defects; `docs/state-machine-proposals.md` records the judged proposals, including the deferred tune-stage/skipped-state and job-persistence work.

### ADR-087: A home lock whose owner is gone is taken over immediately
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: The home lock went stale only by mtime: the owner refreshes it every 10 s and the acquirer waits 30 s. Killing the server therefore left a fresh lock naming a dead PID, and the next start failed with "ModelDuck is already running" until the file was deleted by hand. Stage-4 checking of the Qwen 0.5B tune hit this and had to work around it.
- **Decision**: On `EEXIST`, read the lock's `pid`; when it is a positive integer and `process.kill(pid, 0)` says the process is gone (`ESRCH`), unlink the lock only if it still names that PID and retry at once. `EPERM` counts as alive. Unreadable or partially written locks keep the 30 s mtime rule, because a live owner may be mid-write. The heartbeat, the 3 s acquire timeout and the mtime backstop are unchanged.
- **Consequences**: A crash or kill no longer needs a manual lock delete, and a dead PID cannot be mistaken for a live one. Unit tests pin the dead-PID takeover and the refusal to steal a fresh unreadable lock; a live start → hard kill → restart repro confirmed the takeover and a healthy `/api/health`. A narrow unlink race with a new owner remains, bounded by the same-PID check and the mtime backstop.

### ADR-088: The default context is 16K, and the quality stage keeps the largest that fits
- **Date**: 2026-11-09
- **Status**: Superseded in part by ADR-089 (the preset and quality-stage parts); the 16K default stands
- **Context**: The app defaulted to a 4096-token context, and the tuner passed only the smallest size that covered the selected tasks to the memory budget (ADR-043's memory-first reading), so every installed profile and fresh tune landed at 4K. That is too small for the suite's comprehension and recall prompts (up to ~16.5K including answers), and 4K long-context items fail with "context is full". The user asked for more context: a 16K default, no 4K.
- **Decision**: `DEFAULT_SETTINGS.contextSize` is 16384; the Balanced and Quality-first presets use 16K (Token-saver and Cheap stay at 2K by design); the tuner's load defaults and the engine fallbacks use 16K. The quality stage now passes every size that covers the task need to `budgetContext`, so the largest that fits is chosen (memory permitting) rather than the smallest. The frozen `baseline-profiles.json` load stays at 4096 so the gate's regression reference keeps comparing like with like. `TUNER_VERSION` stays 9: task settings and the measurement method are unchanged; only the default and the load preference moved.
- **Consequences**: Fresh tunes on this machine select 16K (Qwen 0.5B measured 117,730,336 B at 16K); a tight machine still falls back to the largest size that fits, and the load fit check remains the backstop. The three installed profiles and their recipes moved to 16K, with `.before-16k-context-20261109` backups. Tests that asserted the old default were updated; the tune gate stays green because it measures the frozen 4K baselines.

### ADR-089: Context is a fixed 16K floor, not a tuning axis or a preset
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: ADR-088 raised the default to 16K but left the context in the tuner's quality stage and in the presets. The short test questions cannot tell context sizes apart, so the only effect of searching it is memory; passing the memory budget the smallest covering size reintroduced 4K profiles. The project is coding-focused and needs context, so a tuner or preset must not be able to lower it below 16K. Supersedes the preset and quality-stage parts of ADR-088.
- **Decision**: Context is no longer tunable: `DEFAULT_STEPS.load` and the step validator drop `contextSize`, `qualityAxes` tunes only `kvCache`, and the tune job no longer budgets context. `normalizeSettings` clamps it to 16384–32768, so every settings save and load is at least 16K; no setting preset overrides it. The engine no longer retries a load at 3K/2K/1K, so an out-of-memory load fails with its actionable error instead of silently shrinking the request. The frozen baseline profiles' load moves to 16384 with their settings and rates untouched, and the gate re-measures at that floor. `TUNER_VERSION` stays 9 because the measured settings and method are unchanged.
- **Consequences**: Profiles and presets always serve at least 16K (a model trained for less is clamped to its trained size by the engine). A memory-tight machine may refuse a 16K load; **Load anyway** and a smaller model remain the levers. Tests pin the floor, the absence of a context step or setting name, and the KV-only quality stage; the tune gate stays green.

### ADR-090: The gate reuses answers only from a fingerprint-identical world
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `tune:gate` re-asked every baseline answer (~142 items per model x up to 3 seeds x 3 core models, ~13 minutes) in a throwaway temp home, even when nothing that shapes answers had changed since the last gate. The tuner already had the reuse machinery for tunes - `Measurements.restore()` (G8) reuses exact settings/seed/item rows from `answers.jsonl` - but the gate never used it, so a settings-contract or API change re-paid the full measurement cost for evidence that was already in hand.
- **Decision**: The gate persists measured answers per model under `benchmarks/results/gate-cache/` (gitignored) keyed by a digest of the whole world: `currentFingerprint` (suite version, task hash, tuner version, model file and size, cpu/cores/platform/arch, node-llama-cpp) plus a content digest of the generation-path files (`src/engine.js`, `src/sampler-chain.js`, `src/checkpoint-policy.js`, `src/config.js`, `benchmarks/tune.mjs`, `tune-evaluate.mjs`, `tune-measure.mjs`, `tasks.mjs`, `tune-gate.mjs`). On the next gate, exact settings/seed/item rows are restored and only missing items are asked (the G8 semantics, reused via `measurePresets({ restore, onAnswers })`); transient error rows are never cached; the saved cache is the merge of restored and fresh rows (fresh wins per item). Any fingerprint axis change discards the stale cache - a fresh gate re-measures everything - and `--fresh` forces a re-measure deliberately. `TUNER_VERSION` stays 9: the measured settings and the statistics are unchanged, only the repeated asking of identical questions is removed; comparability is carried by the cache fingerprint, which is strictly finer than the baseline's.
- **Consequences**: A fingerprint-identical gate costs three model loads and no answers (~1 minute instead of ~13), with identical pass rates; any change to the engine, sampler stack, checkpoint policy, task set, runtime, model or hardware re-measures in full. Unit tests pin the fingerprint's determinism and edit sensitivity, stale/corrupt cache discard, the merge precedence and the restore-asks-only-missing behavior; a live two-run dogfood (cold-cache full run, then a warm run) verifies the reuse on the real engine. The cache file is derived data on one machine - it never migrates and is never inferred from partial rows.

### ADR-091: The gate probes with a rotating tripwire window and escalates on drift
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: Even a fingerprint-identical gate (ADR-090) still asks every rung on a cold cache, and any gate re-measures all 142 items per model after any generation-path change. The search itself already proved that escalating rungs (12/24/48 items) carry decisions safely, and a clean gate row always showed b=0 c=0: historically, no item ever flipped. Measuring the whole last rung for every task on every run spends answers to confirm what a 12-item window already proves.
- **Decision**: Each gate first asks a 12-item tripwire window per task - a rotating window over the last rung's order, advancing with the cache's run counter so consecutive gates walk around the whole rung instead of freezing the same items. The window's outcomes are compared per item against the baseline; any flip, any checked item the baseline never measured, or a failed probe escalates that task to the full rung (the probe items are not re-asked: the shared measurement cache serves them). Escalated tasks then compare exactly as the gate always did. A clean row passes on the checked subset: the baseline rate on exactly those items, tolerance over the checked count, paired b/c over them. `compareToBaseline` carries a `tripwire` annotation so rows show what was checked, and clean rows stay out of the Holm pool (their verdict is per-item identity, not a noisy rate comparison). `TUNER_VERSION` stays 9: the measured settings, items, checks and statistics are unchanged; only repeated asking is removed, and any drift still escalates to the identical full-run verdict.
- **Consequences**: A clean gate leaves most of each rung unasked (~4x fewer answers with a cold cache; with a warm cache, typically zero); a real regression is still caught because any disagreement escalates and the escalated verdict is bit-for-bit the old one, and the rotating window guarantees full-rung coverage over successive runs. Rows now report their checked counts. Unit tests pin the window rotation, the escalation triggers (flip, unmeasured item, failed probe), the probe-only and escalated flows, the clean-subset verdict, and that an escalated row equals an old full-run row in every verdict field. A live dogfood (cold-cache run with the tripwire, then a rotating warm run) verifies both ADR-090 and ADR-091 on the real engine.

### ADR-092: The gate-cache code digest derives from the engine's import closure
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: ADR-090 named the generation-path files in a hardcoded nine-entry list. The list was correct today, but it could only rot: an answer-affecting `src/` module added without being listed would never invalidate the warm cache, and the completeness test could only check the declared files, mirroring the flaw it guarded against. The push-delta review flagged the list as the most likely trap for the next contributor.
- **Decision**: The runtime half of the digest set is now derived, not declared: `generationPathFiles(root)` walks the static import closure of `src/engine.js` (11 modules today, including everything ADR-090 listed under `src/`). An unresolvable relative import fails loudly; dynamic imports are deliberately not chased because the engine loads statically. The five benchmark drivers (`tune.mjs`, `tune-evaluate.mjs`, `tune-measure.mjs`, `tasks.mjs`, `tune-gate.mjs`) stay explicit (nothing imports them into the closure). A module the engine must import to run is invalidated by construction.
- **Consequences**: Existing warm caches invalidate once (the digest value shifts), so each model pays one cold gate then re-warms — same identity semantics, strictly safer coverage. Unrelated `src/` edits (server, downloader, registry) no longer and never did invalidate; that is unchanged. Unit tests pin the closure derivation, the transitive-edit invalidation, the loud failure on a broken import, and that non-generation modules stay outside the digest. `TUNER_VERSION` stays 9: prompts, scoring and statistics are untouched.

### ADR-093: the gate measures its models concurrently through a bounded pool
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: After ADR-090/091/092 a cold gate still measured its three models strictly in sequence, so wall time was the sum of all models. The models are independent measurements (own engine, own recorded load config, own cache file), and the verdict compares per-task rates, never latency (`latencyDeltaMs` is display-only in `compareToBaseline`), so nothing in the contract requires sequence. The measured facts behind this decision: prefill is only ~16% of ask time (2,401 recorded answers), and batched parallel sequences inside one model drift answers (11/36 digests differ in a serial-vs-parallel window dogfood), so neither prefix reuse nor sequence batching is worth building; model-level concurrency is the one safe lever.
- **Decision**: `tune-gate` extracts each model's measurement (comparability check, restored cache, tripwire window, cache save) into an isolated `measureModel` and runs the models through a bounded lane pool (`benchmarks/model-pool.mjs`): results keep input order, a worker's rejection is collected and the gate aborts on the first failure in model order after every lane settles, and the width is clamped to the model count. The default width is all core models (up to 3); `--models-parallel 1` restores the strictly sequential run. Each model keeps its own serial inference path unchanged, so answers stay bit-identical; only per-item latency readings inflate under contention, and the verdict never reads them.
- **Consequences**: Cold wall time becomes the slowest model instead of the sum — measured 116 s for a fully fresh `--fresh` gate (108 fresh answers per model) versus ~4-5 min sequential, with all nine verdicts identical (+0 delta, b=0 c=0, 12-checked windows). Warm gates are unchanged. Unit tests pin the pool's concurrency bound, ordering, error propagation and width clamping. The gate driver changed, so the ADR-092 import-closure digest invalidates the answer caches exactly once per model, then they re-warm. `TUNER_VERSION` stays 9: prompts, checks, items, statistics and every sampled answer are unchanged.

### ADR-094: the answer cache keys on the answer world, not the judging harness
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The gate's answer cache (ADR-090/092/1764) reused rows only when one fingerprint covering the entire world — the model/runtime fingerprint plus a content digest of the engine import closure and all five gate drivers — matched. Any driver edit, including judge-only orchestration such as the CLI entry guards, therefore discarded every cached answer: measured evidence from this task shows a warm gate then had to re-measure its rotating tripwire window (~108 fresh answers per model, ~111 s) and lost all accumulated rung coverage, although judging code cannot change a sampled answer. Verdicts, paired stats and rung order are computed fresh from the rows on every run, so a change confined to them needs no new answers.
- **Decision**: The reuse identity splits in two. `answerDigest` covers everything that can change an answer: the engine's import closure (ADR-092) plus the answer drivers (`tune-evaluate.mjs`: prompt assembly and evaluation defaults; `tune.mjs`: the settings rows `measurePresets` composes; `tune-job.mjs`: `tuneBase` measurement defaults). The judge drivers (`tune-gate.mjs`, `tune-measure.mjs`, `tasks.mjs`) leave it: their code runs live on every gate and re-judges the same bit-identical rows. The world fingerprint (suite version, task hash — the content hash of every item — tuner version, model file and size, CPU/cores/platform/arch, node-llama-cpp) stays whole in the reuse identity, so item, suite or model edits burn exactly as before. The cache schema bumps to 2: old records are discarded, never misread, and each model re-warms once. `saveGateCache` stores the full evidence digest as `judgeDigest` for the record; it is never a reuse key.
- **Consequences**: Quality is unchanged by construction — reused rows are bit-identical answers the live judge code re-verdicts, the rotating tripwire window still measures a fresh slice every run, escalation, `--fresh` and baseline comparability are untouched. Proof: the same working tree measured a covered window twice (once untouched, once after a judge-only `tune-gate.mjs` comment edit) with 108 reused / 0 fresh per model and all nine verdicts identical; an equivalent edit to `tune-evaluate.mjs` burned the cache (0 reused / 108 fresh), as does any world change. Judge-only changes retain accumulated window coverage, so wrapped windows and escalation re-measures reuse instead of re-asking. Unit tests pin the answer/judge partition, the discrimination of both digest halves, the schema-2 discard, and that every world axis (task hash, suite version, tuner version, model file/size, runtime, hardware) burns. `TUNER_VERSION` stays 9: prompts, checks, items, statistics and every sampled answer are unchanged.

### ADR-095: context-level settings rebuild the context instead of reloading the model
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The evaluator's `ensureLoaded` treated every load key identically: any change (even `threads` or `batchSize`) paid a full model reload plus a warm-up answer. Measured on this machine (results/threads-dogfood.mjs, results/reconf-dogfood.mjs): a model load costs 987-1698 ms (1.5B: up to ~2.5 s) while `createContext` on a resident model costs 58-343 ms, so sweeps of context-level axes (threads x7, batch x6, context, KV, attention) overwhelmingly paid for the wrong half. Per-eval `threads` hints exist upstream (`SequenceEvaluateOptions.threads`), but keeping the measurement semantics of a dedicated context removes any doubt: thread counts never change answer digests either way (proven 3/3 bit-identical across threads 1/4/12 on both a shared and dedicated contexts).
- **Decision**: `LlamaEngine.reconfigure` recreates the context on the resident model: model-level keys (mmap, GPU layers, backend) stay with `load`, context-level ones (contextSize, threads, batchSize, sequences, flashAttention, kvCache, checkpoints) rebuild the context in place. It refuses mid-generation and mid-phase like load, re-runs the same memory fit verdict (`#planFit`; the resident model's bytes cancel in the estimate), writes the same state fields a load would, clears the response cache (a replayable answer would mask the latency a sweep measures), and on a failed recreate releases the model and lands in the error phase (`context_recreate_failed`), from which a fresh load recovers. `ensureLoaded` splits its signature: model change or first call -> `load` (with `maxThreads` lifted to 64 so no candidate's context threads are clipped by a previous setting); context-only change -> `reconfigure`. The warm-up stays on both paths: these are exactly the stages whose verdicts read latency (quality tie-breaks, speed ranking; #3 of the proposal round was rejected on this evidence). `load` itself now shares `#contextShape`/`#attemptContext`, so a rebuilt context always applies byte-identical options to what a fresh load would have created.
- **Consequences**: Measured live through the real evaluator: a 3-candidate threads sweep made 1 load and 2 reconfigures of ~55 ms, with stable answer digests across candidates; the full test suite passes (671 tests), and the live gate re-measured a cold answer world (engine closure digest shifts once, as designed) with all nine verdicts identical (+0, b=0 c=0). Tuning cost drops by roughly the reload share of every context-level candidate (~20-40 s per model per tune on these models). Latency readings through the reconfigure path may differ slightly from dedicated-load readings (single-shot CPU dogfood: 942 vs 836 ms at threads=1), but every candidate in a sweep is measured through the same path, so comparisons stay internally consistent. `TUNER_VERSION` stays 9: prompts, checks, items, statistics and every sampled answer are unchanged.

### ADR-096: speculative decoding is parked until the runtime can deliver it natively
- **Date**: 2026-11-12
- **Status**: Rejected by measurement (implementation reverted; re-open when node-llama-cpp ships native batch-style speculation)
- **Context**: Decode is ~84% of ask time (ADR-093's 2,401 recorded answers), making speculative decoding the last order-of-magnitude speed lever from the proposal round. Feasibility was verified up front: node-llama-cpp 3.22.2 exports `DraftSequenceTokenPredictor` (per-sequence predictor, `validated`/`refuted` counters, `minTokens`/`maxTokens`/`minConfidence`), and every installed Qwen GGUF shares tokenizer hash `e2fadeac783c` (151,936 tokens), so 0.5B drafts can draft the 1.5B targets. A full implementation landed through milestones (engine `draftModel` load option with draft model+context lifecycle, per-sequence predictor pairing with explicit draft-pool release, profile/base/evaluator wiring, `MODEL_LEVEL_KEY` reload semantics): bit-identity was proven live on both model pairs and both lanes — greedy and temp-0.7 seeded answers were byte-identical with the draft on (by construction: the target samples every token and consumes a prediction only when its own sample equals it, read from the runtime's own validation code; the engine had no need of that guarantee).
- **Decision**: Remove the implementation before delivery (the feature never shipped: origin/master never saw it). The measured reason: on this machine the predictions never engage — 0 validated / 0 refuted in every configuration (library defaults, `minTokens` 6/16, `minConfidence` 0, CPU and Vulkan lanes, both model pairs), while the target pays abort/alignment overhead per token: 169 t/s without the draft versus 51-71 t/s with it on the GPU (2.4-3.3x slower), and 25 t/s versus 17-27 t/s on the CPU. node-llama-cpp 3.22.2's drafting is JS-orchestrated (async iterators, per-step alignment between target and draft contexts), not native batch speculation, so the target commits each token before a draft prediction lands; the library's own CLI shows the same `Validated: 0 / Refuted: 0 / Used: 0` with the same models, proving the limitation upstream, not in our wiring. Two reuse conditions for a future attempt: a runtime release whose change log claims native/speculative batch validation, or a probe dogfood that shows non-zero acceptance on this rig.
- **Consequences**: The tree returns to the ADR-095 state: no `draftModel` setting exists anywhere, the suite is back to 671 tests, and the answer-cache world (engine import closure) is unchanged after the revert, so warm gate caches stay valid. The gated evidence stays machine-local and gitignored in `benchmarks/results/`: `spec-dogfood.mjs` (two-pair, two-lane bit-identity and acceptance dogfood), `spec-probe.mjs` (the predictor-lifecycle trace and the configuration matrix), plus the CLI reproduction command (`npx node-llama-cpp chat --model qwen2.5-1.5b-instruct-q4_k_m.gguf --draftModel qwen2.5-0.5b-instruct-q4_k_m.gguf --gpu max`, meter output `Validated: 0 Refuted: 0`). Two engineering findings survive the revert for the future attempt: (1) the runtime marks a sequence disposed only after its async dispose aggregator completes, so draft-pool claims must explicitly release pairs at the engine's own dispose sites and wait like the main pool — a bare `.disposed` reconciliation loses the race (this class of bug was caught live by the dogfood); (2) serialization: the predictor must be constructed per target sequence and disposed with it (the runtime's own contract). `TUNER_VERSION` stays 9: nothing shipped, so prompts, checks, items, statistics and every sampled answer are unchanged.

### ADR-097: the unwired sampler knobs are measured out; the axes are not added
- **Date**: 2026-11-12
- **Status**: Rejected by measurement (no implementation; probes retained)
- **Context**: After ADR-096 parked speculative decoding, the remaining proposal round suggested adding sampler axes the runtime offers but the app does not wire: `repeatPenalty.frequencyPenalty` and `repeatPenalty.presencePenalty`, a DRY window (`dryRepeatPenalty.lastTokens`), and XTC. Verification ran three layers: the native boundary (all four knobs flow through `_resolveSamplerConfig` into `AddonTypes` config fields), a synthetic broken-record probe on qwen2.5-coder-0.5b, and a real-suite headroom probe (suite `SYSTEM_PROMPT` and `evaluateResponse`) on both the failing qwen2.5-0.5b code lane and the ceiling qwen2.5-1.5b lane.
- **Decision**: Do not add the axes. Measured facts: (1) the knobs engage exactly as documented - frequency 0.4 breaks a broken-record loop (count-proportional), presence needs >=5 on greedy (flat penalty against argmax margins), XTC engages even at temperature 0 (verified: greedy output changes, so it is not quality-safe for the temp-0 code lane); (2) DRY only activates with an explicit positive `lastTokens` window in node-llama-cpp 3.22.2 - the resolver sends `-1` for the implicit default and the native sampler then is a silent no-op, a latent trap documented here (the app's dryBlock never passes a window, so any future `dryStrength > 0` setting would be silently inert until wired); (3) and decisive: there is no real-suite headroom - the failing 0.5B code lane tunes its repeat block to OFF and every moderated penalty is neutral while strong ones cost checks (38/41 baseline; multiplier 1.15 -> 34/41; freq 0.8 -> 34/41), the comprehension and recall lanes produce 1-2 token answers with no repetition exposure, and the 1.5B lane sits at its ceiling (35/35). The suite's measured failures are capability failures, not sampling failures.
- **Consequences**: No tuning surface is added, so every future sweep costs exactly what it costs today. The probes stay machine-local and gitignored in `benchmarks/results/sampler-probe*.mjs` as the evidence record, with the reproduction prompt ("The duck said quack." pattern) showing knob engagement and the suite probe showing the null headroom. Quality leverage therefore moves to measurement precision (the judge half, ADR-094) and to capability levers (models, suite items); a future re-open trigger for these axes would be suite items with demonstrated repetition-driven failures or a changed suite shape. `TUNER_VERSION` stays 9: nothing shipped.

### ADR-098: the gate's paired alpha concentrates on the loss side at four real digits
- **Date**: 2026-11-12
- **Context**: ADR-094 split the gate's judge half from the reused answer world so judge-only changes re-judge cached answers in minutes. The judge audit found two defects while verifying where its alpha actually goes: (1) `compareToBaseline` asked the two-sided `mcnemarExact` for a strictly directional decision - the gate only fails when losses (b) outnumber fixes (c) - so every row spent half its alpha on a gain tail that can never fire, and under the 9-row Holm family a uniform regression needed roughly ~9 losses to gate instead of ~5 (b=5, c=0 reads two-sided p=0.0625 and escapes; one-sided p=0.03125 fires); (2) the rate rounder `round(value)` ignored its digit argument, so every p-value and Holm-adjusted p collapsed to one decimal on the evidence path (0.03125 displayed as 0), hiding exactly the digits the decision is made on.
- **Decision**: The paired gate path (`tune-baseline.mjs`) now reports the one-sided exact loss tail `mcnemarOneSided(b, c)` = P(fixes <= c | Bin(b+c, 0.5)), rounded to four real digits by a local `round4`; rates stay display-rounded at one decimal. `mcnemarExact` stays for the bench sign tests, which are genuinely two-sided. The tune.mjs guard's `worse:` flag shares the two-sided test and the digit-ignoring rounder, but tune.mjs is answer-side (ANSWER_DRIVER_FILES, ADR-094): changing it changes tuning decisions and burns the answer cache, so it is documented here as follow-up doctrine, deliberately not changed in this calibration. `TUNER_VERSION` stays 9: the gate ran live through the new judge with all nine rows byte-identical to the previous passing run (b=0, c=0, p=1 everywhere), proving no verdict semantics drifted.
- **Consequences**: The gate's paired alpha now concentrates on the only direction it acts on, halving the uniform-loss count needed to fire under the 9-row Holm family, and the p evidence carries real digits. The live verification burned the answer cache for an expected reason worth recording: the last save predated the ADR-095 engine rebuild (78de93f, in the answer digest universe), so this run re-measured everything and re-established the cache at the current fingerprint - the next judge-only gate reuses it. Future one-sided pValues read as loss-tail probabilities, so `p=0.5` on a b=c row means "a fair coin explains this", not "not significant in both directions"; consumers of history.jsonl rows should read `pValue` against that meaning (IDEA-1787).

### ADR-099: the model tier-up lever is measured out on suite v17
- **Date**: 2026-11-12
- **Status**: Rejected by measurement (informational flash probes; run records committed in history.jsonl)
- **Context**: With ADR-096 (speculative decoding) and ADR-097 (sampler axes) measured out, the remaining capability lever proposed was a tier-up model on the failing lanes. Verified inventory: Llama-3.2-3B-Instruct-Q4_K_M (2.0 GB) and Phi-3.5-mini-instruct-Q4_K_M (2.4 GB) are both installed. Apparent October evidence (Llama 21/21 twice on the smoke set) was stale: those runs were suite v3/v4 with 21 checks and untuned CPU settings, and the stale profiles sit at suiteVersion 8 versus the current 17.
- **Decision**: Do not promote a tier-up model. Same-suite comparison on the 16-item v17 smoke set (informational `--flash` runs, untuned CPU, identical settings): Llama-3.2-3B Q4 scored 93.3% checks / 15/16 items at 19.3 tok/s (1606 ms first token, 4013 MB host) while the fleet's qwen2.5-coder-1.5b Q4 scored 96.7% checks / 15/16 items at 36.0 tok/s (538 ms, 1839 MB). The tier-up clears nothing the fleet model does not already pass; its only edge (recall 100% vs 67%) rests on 3 items with fully overlapping confidence intervals (43.9-100% vs 20.8-93.9%). Vulkan could roughly double the tier-up's speed but cannot beat its own 93.3% quality signal, and Vulkan rounding changes answers (the device ADR), so the expensive half of the probe is not worth running.
- **Consequences**: No fleet, baseline or catalog change; nothing shipped, so TUNER_VERSION stays 9 and the answer world is untouched. The remaining known quality lever is the batched suite revision (fixed paraphrase pools, the tune.mjs one-sided guard follow-up of ADR-098, extra items on the failing qwen2.5-0.5b code lane), which should ride the next real suite change and pay its single re-baseline deliberately. A future re-open trigger for the model lever: a suite revision that adds genuinely hard capability items the 1.5B fleet demonstrably fails and a tier-up demonstrably passes, measured head-to-head on the same suite version.

### ADR-100: paraphrase probes hold out against phrasing-overfit; the search guard matches the gate's calibration
- **Date**: 2026-11-13
- **Status**: Accepted (implemented; full re-tune + re-baseline + live gate verified)
- **Context**: With every runtime lever measured out (ADR-096/097/099), the one verified residual was evaluation-side: nothing measured whether a tuned preset generalizes past the suite's single authoring voice, and the search's `worse:` guard used two-sided tests for a strictly directional decision (two-sided p=0.0625 let five uniform losses escape; the earlier round's claim that tune.mjs's rounding collapsed p to one decimal was wrong - its round honors digits, the defect was purely directional). The batch economics forced one combined re-baseline: paraphrase items (answer world, taskHash) and the guard port (search decisions, TUNER_VERSION) each alone cost a full re-tune of all three models.
- **Decision**: Suite v18 adds twelve fixed paraphrase probes - two per 1/2/3-sentence stratum on the code and comprehension lanes, each mirroring a base item's checked contract verbatim behind reworded requests - routed wholly into the holdout (`split()` excludes `paraphrase`-flagged items from the search, adds them to `held`), so every tune's held-back check reads them as phrasing-unseen evidence. The gate asks them informationally per model after the paired verdict (printed and stored in latest-tune-gate.json, never in the Holm family). Tuner v10 ports the gate's ADR-098 calibration into the search: `groupEvidence` asks `mcnemarOneSided` on the plain path and the new `signFlipOneSided` permutation tail on the clustered path, both exported for failing-first tests. All three models re-tuned and re-baselined deliberately (`--update-baseline --from-profile`); revert safety was snapshotted first (`~/.modelduck/snapshots/before-suite-v18`). One analysis lesson is recorded so it is never repeated: gate rows on tripwire runs read window rates (12 items), so quality verdicts must compare full-lane item outcomes from baseline stores, not row "baselineRate" text - a window-vs-lane mix manufactured a false regression alarm mid-verification.
- **Consequences**: The revert-if-worse criterion was checked like-for-like on full-lane item outcomes: no lane regressed beyond tolerance (worst: coder code -6.2pp, inside 8.3pp; recall lanes improved up to +13pp, smollm recall +13.0), so the v18 world stands, and the live gate passed with all nine paired rows identical. The probes immediately earned their keep: coder-1.5b comprehension holds 83.3% on the lane but only **61.1%** on paraphrased asks (-22.1pp), and qwen2.5-0.5b shows 50% vs **33.3%** - the first measured evidence that tuned presets leak the suite's fixed phrasing - while every model's paraphrased code asks hold at 66.7-100%. These baselines travel with the fleet: future preset changes are auditable against phrasing-unseen evidence. The comprehension phrasing gap is now the standing watch item; the re-open trigger for attacking it is a prompt-axis candidate that closes the paraphrase gap without losing lane rate. Gate answer caches start cold under the new identity (judge-only gates re-measure once, then reuse).

### ADR-101: Opt-in parallel answers behind a safety-and-speed probe
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit 2bc18e2)
- **Context**: The tuner answered one item at a time. `createEvaluator` already supported several sequences, but batching can change floating-point order, so answers might differ from serial ones, and on a CPU a small model may gain nothing.
- **Decision**: `--parallel <2-4|auto>` runs the untimed stages wide only after a probe answers a few greedy items wide and one at a time. The wide pass must give byte-identical answers and take at least 15% less wall time; otherwise the tune says why and runs serially. Each call's width is the largest one whose slot (context / width, 16K floor) holds its largest item. Answers carry their width, and `cachedAnswers` reuses only rows of the tune's own width (untagged = serial). Timed stages stay serial. A per-phase wall-clock line (`Time …`) is recorded on every run.
- **Consequences**: Default tunes are unchanged. Measured on the i5-14400F under load, the probe refused both times as intended: Qwen2.5 0.5B gave 4/4 identical answers but ran 16.7 s wide against 15.6 s, and SmolLM2 changed 1 of 4 answers at width 2. Parallel stays opt-in until a machine shows a probe pass.

### ADR-102: Time-boxed tunes and a narrowed scan per tune process
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit c39aa6c)
- **Context**: Every tune process spent 8.1 s reading GGUF metadata for all 16 installed models. A quick pass starts up to three processes per model, and the gate starts one per model. Users could cap answers but not time.
- **Decision**: `registry.scan({ only })` reads metadata only for accepted files, and a narrowed scan is never served as the full listing; `openTarget` scans just the requested model. `--budget <minutes>` (and **Minutes per model** in the app) sets a deadline that counts the model load. Measurements stop asking at the deadline, and items are asked four at a time under a deadline so the stop lands within a few answers. The best settings so far are saved and `--continue` finishes the rest. The scheduler passes each process the minutes its model has left. A quick pass that uses up its time keeps its preset provisional and skips the full continue.
- **Consequences**: Opening a target went from 8.1 s to 0.8 s. A 0.5-minute budget ended at 31 s instead of a rung later (56 s). Unbudgeted tunes ask items in one call, as before.

### ADR-103: Shipped presets apply on a click, matched by model file and machine
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit d5089b0)
- **Context**: `benchmarks/presets` held measured recipes that users could only import by hand. G-004 forbids applying presets automatically.
- **Decision**: `GET /api/presets` lists each shipped preset with its receipt and fit, and `POST /api/presets/apply` (loopback only) applies one when the user clicks **Apply**. The model file must match by name and size. On the same machine (cpu, cores, platform, arch) the whole recipe applies (`exact`). Elsewhere only the sampling and prompt presets apply (`portable`); load settings stay at the defaults until Device and Speed are measured there. An applied preset is an imported profile marked `search.preset`, never counts as tuned here, and never replaces a profile tuned on this computer without confirmation (`preset_would_replace_tune`).
- **Consequences**: A user can serve measured settings in seconds. The shipped recipes still predate suite v18 and tuner v10, so they load with stale warnings until re-measured on the source machine.

### ADR-104: Opt-in multistep chains outside the tuned suite
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit ed1d937)
- **Context**: Every suite item is single-turn, so no measurement saw a model that solves a request and then breaks or forgets it on the next one. Adding items to `PROMPTS` or `TASKS` would change the test hash, the task-subset hash, profiles and baselines.
- **Decision**: `benchmarks/multistep-items.mjs` holds 5 chains × 3 steps (59 checks), versioned by `MULTISTEP_VERSION` and `multistepHash`, outside `PROMPTS` and `TASKS`. `npm run bench:multistep` runs each chain as one conversation and scores each step with the earlier replies' code loaded. Tests prove every reference solves its step, every behaviour-changing step fails the previous answer, and every step that builds on earlier code fails without it. The suite route and the Bench page describe the chains beside the tasks.
- **Consequences**: No gated identity changed. With tuned code presets, seed 42: Coder 1.5B scored 47/59 (82/84/72% by step) and Qwen 0.5B 17/59 (50/16/17%). One seed is a demo, not a claim.

### ADR-105: Settings tuning for code is saturated; escalation, failure classes and the model guide record why
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commits 574695e, 8258706, fd563f0)
- **Context**: The code search decides on small rungs (20 items for Coder 1.5B and 16 for Qwen 0.5B, once saturated items are left out), so leads of 5-20 points appear by chance and the Holm gate rightly rejects them. Whether real gains were being thrown away was unknown.
- **Decision**: Opt-in `--escalate` retests an unproven rung leader alone on the unused pool items, and it stands only on a one-sided paired win there. Every answer row carries a failure class (`truncated`, `empty`, `unreadable`, `timeout`, `crash`, `threw`, `wrong`, `error`), and a tune prints why its answers failed. `npm run bench:repair` measures test feedback (`chat`, `fresh`) against plain retry (`retry`).
- **Consequences**: No escalated leader held. Coder 1.5B T=1 led 58.3% vs 45% on the rung and lost 57.2% vs 63.0% on 81 fresh items; Qwen 0.5B's best prompt tied 29.4% on 85. Greedy decoding with the default prompt is the best of the search space, and `TUNER_VERSION` stays 10. 78% of failing code answers are wrong logic. Precision above Q4_K_M added nothing (Coder 1.5B 60.6% at Q4_K_M and F16), while model choice did (Phi-3.5 Mini 50.0%, p=0.007 worse). Feedback text added nothing over retrying. In chat the model resent its own code in 72-81% of repairs, and two retry seeds rescued mostly different items. Test-checked retries are the lever: 60.4% → 73.1% in four tries.

### ADR-106: Verified code by test-checked retries, local only
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit 3518085)
- **Context**: ADR-105 found test-checked retries the only remaining coding lever, but serving had no way to use them.
- **Decision**: `POST /api/code/verify` takes a prompt or messages and tests `{ entry, cases, setup? }`. The loaded model answers with its tuned code preset, the tests run in the `node --permission` sandbox, and failed answers get new tries in a new conversation at `retry_temperature` 0.7 with a new seed, up to `attempts` (default 4, max 8). The route returns the first passing answer, or the try that passed the most cases with `passed: false`. It runs caller-supplied code, so it answers loopback only even with LAN serving and keys on. Input is capped at a 256 KB body, 50 cases, 8 tries and 64 KB of setup; `entry` must be one identifier, and the free-form `harness` field is refused.
- **Consequences**: Clients with tests get measurably better code, and `/v1/chat/completions` is unchanged. Live on Coder 1.5B, three of five first-answer failures passed on try 2 or 3 in under a second each. The threat model records the new code-running surface.

### ADR-107: Untuned generation uses half the logical cores
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit fd516fe)
- **Context**: The default thread count was logical cores - 1 (15 on the i5-14400F's 16 logical, 10 physical cores). With threads on every logical core, they contend for the physical ones.
- **Decision**: `defaultGenerationThreads()` = floor(logical / 2), capped at 64, is the `threads` default. The thread-pool cap (`maxThreads`) and the benchmark tools keep `defaultThreads()`, so no bench hash changes. A saved `threads` value and a tuned Speed stage still win.
- **Consequences**: CPU only on the i5-14400F: Coder 1.5B rose from 3.9 to 28.8 tok/s, and Qwen 0.5B from 47.7 to 83.7. The gate passed on fresh answers at the new default with all nine rows unchanged. Users who saved `threads` earlier keep their value. Other CPUs are unmeasured; the Speed stage remains the per-machine answer.
### ADR-108: The test sandbox cannot be forged and names its Node limits
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commit 0d1e89f)
- **Context**: Review of the unpushed work found an answer could print the harness's result marker and score 2/2 without solving anything, the sandbox inherited the server's environment, `--permission` is an unknown flag before Node 22.13/23.5, and the permission model denies the network only from Node 25.
- **Decision**: `benchmarks/sandbox.mjs` picks `--experimental-permission` or `--permission` by Node version and gives the child a neutral environment (Windows variables libuv refills are set to placeholder values; `SystemRoot` is kept). The judge script goes through stdin with a per-run random marker, captures `writeSync` and `JSON.stringify` before the answer runs, pre-serializes expected values and calls the entry in strict mode. Comparison semantics are unchanged; a `vm` context was rejected because it would change scores for answers that use `require` or `module`. `POST /api/code/verify` answers 503 `verify_sandbox_weak` on Node below 25, while tuning and benchmarks keep working on Node 20+.
- **Consequences**: 800 saved answers re-judged identically and `tune:gate` passed 9/9 with no changed items. Verified code needs Node 25+.
### ADR-109: Verified code stops on disconnect, deadline or a busy engine
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; Task A milestone 2)
- **Context**: `/api/code/verify` kept generating after the client left, had no limit for the whole request, threw away earlier tries when another reply took the engine, crashed with a 500 on a `null` body, and accepted `retry_temperature` 0, where every retry repeats the first answer. ADR-105 and ADR-106 also credited 73.1% to four tries; the repair bench measured 70.9% for 4 answers and 73.1% for 5 (4 retries).
- **Decision**: `runVerified` takes the caller's `signal` (the route aborts it on `res` close), a 5-minute `deadlineMs` with an injectable clock, and returns the best try so far with `stopped: "client_closed" | "deadline" | "engine_busy"`. A busy engine before the first try is still an error. Each attempt records `aborted`. Non-object bodies are 400 `verify_invalid`, and `retry_temperature` must be above 0. The default stays 4 tries; the docs now say 70.9% for it. This corrects the figures in ADR-105 and ADR-106 without editing them.
- **Consequences**: Generation path and suite are unchanged, so no gate run is needed. A disconnected client frees the model within one answer.
### ADR-110: Per-model budgets count a model's own processes; toasts live in the top layer
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; commits 37d0177, d0e554a)
- **Context**: The scheduler measured a model's budget from its first process, so waiting for other models and paused time counted, a new tune inherited the old start, and a process still spawned with no time left. In the app, an invalid Minutes per model value silently meant no limit, and review screenshots showed that no toast was visible while a modal dialog was open.
- **Decision**: Each queue item adds the wall time of its own tune processes to `budgetUsedMs`; minutes left are the budget minus that, nothing starts at zero, and a `timeExhausted` completion marks the item provisional. The app refuses an invalid budget with an error. `#toast-root` is a manual popover, re-shown per toast and moved into the topmost modal dialog while one is open (outside it the page is inert), then back to the page on close.
- **Consequences**: Budgets mean minutes of tuning per model, as documented. Errors raised inside any dialog are visible and dismissible; `ui:smoke` checks this, checks the budget error, and fails on unexpected error toasts.
### ADR-111: Halve the default threads only where SMT is present or cannot be ruled out
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; Task B milestone 2)
- **Context**: ADR-107 set the untuned `threads` to half the logical cores from one measurement on an SMT CPU (i5-14400F). On a CPU without SMT (Apple Silicon, ARM, x86 parts without Hyper-Threading), half the logical cores is half the physical cores, an unmeasured likely regression.
- **Decision**: `hasSmt()` returns false on ARM, reads `siblings` against `cpu cores` from `/proc/cpuinfo` on Linux, and assumes SMT elsewhere, because Windows and Intel macOS have no source that does not need a subprocess. With SMT the default stays floor(logical / 2); without it, logical - 1 as before ADR-107. This amends ADR-107 without editing it.
- **Consequences**: On this machine the default stays 8, and `tune:gate` passed 9/9 on 252 fresh answers (b=0 c=0). Non-SMT x86 Windows machines are still halved; their Speed stage picks the right count.
### ADR-112: Escalated settings are marked per task, not in the fingerprint
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; Task B milestone 5)
- **Context**: The review asked to record `--escalate` in profile identity. The fingerprint describes the machine, runtime, suite and tuner; every comparison takes "now" from the environment, which knows nothing of a past flag, so an escalate key there would mark every escalated profile stale. The flag was already saved in `search.options.escalate` and each sweep's `escalation` record, but a reader had to scan the sweeps to see which settings it decided.
- **Decision**: `profileFromTune` adds `tasks.<task>.escalated`, the axes whose change stood through escalation and survived the confirmation after it. Profiles from default tunes are unchanged. The escalation record's `b`/`c` were checked and are not swapped: they use the gate's incumbent → challenger convention (b = the challenger's losses); a comment now says so.
- **Consequences**: An escalated preset is auditable from its task entry; the gate still re-measures it like any other. A narrowed registry scan (tune processes) no longer clears other models' header cache or prunes their sampling overrides; only a full scan prunes.
### ADR-113: The settings perf scripts are kept, fixed and described as what they are
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; follow-ups task milestone 2)
- **Context**: Review finding 23: `settings-perf.mjs` and `multi-step-perf.mjs` recorded milliseconds that `stats-util.mjs` formats as seconds (1000x too large), throughput was `count / mean` instead of `1 / mean`, both ran `main()` on import, `ai-benchmark-advisor.mjs` could not be imported at all (duplicate export) and imported names that did not exist, and its README described fixed thresholds as "AI-powered". The user did not choose between fixing and deleting; fixing is the reversible choice.
- **Decision**: `stats-util.runBenchmark` is the one timing loop: it stores seconds, takes an injectable clock, and throughput is calls / total time. Both scripts use it, export their workflows and `main`, run only when started directly, and have `npm run perf:settings` and `perf:multistep`. The advisor is `benchmark-advisor.mjs` exporting `BenchmarkAdvisor`, its broken demo helper removed; `PERF.md` replaces `AI-BENCHMARK-README.md` and says no model is involved.
- **Consequences**: Printed times are right (fenceSettingsPatch 1.0 µs, settings lifecycle 11.7 ms on the i5-14400F) and the advisor's second-based thresholds now judge them correctly. `tests/perf-scripts.test.js` covers units, throughput, side-effect-free imports and the advisor. Deleting the scripts remains an option if they stay unused.
### ADR-114: The settings version fence refuses what it cannot read; state files may carry a BOM
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; follow-ups task D milestone 1)
- **Context**: The IDEA-1097 fence skipped any `version` that was not a number, so `"2"` or `1.5` loaded as if current, and a newer file failed with a plain `Error` that startup printed without Why/Fix. Checking the refusal end to end showed a second gap: a state file saved with a UTF-8 byte-order mark (Windows PowerShell 5, older Notepad) failed `JSON.parse`, was quarantined, and the app started on defaults.
- **Decision**: No version still loads (files from before the fence). A whole number, or one written as a numeric string, up to `SETTINGS_VERSION` loads. Anything else, and any newer version, is an `AppError` `settings_version_unsupported` with Why and Fix, raised before the file is used, so it is never rewritten. `readJsonWithQuarantine` strips a leading BOM before parsing the file and its backup.
- **Consequences**: A damaged or future settings file stops startup with the file name and what to do; hand-edited state files saved by Windows tools are read instead of reset.
### ADR-115: The judge compares in the parent; the child prints raw results
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; review-fixes-e milestone 1). Supersedes the "cannot forge" claim of ADR-108.
- **Context**: An independent review of the ADR-108 hardening reproduced a forged pass: the answer shares a process with the judge, reads the script from `process._eval`, recovers the per-run id and prints a result line on exit, and the parent took the last marker. A per-run secret held in memory the answer can read is not a secret. The same review showed `process.kill` reaching a live host process, `os.userInfo()`, `os.hostname()` and `process.cwd()` returning real values, and a 600 MB Buffer allocation passing under `--max-old-space-size=256`.
- **Decision**: The child script gets only the arguments and prints `[kind, text]` per case (value JSON, undefined, thrown message, no function). The parent compares with the expected values, which never enter the child. A forging answer can only choose what the function "returned", without knowing what passes. Honest answers score the same: 3,791 of 3,792 distinct saved answers re-judge identically, and the one difference is a stored answer that calls `Math.random()`. The child also starts in the temp drive's root, is killed with SIGKILL, and runs a prelude that deletes `process.kill` and replaces the user and host names. These are an information scrub and a speed bump, not a boundary, and the docs say so; the heap cap is documented as bounding JavaScript objects only.
- **Consequences**: Score forgery is closed by construction, not by a secret. OS-level isolation (a separate user, container or job object with a memory limit) remains the only real fix for hostile code and is not in this change. `tune:gate` passed 9/9 (b=0 c=0) on the new judge; the gate cache digest covers `suite.mjs`, so answers were measured fresh.
### ADR-116: A budget-cancelled stage is skipped; the toast popover keeps the redesign's placement
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; review-fixes-e milestones 2-3)
- **Context**: The review of the fix commits found that a model whose time budget was spent before a stage was marked `done` although nothing ran (my ADR-110 test even asserted `done`), that `restore()` reset `provisional` for every item so a time-boxed model lost its label on restart, and that `.toast-root[popover]` in `styles.css` had higher specificity than `redesign.css`, so toasts sat at 18px instead of 24px and the phone layout lost its inset.
- **Decision**: The scheduler sets `status: "skipped"` with `skippedFor: "budget"` for a stage the budget cancelled; the queue already counts `skipped` as finished and the log says why. `restore()` keeps `provisional` for a finished item and clears it for one that must run again; `budgetUsedMs` already survives a restart. The "no process starts once a model's budget is spent" test now asserts `skipped` instead of `done`, a more specific status rather than a weaker check. The popover reset is `:where(.toast-root[popover])` (zero specificity) so it only undoes the browser's popover defaults and every placement rule wins; `ui:smoke` measures the desktop and 390px corners.
- **Consequences**: A queue no longer reads as tuned when the budget cancelled the work, and the toast layout matches the redesign again.
### ADR-117: The result line is framed by two markers and the output limit follows the expected values
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; reforge-fixes-f milestone 1). Amends ADR-115.
- **Context**: Reforge run-1 found two ways an honest answer was scored as not run. The parent parsed everything after the marker, so a correct function that logs from a `process.on('exit')` handler left trailing text and scored 0 ("no results"). And since ADR-115 the child prints every case's full JSON result, passing or not, against a 1 MB `maxBuffer`, so two correct 600 KB results both reported "did not run".
- **Decision**: The child closes its result line with the same marker, and the parent reads the text between the last two markers, so later output is ignored. The output limit is 1 MB plus twice the serialized length of the expected values (a correct result is at most about twice its expected JSON, because the child stringifies a JSON string), capped at 8 MB; on the verify route the 256 KB body cap keeps it near 1.5 MB. An overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) is reported as "output too large". Forgery stays closed as in ADR-115: the expected values never enter the child, so a forged line can only say what the function "returned".
- **Consequences**: A correct answer is no longer zeroed by output around the result. All 3,792 distinct saved tune answers with a `jsTests` check score identically under the old and the new judge, judged in the same run; `tune:gate` is recorded with the commit.
### ADR-118: The escalated label follows each setting's last writer and its final value
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; reforge-fixes-f milestone 2). Amends ADR-112.
- **Context**: ADR-112 listed an axis under `tasks.<task>.escalated` when any changed sweep of that axis had been escalation-confirmed. Reforge run-1 reproduced a stale label: an escalated win in pass 1 followed by a plain change to the same setting in pass 2 still produced `escalated: ["level"]`. A sweep's `axis` is a name, not a setting key (pair axes write two keys, different axes can write the same key), so per-axis bookkeeping cannot be right.
- **Decision**: Over the task's sweep log, in order, each key of a changed sweep's `winner` patch is owned by the last sweep that wrote it. An owning sweep is listed only if its escalation was confirmed and its value for that key still equals the task's final setting (a later shared-stage revert can put it back). The field stays absent for default tunes. Escalation only runs in the per-task sampling and prompt stages, so the existing per-task filter is correct.
- **Consequences**: The label describes the settings a reader would otherwise trust as gate-proven. The field exists only on this branch and nothing reads it, so no profile needs migrating.
### ADR-119: The --parallel probe stops when its verdict is known or the budget is spent
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; reforge-fixes-f milestone 5). Amends ADR-101 (the probe) and the 8-item probe added in this branch.
- **Context**: Reforge run-1 found that the stronger probe (up to 8 items, greedy and sampled, each at both widths) answers 32 items before the tune starts, four times the earlier cost, and cannot be cut short: a greedy mismatch still ran the sampled pass, and a `--budget` the probe itself used up was noticed only afterwards. One test also asserted a constant against its own literal.
- **Decision**: `probeParallel` returns as soon as a pass mismatches, so the sampled pass is skipped when the greedy one already refused, and counts only the items compared. It asks an `expired()` callback before every pass; `runTune` passes `Date.now() >= deadline` (the budget deadline is defined before the probe), and the refusal names the time budget. The constant-equals-itself test is replaced by tests for the early exit and the budget stop.
- **Measured, first time on a real model** (temporary `--home`, models folder read-only, nothing saved to `~/.modelduck`): Qwen2.5 0.5B Q4_K_M on Vulkan, `--parallel 2`. The answers were identical in both passes, but the wide passes took 15.7 s against 15.8 s serial, so the width was refused (needs 15% less). The probe cost about 31 s of a 71 s `--quick --budget 3` quality stage. This matches the earlier hand measurement (16.7 s against 15.6 s) on a different path.
- **Consequences**: A refused probe costs half as much when it fails on the first pass, and a tight `--budget` no longer pays a full probe. On this machine and model `--parallel` gives no gain; it is still untested on a larger model or a CPU-only run.
### ADR-120: macOS decides SMT from the CPU model, so Rosetta is not halved
- **Date**: 2026-11-14
- **Status**: Accepted, partly unverified (implemented; reforge-fixes-f milestone 4). Amends ADR-111.
- **Context**: ADR-111 assumed SMT everywhere except ARM and Linux CPUs whose `/proc/cpuinfo` says otherwise. Reforge run-1 pointed out that x64 Node running under Rosetta 2 on an Apple Silicon Mac reports `arch` x64 on `darwin`, so an 8-core M-series chip would get 4 generation threads, the case the ARM branch exists to avoid.
- **Decision**: On `darwin`, `hasSmt` reads `os.cpus()[0].model` (injectable as `model` for tests) and returns false when it contains "Apple"; an empty or missing name keeps the SMT assumption, and Intel Macs, which do have Hyper-Threading, keep it. Windows is unchanged: it has no source for physical cores without a subprocess, and the comment says so.
- **Not verified**: there is no Mac here. The decision rests on the expectation that Rosetta reports a model such as `VirtualApple @ 2.50GHz`. If it does not, the behaviour is the old one (halved), so the change cannot make things worse than ADR-111; anyone with an Apple Silicon Mac can check with `node -e "console.log(require('os').cpus()[0].model, process.arch)"` under an x64 Node.
- **Consequences**: Apple Silicon is no longer halved when Node is x64 and the model string says Apple. On this machine the default stays 8 threads and `tune:gate` passed with all rows unchanged.
### ADR-121: The child writes its whole result, whatever the pipe accepts
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; reforge-fix-h). Amends ADR-117.
- **Context**: Reforge run-1 stage 9 noted that the judge's child emitted its result with one `fs.writeSync`. That was safe while the line was a few bytes. Since ADR-115 and ADR-117 it carries every case's full result, up to megabytes. On a POSIX pipe a single `writeSync` may write only part of the data, or throw `EAGAIN` when the pipe is non-blocking and full; a short write would cut off the end marker, so every case would read "no results". It could not be reproduced here: Windows pipes took 1.2 MB in one call.
- **Decision**: `SANDBOX_WRITE_ALL` in `benchmarks/sandbox.mjs` is a factory `(write, Buffer, wait) => (fd, text)` that turns the text into bytes once and loops over the count written, so a write that stops inside a multi-byte character is continued; it waits 1 ms and retries on `EAGAIN` and rethrows every other error. The judge script builds it before any answer runs with `fs.writeSync`, `Buffer`, `Atomics.wait`, `Int32Array` and `SharedArrayBuffer` captured at that moment, so an answer replacing a global cannot affect it.
- **Tested without POSIX**: the unit tests run the helper against a fake `write` that takes 2 to 4 bytes per call, throws `EAGAIN` on every other call, and fails with `EPIPE`; the existing end-to-end tests (1.2 MB of results, a 3 MB flood, exit-time output) pass through it. All 3,792 distinct saved answers score identically under the old and new judge, judged in one run, and `tune:gate` is recorded with the commit.
- **Not verified**: behaviour on a real macOS or Linux pipe, where the problem would occur. The fix follows the documented contract of `fs.writeSync` (it returns the bytes written) and of `EAGAIN`.

### ADR-122: Tuning report status measured on master; the sweep gate stays unclustered for now
- **Date**: 2026-11-14
- **Status**: Accepted (measurement and documentation only; no code changed)
- **Context**: The imported tuning report (`docs/tuning-improvement-report.md`, snapshot of `6ece836`) listed findings M6, S1, S2, S4 and S6 as open. I re-ran `docs/tuning-repro/power.mjs` against current `master` and read the code paths.
- **Decision**: Record the result in the report's status note and leave the code alone. M6 is covered (`kvConfirm` rejects a quantized KV cache that loses long-context items, tested). S2 is covered (`score()` keeps per-item seed fractions and the fractional solved count). S6 is covered (a rotating 10% of saturated items is re-admitted). S1 changed the trade-off: with tolerant halving, a value that is truly 10 points better is chosen 69.3% of the time over 12/24/48 rungs (the report measured 61.0%), and 86.5% with a fourth 96-item rung. Wrong changes when nothing differs rose from 5.0% to 8.7% (260 of 3,000 simulations, 12/24/48 rungs, `changeAlpha` 0.2). That is inside the 0.2 family-wise level the tuner is configured for, so it is not a defect. S4 is partly open: hold-out, per-task and view guards use `pairedClustered`, but the sweep's own Holm gate (`paired(...)` in `tune.mjs`, three call sites in the sweep) does not.
- **Consequences**: Making the sweep gate clustered would make a change harder to win. It alters the decision rule, so it needs a `TUNER_VERSION` bump, which marks every saved profile and both baselines stale; regenerating them means `--update-baseline`, which is not run without an explicit decision (G-003). It is deferred, not rejected. S3 (53 of 142 code items never used) is deferred for the same reason. Re-open both together under one suite and tuner version bump.

### ADR-123: Saved answers are reused across tuner versions, after a live spot-check
- **Date**: 2026-11-14
- **Status**: Accepted (implemented; answer-reuse)
- **Context**: A tuner-version bump (a decision-rule change) re-tuned every core model from scratch: about 2.9 h for the three models on Nov 13. Decision rules choose among answers but never change one. The stopped v11 SmolLM2 run proved it: all 2,125 of its answers already existed in the Nov 13 v10 run once `threads` was ignored; 2,124 had identical text and all 2,125 the same pass/fail. Reuse already existed for `--continue` (G8), but it was blocked by three things: `cachedAnswers` filtered on `tunerVersion`, its key included `threads` (v10 picked 12, v11 picked 8), and `--update-baseline` tunes in an empty temp home.
- **Decision**: (1) `cachedAnswers` filters on what an answer depends on: suite version, task hash, runtime, model file and size, CPU, platform and arch. Not the tuner version. Timed rows (`timed: true`) are reused only from the same tuner version, so a speed choice never rests on another version's clock. It reads one or several run folders. (2) `Measurements` keys a slot without `threads` when the call is untimed and every layer is on a GPU (`threadsShapeText`); timed and CPU calls keep threads in the key. (3) Before any reuse, `verifyRestore` re-asks 8 saved answers live, spread over the saved rows, every other one at half the thread count. One difference in text or pass/fail turns reuse off for the run. (4) `runTune` takes `reuseFrom`, and `tune:gate --update-baseline --reuse-from <home>` replays that home's runs.
- **Consequences**: Measured end to end on SmolLM2 in a temp home: the load, speed and code-sampling stages took 1.6 min and asked 168 answers live (mostly the timed speed stage), against about 30 min and 1,414 answers for the same point live; the chosen settings matched. A re-tune after a rule change now pays only for requests the old runs never made. The identity filters cannot see every code change that frames an answer; the spot-check is what catches one, with 8 answers, so a change that alters only a few rare answers can slip through. A one-in-2,125 text difference was seen in the measured data with no pass/fail change.

### ADR-124: A baseline update tunes in a folder that survives a killed process
- **Date**: 2026-11-15
- **Status**: Accepted (implemented; baseline-resume)
- **Context**: `tune:gate --update-baseline` tuned in a random `mkdtemp` home and removed it in `finally`. On 2026-11-14 the v11 re-baseline was killed twice (an IDE reload ended its terminal, and later a deliberate stop to fix ADR-123's restore merge). `finally` does not run on a kill, and a restart could not find the random folder, so the finished SmolLM2 tune was recovered only by copying its run files by hand into a reuse folder.
- **Decision**: A re-tuning update works in `<ModelDuck home>/gate-baseline-work` (`benchmarks/baseline-work.mjs`). `prepareBaselineWork` claims it with an `owner.json` pid and refuses while that pid is alive; it moves the runs a killed attempt left in `home/tune-runs` into `saved/` and empties `home`, so the new tune starts clean and the saturation filter sees no earlier run. `saved/` joins `reuseFrom`, so its answers are replayed under ADR-123's identity filter and live spot-check. `finishBaselineWork` removes the folder after the baseline is written. After an error the folder stays for the retry. The normal gate and `--from-profile` (which does not tune) keep the temp home.
- **Consequences**: Re-running a stopped update continues from its answers instead of starting over. The pid check is not a lock: two updates started in the same instant could both claim the folder, which the docs rule out by refusing a second update while one runs. Saved runs accumulate until an update finishes.

### ADR-125: Tuner v11 clusters the sweep gate (S4) and refills saturated rung slots (S3)
- **Date**: 2026-11-15
- **Status**: Accepted (implemented; re-baselined and gated)
- **Context**: ADR-122 left two findings of the imported tuning report open, both deferred to one tuner bump. S4: the hold-out and per-task and per-view guards used `pairedClustered`, but the sweep's own Holm gate used item-level `paired`, so several inputs of one function counted as independent witnesses. S3: `withDiscriminatingRungs` dropped saturated items from the same 48-item rung, so a model with many saturated items searched on fewer items while 53 of 142 code items were never used.
- **Decision**: (S4) In `sweep()`, the Holm gate, the chosen candidate's evidence and the recorded `p` use `pairedClustered` when `clusterOf` is known; the early-stop screen stays item-level, so it still drops hopeless values early. (S3) A saturated slot goes to the next unsaturated item of the task's stratified tuning pool, so rungs keep their sizes; `tunedOn.refilled` lists the refills and the final check keeps the original set. `TUNER_VERSION` is 11.
- **Consequences**: The baseline was regenerated with `--update-baseline --reuse-from` in 37 min (ADR-123), against 2.9 h for the v10 re-tune. Every task holds within tolerance on shared item outcomes; SmolLM2 and Qwen 0.5B keep every task setting. Coder 1.5B comprehension (79.2%) and recall keep the defaults: v10's temperature 0.7, shorter prompt and prompt repeat were item-level wins the clustered gate does not prove; recall is 52.2% to 50.0% on shared items, one item of 46, inside the 8.3-point tolerance. The live gate passed 9/9 with b=0 c=0. Saved user profiles are stale (tuner v11) and load with a warning until re-tuned; with ADR-123 a re-tune replays most answers.

### ADR-126: An MCP server gives coding agents verified code
- **Date**: 2026-11-15
- **Status**: Accepted (implemented; mcp-verified). Live-checked 2026-11-15 through a real stdio client against Qwen2.5 Coder 1.5B on Vulkan: two small tasks, four tries each in 7.7 s and 10.7 s. Neither passed (slugify best 2 of 4 tests, parseDuration 0 of 5). The judged code was read and was genuinely wrong, so the tool reports real failures; two tasks measure nothing about the pass rate, which ADR-105 measured on the suite.
- **Context**: ADR-105 measured test-checked retries as the one coding lever (Qwen2.5 Coder 1.5B: 60.4% with one answer, 73.1% with five), and ADR-106 served it as `POST /api/code/verify`. No client used it: the chat UI does not call it and OpenAI-compatible clients cannot reach it. Coding agents such as Kiro call tools over MCP.
- **Decision**: `src/mcp-server.js` (`npm run mcp [-- --port <port>]`) is a stdio MCP server with no new dependency: newline-delimited JSON-RPC 2.0 handling `initialize` (protocol 2025-06-18, 2025-03-26 or 2024-11-05), `ping`, `tools/list` and `tools/call`. Its one tool, `verified_code`, takes `prompt`, `tests` (`entry`, `cases`, optional `setup`), `attempts`, `retry_temperature` and `max_tokens`, and forwards them to the app's loopback verify route. A passing or failing answer is a tool result with the code, the tests passed and the try; an app error is a tool error carrying the app's message, Why and Fix; an app that is not running gets a Fix to start it. Requests are answered one at a time, as the app runs one verify at a time. The client waits 6 minutes, past the route's own 5-minute stop. Logs go to stderr only.
- **Consequences**: Agents get test-checked code from the local model with the app's validation, sandbox, tuned code preset and loopback rule unchanged; the threat model records that an MCP client is a caller that can make the computer run tests. Only JavaScript functions can be verified, as with the route. A ping sent during a long tool call waits for it.

### ADR-127: The Tune panel's Prompt stage is opt-in
- **Date**: 2026-11-15
- **Status**: Accepted (implemented; prompt-opt-in)
- **Context**: Under tuner v11 the prompt stage (system prompt, reasoning, prompt repetition) chose the defaults in all 9 core model-task cases of the regenerated baseline (ADR-125). It is the largest share of a tune: `expectedAnswers` gives 18,714 answers per model for all five stages and 8,412 without it (55% fewer). The sampling stage, by contrast, changed the code preset of every core model (greedy, no repeat penalty, `penalizeNewLine` off), so a speed-only default would drop a measured gain.
- **Decision**: In the Tune panel the Prompt stage is unticked by default, with a note and help text saying why; the other four stay ticked. The CLI (`npm run tune`), the API (`/api/tune/start`) and `tune:gate` keep all five stages by default, so profiles and baselines are measured as before.
- **Consequences**: A tune started from the panel asks about half the answers and keeps every setting the v11 baseline changed. A model whose best prompt differs from the default is found only when the user ticks the stage; the v10 Coder 1.5B comprehension prompt was such a case at the item level, and the clustered gate (ADR-125) did not confirm it.

### ADR-128: Shipped presets re-measured on suite v18 and tuner v11
- **Date**: 2026-11-15
- **Status**: Accepted (implemented; presets-v11)
- **Context**: The three shipped recipes in `benchmarks/presets` were measured on suite v17 and tuner v9, so **Shipped presets** showed "suite changed" and "tuner changed" warnings and their figures were history. Re-measuring had cost hours per model; with answer reuse (ADR-123) it replays most answers.
- **Decision**: Re-tune the three core profiles with `npm run tune -- --model <id> --force` on tuner v11 (the user's previous profiles were copied to `~/.modelduck/snapshots/before-tuner-v11` first), export each with `profileRecipe()` and replace the shipped files. The presets README gives the current per-task rates and held-back rates in one table and keeps the suite-v17 Coder analysis under a History heading.
- **Consequences**: The three core models took about 1.5 h together (00:33 to 02:08), mostly replayed answers. Every code preset is greedy with no repeat penalty and every task keeps the default system prompt. The rates are not comparable with the suite-v17 history. Held-back rates differ from rung rates by up to 15.6 points (Coder 1.5B comprehension 79.2% against 63.6%), so a single preset's rate on its own tuning items overstates what it does on unseen ones.

### ADR-129: Catalog recommendations rank by the shipped presets' measured rates
- **Date**: 2026-11-15
- **Status**: Accepted (implemented; recommend-measured)
- **Context**: **Recommended for this PC** ranked installed models by what they measured here, but models that are not installed only by a hand-set `recommended` flag and then size. Qwen2.5 Coder 1.5B, the best measured code model (54.2% on the v11 recipe), carries no flag, so a new user asking for a code model was pointed at two general models first.
- **Decision**: `recommendCatalog` takes `measured` (catalog id to `{ rate, items, measuredOn }`) and ranks models with a rate first, by that rate, then by the old order. `/api/recommendations` builds it from `benchmarks/presets` for the requested task; a missing or unreadable folder means no evidence. Each catalog row returns `measuredRate`, `measuredItems`, `measuredOn` and a `why`. The table shows the rate as "54.2% elsewhere" and its note says it was measured on another machine.
- **Consequences**: With the shipped recipes, a fresh install lists Coder 1.5B, Qwen 0.5B and SmolLM2 in measured order for code. The rate comes from one reference machine (i5-14400F with an RX 9060 XT) and is labelled as such, never as this PC's. Only models with a shipped recipe gain evidence; the hand-set flag still orders the rest.

### ADR-130: The paraphrase watch item closed with tuner v11; six probes cannot power a prompt search
- **Date**: 2026-11-15
- **Status**: Accepted (measurement only; no code changed). Updates ADR-100's watch item.
- **Context**: ADR-100 recorded tuned presets leaking the suite's phrasing: Qwen2.5 Coder 1.5B answered 61.1% of the six reworded comprehension probes against 83.3% on the lane, and Qwen 0.5B 33.3% against 50%. Its re-open trigger was a prompt-axis candidate that closes the gap without losing lane rate.
- **Decision**: No prompt search. The v11 gate (2026-11-15, the presets of ADR-125) shows Coder 1.5B at 83.3% on the reworded probes, equal to its 83.3% gate window: the v10 preset's temperature 0.7 and shorter prompt, which the clustered gate did not confirm, were what lost the reworded asks. Qwen 0.5B is unchanged at 33.3% against 50%, one probe of six, on items not paired with the window. Code probes score at or above their windows for every model.
- **Consequences**: The watch item's motivating case is resolved. The remaining difference cannot be measured with six probes: an exact one-sided paired test needs a candidate to flip five of the six in one direction to reach p ≤ 0.05. Re-opening needs more reworded probes per task (on the order of 40), which is a suite change under G-003, and a search would need probes held out of the final check as well.

### ADR-131: An OpenAI request's response_format is that request's grammar
- **Date**: 2026-11-17
- **Status**: Accepted (implemented; response-format)
- **Context**: IDEA-0859 was the one item of the OpenAI contract package left deferred: the routes accepted `response_format` and ignored it, because neither `optionsFrom` nor `rejectedParam` looked at it. A client that asked for JSON received unconstrained text and had no way to tell. The settings already held `structuredOutput` (`none`, `json_object` or `json_schema`) and `jsonSchema`, and the engine compiles those into a grammar before a session is created (`#grammarFor`, IDEA-1162), so the request field can reuse that path instead of adding a second JSON mechanism.
- **Decision**: `responseFormatSettings(body)` maps the request: `text` to `none`, `json_object` to `json_object`, and `json_schema` to the client schema stringified, checked by `assertJsonSchemaSupported` and limited to the same 12,000 characters as the saved setting. The mapping is computed per request and never written to settings; an absent field keeps the saved value, or the tuned task preset's. An unknown type, a missing or non-object schema, or one over the limit is a 400 `invalid_response_format` raised before a model is loaded or a session exists. The completions route now receives those request settings (still with `promptRepeat: 1`) instead of rebuilding them, so both routes see the same format. Request failures with a 4xx status now carry OpenAI's `invalid_request_error` type instead of `server_error`.
- **Consequences**: JSON mode and a client-supplied schema work per request on `/v1/chat/completions` and `/v1/completions` without touching saved settings; a request that names no format produces exactly what it did before. A schema the compiler rejects still returns the engine's `grammar_compile_failed` (422) with its Why and Fix. Live-checked 2026-11-17 on Qwen2.5 0.5B Instruct Q4_K_M on the CPU: `json_object` answered `{"quack":"yes"}`, a schema requiring `quack` (string) and `count` (integer) produced both fields with those types, and `xml` returned 400 `invalid_response_format` (`type` `invalid_request_error`) without asking the model. Six tests were added in `tests/openai-contract.test.js`; the suite passes 882 of 883 with 1 skipped. The G-001 gate passed 9/9 with every task rate unchanged (all paired b=0 c=0), on fresh measurements (0 reused answers), and its row is in `benchmarks/history.jsonl`.

### ADR-132: Every unsupported OpenAI parameter is a 400, not a silent default
- **Date**: 2026-11-17
- **Status**: Accepted (implemented; openai-param-refusals)
- **Context**: IDEA-1264 refused `logit_bias`, tools and functions, but the other standard fields were still dropped without a word: `n` answered one choice to a request that asked for two, non-zero `presence_penalty` and `frequency_penalty` changed nothing, `logprobs` and `top_logprobs` came back null, and `echo`, `suffix`, `audio`, non-text `modalities` and `prediction` were ignored. The client received a 200 whose shape did not match what it asked for, which is the same failure IDEA-1264 closed for three fields.
- **Decision**: `rejectedParamDetail(body)` walks one rule table and returns the first parameter this server cannot honour with a Why and a Fix; `handleOpenAI` answers 400 `unsupported_parameter`, names the parameter in `error.param`, and asks the engine nothing. The OpenAI defaults stay accepted, so a client that sends them explicitly keeps working: `n=1`, `best_of=1`, `presence_penalty=0`, `frequency_penalty=0`, `logprobs=false`, `echo=false`, an empty `suffix`, and `modalities: ["text"]`. `rejectedParam` remains as the name-only helper.
- **Consequences**: A request that names a feature this server lacks now fails loudly and says which field to remove or which default to send, instead of returning a reply with a different shape. Requests that omit those fields, or send their defaults, are unchanged. A client that always sends a small penalty now has to send 0 or omit it; the README states the refusal list. Six tests were added in `tests/openai-contract.test.js` (19 there in total); the suite passes 888 of 889 with 1 skipped. The G-001 gate passed 9/9 with every checked task unchanged (all paired b=0 c=0) on the rotating tripwire window, and its row is in `benchmarks/history.jsonl`.

### ADR-133: Ctrl+C drains a running reply before the connections are closed
- **Date**: 2026-11-17
- **Status**: Accepted (implemented; graceful-drain)
- **Context**: Shutdown called `server.close()` and `server.closeAllConnections()` in the same breath, so the connection carrying an in-flight reply was destroyed while the client was still reading it, and the engine and downloads were disposed behind a client that saw a truncated stream. The lock half of IDEA-1024 had landed; the drain had not.
- **Decision**: `src/drain.js` exports `drainServer(server, { isBusy, timeoutMs, pollMs, now, wait })`: it calls `server.close()` first (no new connections), closes idle keep-alive sockets, polls `isBusy` until the engine reports no active reply or 30 s pass, then force-closes whatever is left and resolves `{ drained, timedOut, closed }`. `main.js` calls it with `isBusy: () => Boolean(engine?.busy)` before cancelling downloads, disposing the engine, releasing the lock and removing `server.json`, and prints that it is letting the reply finish. A second SIGINT/SIGTERM now quits immediately with exit code 130 instead of being ignored.
- **Consequences**: A reply being read when Ctrl+C arrives is allowed to finish; an idle browser tab no longer holds shutdown open, and a stuck client costs at most 30 s. The order of download cancel, dispose, lock release and receipt removal is unchanged. The clock and wait are injectable, so five unit tests cover the no-work, finishes-in-time, timeout, call-order and missing-helper cases without real waiting. Not verified with a real signal on Windows: Node maps `process.kill(pid, "SIGINT")` there to process termination, so the handler can only be exercised from an interactive console; the shutdown path is otherwise the same code the tests cover. No generation, prompt or settings path changed, so the G-001 gate does not apply to this task.

### ADR-134: The recommendation tests get a fixed machine, not live free memory
- **Date**: 2026-11-17
- **Status**: Accepted (implemented; recommend-memory-seam)
- **Context**: The ADR-129 route test failed once in a full-suite run ("the measured catalog model is listed"): `/api/recommendations` ranks catalog models against `os.freemem()` at request time, and under load free memory had dropped near the threshold, so the 1.1 GB coder row was classed "too large" and filtered out. The test's property is the measured ranking, not how busy the host is; a live-memory dependency makes it flaky and hides real regressions behind noise.
- **Decision**: `createHttpServer` takes an optional `system` dependency, defaulting to `systemInfo`, the same seam `nodeVersion` already uses; the recommendations route reports memory from it. `makeHarness` passes it through, and the two recommendation route tests supply a fixed 8 GiB-free machine. The ranking rule itself is unchanged: catalog rows still need room within 75% of free memory, which is the behaviour the unit tests pin.
- **Consequences**: The route tests no longer read the host's momentary memory, and a new test proves the route uses the injected machine (free = 1 byte yields no catalog rows) — that test failed before the seam existed. Ten isolated repeats of the ADR-129 test and the full suite passed. Production behaviour is byte-identical because the default is the same `systemInfo`. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-135: The judge's forgery tests forge the format the judge actually reads
- **Date**: 2026-11-17
- **Status**: Accepted (implemented; forged-judge-tests). Closes the third finding of reforge run-1 stage 2.
- **Context**: Reforge run-1 found that the test "printing a fake result marker and exiting does not pass" printed the retired `__MODELDUCK_TEST_RESULTS__` marker with the old `[{ok, detail}]` shape, while the judge since ADR-115/117 reads `[kind, text]` between two `__MODELDUCK_<id>__` markers. The test therefore passed because the line was unreadable ("no results"), not because a well-formed forgery was refused. The neighbouring writer test patched `process.stdout.write`, while the child writes through an `fs.writeSync` captured before the answer runs (ADR-121), so it exercised nothing either.
- **Decision**: The stale test is removed; the canonical "reading the judge's own script and writing a result line on exit does not pass" test now asserts the verdict detail is a value mismatch (`got 0`), not "no results", so it cannot pass vacuously again. A new test replaces `fs.writeSync` after the capture with a writer that would forge the expected values and asserts the real, captured line still reports the wrong values. A one-off probe confirmed the distinction: the retired marker shape yields `double(1): no results`, the real-marker forgery yields `double(1): got 0`.
- **Consequences**: The anti-forgery property is exercised against the current marker format and the captured writer. The suite holds 893 of 894 passing with 1 skipped (one vacuous test removed, one real test added). Production judge code is unchanged, so the G-001 gate does not apply. The reforge finding remains recorded in its run; this ADR is the evidence that it is answered.

### ADR-136: The library shows the install receipt it recorded
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; receipt-provenance)
- **Context**: IDEA-1067/1194 gave every downloaded model a receipt binding the measured SHA-256, the expected hash, the quantization, the source URL and the download time, and IDEA-1195 made resume identity strict. The receipt was only read for a launch recipe's digest; the library itself showed name, quant, size and nothing about where the file came from or whether it was hash-checked, so the evidence the project collected was invisible (IDEA-0855's gap).
- **Decision**: `withArtifacts` decorates each model row on `/api/state`, `/api/catalog` and `/api/models` with an `artifact` object read from the receipt: `digest`, `expectedSha256`, `sourceUrl`, `quant`, `downloadedAt`, each type-checked. A model without a receipt keeps its old shape, so a hand-imported file is never labelled as a verified download. The Installed card renders a provenance line: a green dot, `Verified` when the receipt's measured digest matched an expected hash (`Installed` otherwise with a faint dot), the first 12 hex characters, the source host and the date; the full digest, expected hash and URL are in the title. The host and date are hidden below 480px so the digest is never clipped on a phone. While writing the fixture, the live review also found that a receipt saved with a UTF-8 BOM by a Windows editor was silently unreadable; `readInstallReceipt` now strips the BOM, as the settings reader already does (ADR-114).
- **Consequences**: Provenance is visible where the model is and available to scripts through three routes, read-only and without touching saved state. The review followed G-007 at 1440 and 390 in both themes: it found the line inheriting the danger colour used for unreadable models, and the phone clipping, and both were fixed; `ui:smoke` now asserts the receipt text, the full title, a colour that is not `--danger`, the 6px dot, and that the line stays inside its card without clipping at 390px. This model cannot read image files, so the screenshot stage was replaced by DOM/geometry and computed-style inspection of the running page, which is what G-007's checks need here; the limitation is recorded in the UI history. Three tests were added (artifact on three routes, no artifact without a receipt, BOM tolerance); the suite passes 896 of 897 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-137: Every malformed OpenAI body gets an OpenAI error, not the UI error
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; openai-body-refusals)
- **Context**: The OpenAI routes refused an unsupported parameter and an unsupported `response_format` in the OpenAI shape, but a body that failed `toMessages` (no messages, or no user message last) or `toPrompt` (no single non-empty string) threw an `AppError` before any route-level catch. It reached the server's UI error handler, which answers 400 with `{error:{code,message,why,fix}}`: the status was right, the `error.type` an OpenAI client tests for was missing, and the body carried fields that client does not know.
- **Decision**: `handleOpenAI` wraps the message and prompt parsing in a catch that answers through `openAiError` with 400, `type: "invalid_request_error"`, the error's `code`, and the Why and Fix joined as the message. It returns before `ensureReady`, so no model is loaded and no session exists for a request that cannot be served.
- **Consequences**: Both OpenAI routes now refuse a body with one shape whether the problem is a parameter, a `response_format` or the messages themselves. The extra UI fields are gone from those bodies; the informative Why and Fix stay, rolled into `message`. Two tests were added (empty messages, missing prompt), each asserting the status, `type`, `code`, message text and that the engine never saw the request; the suite passes 898 of 899 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-138: The body reader's refusals are OpenAI errors too
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; openai-body-refusals, follow-up to ADR-137)
- **Context**: ADR-137 wrapped the message and prompt parsing, but `readJsonBody` sits earlier: it throws `invalid_json` (400) for a body that is not JSON and `body_too_large` (413) past the 8 MB limit, and those throws still escaped `handleOpenAI`. The server's UI handler answered with ModelDuck's `{error:{code,message,why,fix}}`, so the status was right but `error.type`, the field an OpenAI client tests, was absent for exactly the two refusals that happen before any parsing.
- **Decision**: The `readJsonBody` call is wrapped like the other refusals and answers through `openAiError` with the thrown status, `type: "invalid_request_error"`, and its code. The route returns before any parameter, model or session work.
- **Consequences**: Every refusal on the two OpenAI routes now carries the OpenAI error shape: unsupported parameters, `response_format`, malformed bodies, invalid JSON and oversized bodies. Two tests were added (invalid JSON, an 8 MB + 16 byte body), each asserting the status, `type`, `code` and that the engine was not asked; the suite passes 900 of 901 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-139: One BOM rule for every hand-editable state file
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; bom-tolerant-reads)
- **Context**: ADR-114 taught the settings reader to strip a leading U+FEFF, and the receipt reader learned it in ADR-136, but other hand-editable files did not. A shipped or copied preset saved with a BOM was dropped by the reader's catch and never applied; the tuner's lane reader silently planned a GPU model on the CPU lane; and the profile cache had a sharper bug: the first read stripped the BOM and parsed, then cached the *unstripped* text, so the second read from the cache failed and the profile vanished until the file changed.
- **Decision**: `fs-atomic.js` now exports its existing `withoutBom`, and the readers use it: `readShippedPresets`, `laneFromProfile` (now exported for its test), `loadProfile` (caches the BOM-free text), and `readInstallReceipt` (replacing its inline regex).
- **Consequences**: Every JSON file a user can edit with a Windows editor (settings, profiles, presets, receipts) follows one rule; four readers no longer carry their own copies. Three new tests were added (preset, profile cache, lane), each failing before the change; the suite passes 903 of 904 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-140: One Hugging Face reference resolves to one guarded download
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; hf-resolver backend)
- **Context**: IDEA-0995 is the biggest user unlock on the list and also the one that needs guardrails: the downloader only knows curated catalog entries, which carry a repository, a pinned SHA-256 and a fixed size, while an arbitrary link carries none of that. Before a user could name a file, the app needed a way to accept exactly one GGUF on Hugging Face, learn its real size, and keep the token and resume protections intact.
- **Decision**: `src/hf-reference.js` resolves either `hf:org/repo[@revision]/folder/file.gguf` or a `huggingface.co` resolve/blob link into one canonical resolve URL. It accepts https only, the huggingface.co host only (plus www), plain path segments with no traversal, one `.gguf` file, no credentials, port, query or fragment, and a valid owner, repo and revision. It never fetches; a bad reference costs no request. `DownloadManager.inspectSource` asks Hugging Face for the file with a HEAD request through the existing redirect gate (`#fetchFollowingRedirects` now takes a method, so the token still leaves on non-Hugging-Face hops), requires a positive `Content-Length`, refuses more than 32 GiB for a user-chosen file, and maps 404, 401/403 and other failures to specific errors. `DownloadManager.startSource` reuses the job machinery: the job carries its own URL, quantization and model, has a null catalog id, dedupes and resumes by file name, and the receipt records the source URL while `sha256` stays null unless the user pinned one. The resume identity still binds the `.part` file to the URL. `POST /api/models/add-hf` is loopback-only, resolves before any fetch, inspects, then starts the job (202) and returns the canonical reference.
- **Consequences**: A user-chosen file is downloaded, header-checked, atomically promoted and receipted exactly like a catalog entry, but it is honest about its provenance: no expected hash means `Installed`, not `Verified`, in the library. The catalog path is unchanged when a job has no own URL. The route is API-only for now; the Models UI follows in a separate task, so no user-facing claim is made yet. Live-checked on 2026-11-18: the resolver plus `inspectSource` against Hugging Face reported exactly the catalog's size for `bartowski/SmolLM2-135M-Instruct-GGUF` Q4_K_M (105,454,432 bytes). Twelve tests were added (5 resolver, 5 downloader, 2 route); the suite passes 915 of 916 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-141: The Discover tab adds one Hugging Face file
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; hf-ui)
- **Context**: ADR-140 put the guarded resolver, the size probe and the source download in place, but the only way to reach them was an API call, so the "biggest user unlock" was not a user feature yet. Discover is where every other model is chosen, and it already has a compact box pattern for the local import in Installed.
- **Decision**: The Discover tab gains an `import-box` styled form with a reference input, an optional SHA-256 input and an Add button. `addHuggingFace` posts `/api/models/add-hf`, inserts the returned job into `state.downloads`, starts the existing one-second `/api/downloads` poll, clears the form and toasts the repository and size. A refused reference goes through `showError`, so the server's Why and Fix are shown verbatim. Jobs with a null catalog id render under the form as `name · percent · received of size` with the same Cancel action the catalog cards use; a Dismiss action hides an error row, and complete or canceled jobs leave the list while the existing poll refreshes the library and shows the completion toast. `.hf-row` is also an `.import-row`, so inputs inherit the 38px minimum height and the 16px phone size; below 640px the SHA field takes its own line and Add stays visible.
- **Consequences**: A user can add, watch and cancel one exact Hugging Face GGUF from the app; nothing about the curated catalog cards changed, because they still select jobs by catalog id. `ui:smoke` now posts the form, checks the running row, the cleared input, the refusal toast title/Why/Fix (and closes it so it cannot leak into later sections), and at 390px checks that both inputs and the button stay inside the box with no sideways page scroll. The G-007 review ran on a live server at 1440×900 and 390×844 in both themes: at 1440 the three controls share a row; at 390 each input is 42px tall and full width with Add below; a real download of the 105 MB SmolLM2 file showed 3% with Cancel, and Cancel moved the job to canceled; a wrong host produced the server's Fix in an error toast; the reference input showed a 2px accent focus ring. This model cannot read image files, so the review used DOM geometry and computed styles rather than pixels, and the limitation is recorded in the UI history. The suite still passes 915 of 916 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-142: A pasted Hugging Face source never overwrites a different local file
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; source-name-conflict)
- **Context**: A user-chosen source has no catalog id, so its file name is the only local key. `startSource` passed through `#beginStart`, which reuses the catalog's early-complete rule: an existing file with the same size was reported complete with no receipt, and an existing file with another size would be atomically replaced by `promoteFileAtomic`. Either way a pasted link could overwrite a curated model, or claim a download that never happened.
- **Decision**: Before a source job is created, `startSource` stats the final path. If a file exists, the add is accepted only when its install receipt names the same URL, the same size and the file's own size matches; that case returns a complete job from the existing receipt and fetches nothing. Any other case, including a receipt from another source, a missing receipt or a size mismatch, is a 409 `source_name_conflict` with a Why that names both files and a Fix that asks for a rename on Hugging Face or removal of the local file. A refusal writes nothing.
- **Consequences**: Re-adding the same URL is idempotent; adding a colliding name from elsewhere is refused instead of replacing the file or faking completion. The check is size- and receipt-based, like the catalog early-complete path; it does not re-hash an existing multi-gigabyte file, so the digest shown in the library remains the one recorded at install. The catalog path is unchanged. Three tests were added (conflict keeps the original bytes, matching receipt returns complete without a fetch, another-URL receipt conflicts); the suite passes 918 of 919 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-143: One shard of a split GGUF is refused before it downloads
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; no-split-parts)
- **Context**: The Hugging Face resolver accepted any name ending in `.gguf`, and Hugging Face repository mirrors often ship large models as shards named `model-00001-of-00002.gguf`. The library reads metadata with `spliceSplitFiles: false`, and the loader opens one file, so a downloaded shard cannot be used as a model: the user would pay a multi-gigabyte download to get a file that fails at load. The resolve page also said "not the README or a split part", but nothing enforced it.
- **Decision**: `resolveHuggingFaceReference` refuses a file name matching `-\d{5}-of-\d{5}\.gguf$` with code `invalid_hf_reference` and a Fix that points at a single-file quantization or the catalog. The check is a five-digit suffix pattern, so ordinary names that contain `of`, digits or a version (`proof-of-work-v2.gguf`, `model-00001.gguf`) still resolve.
- **Consequences**: A shard is refused before any network request, and the user gets an actionable reason instead of a dead download. A split repository's single-file quantization still works, and the catalog path is untouched. Two tests were added (shard refused in hf: and URL form; ordinary names still resolve); the suite passes 920 of 921 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-144: The Hugging Face host rule is enforced at every source entry point
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; source-hardening)
- **Context**: ADR-140 put the host, scheme and path rules in the resolver, and the route always called it first, but `DownloadManager.inspectSource` and `startSource` are exported methods: called directly, `inspectSource` built `gatedDownloadHeaders()` and sent the first request to any https URL, so an `HF_TOKEN` could reach a host that was never vouched for, and `startSource` would download any https file. A non-string `sha256` was also silently treated as no pin.
- **Decision**: `hf-reference.js` exports `assertHuggingFaceFileUrl`, the single https-plus-huggingface.co rule (www accepted, other hosts refused with the resolver's wording), and both source methods call it before building headers, touching the disk or creating a job. Both also refuse a `sha256` that is present but not a string with `invalid_source_sha256`, instead of silently unpinning the file. The resolver's own URL branch uses the same helper. The plain-http refusal now carries the shared `invalid_hf_reference` code.
- **Consequences**: A direct caller cannot leak the token to another first hop or fetch another host, and a mistyped pin is refused. The canonical resolver URL and the www form still pass, and catalog downloads (which never use these methods) are unchanged. Live end-to-end check on 2026-11-18 in a clean home: a pinned `SmolLM2-135M-Instruct-Q4_K_M` reference downloaded 105,454,432 bytes, produced a receipt whose `catalogId` is null and whose `url` and `sha256` are the source and the pin, was listed by `/v1/models`, showed `Verified sha256 2e8040ceae78 · huggingface.co · 2026-11-18` with a green dot in Installed (full digest and URL in the title), loaded (`ready`), and answered an OpenAI chat request. Two tests were added (non-Hugging-Face host refused by both methods with no request; non-string pin refused by both); the suite passes 922 of 923 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.
- **Observed gap for the next task**: that load reported `contextSize` 8192 with `trainContextSize` 8192 while the saved setting is 16384, and neither the status bar nor the Settings form explains the clamp; IDEA-0954's honesty half is not yet visible to the user.

### ADR-145: The status bar and Settings explain a model's trained-context clamp
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; context-cap)
- **Context**: ADR-089 sets a 16K floor and lets only a model trained for less go under it; the live load in ADR-144 then served 8,192 for SmolLM2 135M while the saved setting was 16,384. The status bar showed `8192 ctx` and Settings showed 16,384 with a static note about the floor, so the served value looked like a silent downgrade. The engine already reports both numbers (`contextSize` and `trainContextSize`); only the UI was silent.
- **Decision**: `contextClamp()` returns the trained limit, the requested context (`max(16K, setting)`) and the served context when the trained limit is the smaller one. `renderStatus` appends `(model max)` to the served context in that case, and the Settings context field shows an accent-text note naming the trained limit, the served value and the requested value; `renderContextCap` leaves the note hidden when the model can use the setting. The status context is locale-formatted like the rest of the UI. The note text uses `--accent-text` (dark in the light theme) with an `--accent` rule, so it stays readable in both themes.
- **Consequences**: A user can see why a 16K setting serves 8K, and sees nothing when the model is trained for the setting or more. No engine, settings-application or generation path changed. `ui:smoke` now runs with a ready fixture (8,192 trained, 16,384 requested), asserts the status suffix and the note text (accepting the locale separator), and asserts the note is styled apart from ordinary fine print and stays inside its field. Live review at 1440×900 and 390×844 in both themes on a real server: SmolLM2 135M showed `8.192 ctx (model max)` and the note (two lines at 390, inside the field, no sideways scroll); Qwen2.5 0.5B (32K trained, 16,384 served) showed no suffix and an empty hidden note. The UI smoke's Bench-suite wait was raised from 8s to 15s after it timed out twice; a probe confirmed the endpoint returns three tasks with a 200 and the renderer draws them with no page errors, so the wait was a timing budget, not a behavioural change. The suite still passes 922 of 923 with 1 skipped.

### ADR-146: An idempotent add says it is already installed
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; already-installed-add)
- **Context**: ADR-142 made re-adding the same Hugging Face URL and receipt a no-op that returns a complete job. The Discover form had one success path: it said "Download started" and started the poll, which then saw the new job as complete and announced "Download complete". Nothing was wrong with the file; the messages described work that never happened.
- **Decision**: `addHuggingFace` branches on the returned job's status. A complete job, which the server only produces when the receipt already proves the same URL and size, adds its id to the existing seen set (so the poll cannot toast it again) and says "Already in your library" with the repository name. A queued or downloading job keeps the old "Download started" toast and starts the poll. Complete jobs remain out of the custom-job row list, so no phantom progress bar appears.
- **Consequences**: The user gets one truthful message for an already-installed file and none of the fake progress. Nothing on the server changed, and a genuinely new source still takes the original path. The UI smoke now returns a complete job for an `installed.gguf` fixture, asserts that the newest toast is "Already in your library" (not "Download started"), and that the form clears. The unit suite is unchanged at 922 of 923 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-147: The engine reports the requested context, so the clamp note never guesses
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; requested-context-field)
- **Context**: ADR-145's note compared the served context with the saved setting. A load's effective request can come from a tuned profile and differ from the saved value, so the note could name the wrong "asks for" number or hide a real clamp. The engine already computed that request (`requested`) in both the load and the context-rebuild paths but dropped it from the ready status; only `contextSize` and `trainContextSize` were public.
- **Decision**: Both ready statuses now include `requestedContextSize` (the effective request after the 16K floor and before the trained cap), and the two idle statuses include null. `contextClamp()` reads it first and falls back to the saved setting only when an older status lacks the field. The saved setting still populates the form; the note speaks about the load.
- **Consequences**: The note is correct whatever applied the load, including a tuned profile. The field is additive; no generation, prompt or settings-application path changed, and the engine's estimation and allocation logic are untouched. A test with a 4,096-trained fake runtime asserts requested 16,384, trained 4,096 and served 4,096. The UI smoke now uses a saved 32,768 with a reported request of 16,384 and asserts the note names 16,384 and not 32,768, which fails if the UI goes back to guessing. The suite passes 923 of 924 with 1 skipped.

### ADR-148: The MCP layer enforces the tool schema it advertises
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; mcp-protocol-tests)
- **Context**: `src/mcp-server.js` is the integration surface for coding agents (ADR-126) and already had ten tests, but its argument check only asked whether `tests` was an object: an array, an empty object or a case without `expect` passed to the loopback verify route as a generation request. The schema advertises specific bounds for `setup`, `attempts`, `retry_temperature` and `max_tokens` that nothing enforced, and the timeout, non-JSON reply and thrown-handler paths had no test.
- **Decision**: `invalidArguments` now enforces the advertised schema: a plain object, a non-empty prompt, a tests object with a non-empty entry and 1 to 50 cases, each case a plain object with an args array and an own expect, an optional string setup, attempts 1 to 8, retry_temperature above 0 and at most 2, and max_tokens 16 to 8192. Tests were extended (the ten existing ones are kept): malformed JSON-RPC messages get -32600, seventeen arguments outside the schema get -32602, the forwarding test proves only the tool's own fields reach the app, a failing answer's stopped reason is reported, the timeout, transport and non-JSON failures give their fixes, and a thrown handler becomes a -32603 line. A new test for `tests: []` failed before the fix because the array was forwarded, which is the defect this ADR closes.
- **Consequences**: A malformed call is refused at the protocol boundary instead of starting a model request that the app would have to reject. Valid calls are unchanged; the forwarding allowlist is pinned so a future argument cannot leak by accident. The stdio transport's ordering, notification skip, parse-error line and CLI spawn test remain. The suite passes 926 of 927 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-149: The Hugging Face add route is pinned as local-only
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; add-hf-local-action)
- **Context**: `local-actions.test.js` pins every mutating model route as local-only for a LAN client holding a valid key, but the new `POST /api/models/add-hf` (ADR-140) was not in that list. The route calls `requireLocalAction`, yet a future middleware change or a dropped guard would not fail a test, and the action starts a download chosen by the caller.
- **Decision**: Add the route to the mutation list with an `hf:org/repo/model.gguf` body. The existing loop asserts a 403 and a `*_local_only` error code, then re-reads settings from loopback to prove a remote call changed nothing.
- **Consequences**: The route's local-only contract is machine-checked beside import, load, unload, delete, downloads, verify and preset apply. The route's own 400 and 502 behavior remains covered in `server.test.js`. The suite stays at 926 of 927 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-150: A non-text content part is refused, not dropped
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; text-content-parts)
- **Context**: `contentText` accepted an array of parts and kept only `{type:"text", text:string}`, silently dropping image or audio parts. A vision payload therefore became an empty message that `toMessages` skipped, and the client received the misleading "The last message must be from the user". The OpenAI surface already refuses `audio`, non-text `modalities` and tools, so dropping content parts was the one remaining silent fake.
- **Decision**: `contentText` now refuses any part that is not a text part with a string `text`, with `invalid_request_error` and a Why that names the role and a Fix that says ModelDuck has no vision or audio input. Text-part arrays still concatenate exactly as before. The refusal happens in the message parse, which ADR-137 already wraps, so it returns the OpenAI error shape and never reaches `ensureReady` or the engine.
- **Consequences**: A client sending an image or audio part gets an honest 400 instead of an empty prompt or a bogus "last message" error; a mixed text and image message is refused rather than half-answered. A pure text-part message is unchanged. The test covers a joined text array, an image part, a mixed text and audio part, and a text part without text, and asserts the engine was asked only for the valid message. The suite passes 927 of 928 with 1 skipped. No generation, prompt or settings path changed, so the G-001 gate does not apply.

### ADR-151: A load or reconfigure claims the engine before its async fit check
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; load-claim-race)
- **Context**: `load()` and `reconfigure()` checked the loading flag, then awaited the memory-fit plan, and only then set the flag. A second request arriving in that gap passed every guard, so two loads (or a load during a reconfigure) ran against one engine; in a test neither completed.
- **Decision**: Both methods set the flag and take a load epoch immediately after their synchronous guards, release it if planning throws or the fit is refused (a refused fit still leaves the loaded model alone), and re-check the epoch after planning so a cancel during planning is honoured.
- **Consequences**: A concurrent request gets `model_loading` (409) while the first finishes. Checked with two failing-first tests and with the real SmolLM2-135M model. No generation, prompt or settings path changed.

### ADR-152: Parallel just-in-time requests for one model share a single load
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; jit-single-flight)
- **Context**: With ADR-151, two simultaneous `/v1` requests for the same cold model made the second fail with 409, although it only needed the first load to finish.
- **Decision**: `JitManager` keeps one in-flight load. A request for the same model awaits it (and fails with it); a request for another model while one loads is refused with `model_loading`. The next request after a failure starts a fresh load.
- **Consequences**: Parallel clients on a cold server all succeed after one load. The idle-unload timer and tracked-model rules are unchanged.

### ADR-153: A tune warns when a model is already resident, and never unloads it
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; tune-resident-warning)
- **Context**: A tune loads its own copy of the model in child processes. A model already loaded in the app takes memory and cores from it, which can skew timings or make a load refused.
- **Decision**: `/api/tune/start` returns `warnings: [{code: "resident_model", why, fix}]` when the engine has a loaded model, and the UI shows it as a toast. Unloading stays the person's choice, because it would drop their session.
- **Consequences**: The field is additive and empty when nothing is loaded. No tune scheduling or measurement changed.

### ADR-154: A reasoning model's think block is reported as reasoning_content
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; thinking-pipeline, IDEA-0997 core)
- **Context**: Models that write `<think>...</think>` before the answer put that block in `content` on `/v1/chat/completions`.
- **Decision**: `src/thinking.js` splits a block that opens the reply, whole or token by token; `/v1/chat/completions` returns it as `reasoning_content` (message field, or stream deltas) and keeps only the answer in `content`. A later `<think>` is ordinary text, and an unclosed block is all reasoning.
- **Amendment (same day)**: A model whose chat template ends its generation prompt by opening `<think>` without closing it (DeepSeek-R1 style) starts mid-thought. The registry flags it (`templateOpensThinking`, field `thinkOpen`, carried in the engine's public model) and the splitter is told `startsInThink`, so the text before the closing tag is reasoning. A template that opens and closes the block (Qwen3 with thinking off) is not flagged. `/v1/completions` is deliberately left raw: its prompt is the client's own and the legacy API has no reasoning field, so the output is not rewritten.
- **Consequences**: Plain replies are unchanged. A flagged model's reply with no closing tag (cut off by the token limit) is all reasoning, by the same rule as an unclosed block.

### ADR-155: Inference engines are assessed and versioned beside the tune
- **Date**: 2026-11-18
- **Status**: Accepted (implemented; inference-engines)
- **Context**: The tuner only ever compared two backends of one runtime (node-llama-cpp on CPU and Vulkan, a hard-coded list), with no record of which build produced a speed. Other engines exist on a machine: a native llama.cpp build (`llama-bench`), Ollama, and node-llama-cpp's own CUDA and Metal backends.
- **Decision**: `src/inference-engines.js` holds a registry of engines (constructor DI, frozen result records) and `assessEngines`, which detects and times each one in turn on the same file and workload (about 256 prompt tokens, 64 generated; one uncounted warm-up, the median of the counted runs with their range). Adapters in `src/inference-engine-adapters.js`: an in-process backend (cpu, vulkan, cuda, metal), the native `llama-bench`, and Ollama (its own nanosecond timings). Every result carries the engine's version: node-llama-cpp's module version and bundled llama.cpp release, llama.cpp's `--version` with its commit, Ollama's `/api/version`; a version the detection returns wins over one a measurement reveals. An engine that is missing, will not start or fails is reported with its reason and never stops the others. `npm run engines` assesses without tuning; `tune --engines` assesses first, widens the device stage to every in-process backend that measured (cpu first), and saves `<model>.engines.json` beside the profile. The profile schema and fingerprint are unchanged.
- **Two guards found by running it for real**: (1) node-llama-cpp starts Vulkan when asked for Metal on Windows, so detection compares the backend that actually started and a measurement compares the backend that actually loaded; the Metal row is unavailable, not a second Vulkan result. (2) A MinGW-built llama.cpp dies with a DLL entry-point error (0xC0000139) when Git for Windows' `usr` and `mingw` directories lead PATH, as in a Git Bash session, so the native engine is spawned with those directories removed and must run `--version` before it counts as available.
- **Consequences**: On this machine (SmolLM2-135M Q4): Vulkan about 270-470 tok/s generation, node-llama-cpp CPU about 165-190, the native llama.cpp build about 27 (a CPU build, most likely unoptimised), CUDA unavailable (no NVIDIA runtime), Metal unavailable, Ollama not running. Generation speed on a model this small varies run to run, which is why the range is shown. External engines are assessed for speed only: ModelDuck's answers, and so the quality search, are served in-process, so they are never device candidates. Ollama is covered by fake-server tests, not by a real server, because none is installed here; its model match is by file-name stem and `--ollama-model` names one explicitly. There is no `llama-server` adapter yet.

### ADR-156: External engines answer the tuner's device items, and are never saved into a profile
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engines-in-tuning)
- **Context**: ADR-155 timed other engines but the tuner could only generate in-process, so an engine could be assessed and not used. The user wants every engine usable in tuning.
- **Decision**: `src/external-engines.js` gives engines outside the process the evaluator's interface (`load`, `reconfigure`, `status`, `chat`, `dropSession`, `unload`). A `ServerEngine` owns the interface and the result mapping; a backend owns one protocol: `LlamaServerBackend` (spawns `llama-server` per load, waits for `/health`, maps the load to flags, reads server-side timings, is killed on stop or process exit), `OllamaBackend` (loads with the candidate's options, uses Ollama's own nanosecond timings) and `OpenAICompatBackend` (any attached OpenAI-style server, speed read from the SSE stream). A `RoutedEngine` is in-process by default and external when a load names `engine`; switching unloads the engine that was running. The evaluator carries `engine` as a model-level key but it is not a saved load key. The device stage takes external candidates, judges them like a GPU (faster than the CPU and as accurate) on the same speed items, but only an in-process device is adopted: a faster external engine is reported in the probe and the reason ("measured faster, not adopted: the app serves in-process only"). An external engine that cannot run is a verdict for that candidate, never a failed tune.
- **Why not adopt it**: the app serves through node-llama-cpp. A profile that named another engine would be applied to a different engine than it was measured on, silently. Serving through an external engine needs the app's whole engine surface (completion, abort, memory, JIT) behind the same interface, which is a separate change.
- **Verified**: 14 + 5 tests, with real local HTTP servers playing llama-server (via a fake spawn), Ollama and an SSE OpenAI server; two mutations (adopting external engines, dropping the engine key) fail the tests. Run for real with the official llama.cpp llama-server in the device stage of a tune.
- **Consequences**: An answer through an external engine may differ from the in-process one (different rounding, sampler details); the accuracy rule is what keeps a fast-but-wrong engine from looking good. Ollama is covered by a fake server only; none is installed here.

### ADR-157: The llama.cpp engines ship with ModelDuck through a pinned installer
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-shipping)
- **Context**: "Ship them with ModelDuck." Committing 25-400 MB binaries per platform is not workable, and a binary I built myself (MinGW, no CPU-feature dispatch) measured about 27 tok/s on a CPU the in-process runtime runs at 130-190.
- **Decision**: `engines/manifest.json` pins llama.cpp release b12521 per platform and variant (cpu, vulkan, cuda; metal on macOS) to the SHA-256 GitHub publishes for each asset. `src/engine-install.js` streams a download, hashes it as it arrives, deletes it on a mismatch, unpacks beside the final folder and renames it in, then records `install.json`; an install already at the pinned release is kept. `npm run engines:install` runs it, `start.bat` runs it on the first launch next to `npm install` (a failure there never stops the app), and installs live under `engines/bin` (gitignored). Each installed variant is its own engine (`llama.cpp:llama-server:<variant>`) so each has its own speed; a GPU build on a machine without that GPU is unavailable, not a silent CPU run. koboldcpp (AGPL-3.0) is attach-only.
- **Found by running it for real**: PowerShell `-Command` does not pass trailing arguments as `$args` (the paths are quoted into the command, apostrophes doubled); a MinGW llama.cpp fails to start when Git for Windows' directories lead PATH (the spawn removes them); node-llama-cpp's Metal request starts Vulkan on Windows.
- **Measured (SmolLM2-135M Q4, i5-14400F + a Vulkan GPU, 64 generated tokens)**: llama-server Vulkan 406-563 tok/s generation and 19-25k prompt, node-llama-cpp Vulkan 272-342 and 9-10k; llama-server CPU 231-251 and node-llama-cpp CPU 132-186. In the device stage llama-server:vulkan answered in 97 ms against 198 ms for node-llama-cpp Vulkan. The runtime bundled with node-llama-cpp is llama.cpp v0.7.0; the shipped build is b12521.
- **Consequences**: Serving through llama-server would be about 1.5-2x faster on this machine; the profile cannot say so yet (ADR-156). CUDA is a 650 MB download and untested here (no NVIDIA runtime).

### ADR-158: Other engines attach by address, because they all speak the OpenAI API
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-attach)
- **Context**: GitHub survey of candidate engines (stars, licence, what ships): vLLM 97k (Apache-2.0, Linux/NVIDIA server), SGLang 39k (Apache-2.0), TGI 11k (Apache-2.0), TensorRT-LLM 15k (NVIDIA only), mistral.rs 7.8k (MIT, Python wheels with CUDA, no plain Windows binary), koboldcpp 12k (AGPL-3.0, Windows exe), llamafile 27k (single-file), ik_llama.cpp 3.4k (MIT, no prebuilts, llama-server interface), ONNX Runtime / OpenVINO GenAI / MLC / ExLlama (other model formats, cannot run these GGUF files).
- **Decision**: one generic adapter, `--openai-engine name=url[#model]`, covers every server that speaks the OpenAI chat API; a llama.cpp fork or custom build plugs into the llama-server adapter with `--llama-server <file>`. An attached server is started and configured by someone else, so a load only checks it answers and picks the model; its speed is read from the stream (first content token, usage total), and its version from `/version` when it has one. Engines needing a format other than GGUF are out of scope.
- **Not verified**: no NVIDIA GPU or Linux here, so vLLM, SGLang, TGI and mistral.rs were not run; the adapter is tested against a real local server that streams SSE the way they do. An attached server's context, threads and GPU are whatever it was launched with, so the tuner cannot sweep them.

### ADR-159: The tune is built on the fastest accurate engine, and the app serves through it
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; serve-fastest-engine). Supersedes the "never saved into a profile" part of ADR-156.
- **Context**: ADR-156 let external engines answer the device stage's items but refused to save one, because the app served only through node-llama-cpp. The user asked that tuning be based on the best token-generation engine and that the app serve with it.
- **Decision**: (1) The device stage may adopt an engine the app can start itself (`servable`): it must be faster than the CPU by the paired test and answer at least as many items correctly, and it must beat the best in-process device by 10% (a second process has to earn its place); otherwise the in-process device stays and the verdict says by how much it fell short. (2) The profile keeps `engine` in its load settings (`LOAD_KEYS`), so every later stage runs on it (the evaluator already carries the key) and `presetFor` hands it to `engine.load`. (3) The app's engine is a `RoutedEngine` over the in-process engine and a resolver built from the catalog; a load that names an engine starts it, with `cachePrompt` on for serving. If that engine cannot start, the in-process engine serves and the status carries `engineFallback`; the tuner uses the same router without fallback, so a failure is a result, not a silent swap. (4) `ServerEngine` now streams, implements `complete`, `abort` and `busy`, returns the cancelled partial text like the in-process engine, reports a full `status()` (with `engine`), applies the model's trained-context clamp and the 16K floor, and refuses settings it cannot honour (`responsePrefix`; `penalizeNewLine` off on llama-server and OpenAI-style servers; DRY on Ollama) with a Why and a Fix. (5) `LlamaEngine.load` refuses a load that names another engine (`engine_not_in_process`), so any script that applies a profile without the router fails loudly instead of measuring something else. (6) Settings reload keeps the engine that was serving.
- **Found by running it for real**: the first version ranked engines by decode tokens/s and the "faster than the CPU" verdict used per-item decode speed. The speed items are mostly prompt, and llama-server reads prompts about twice as fast, so it answered them in 89 ms against 205 ms for in-process Vulkan yet counted as only 7% faster and was not chosen. Both now use end-to-end throughput (prompt plus answer tokens per second of wall time, `itemThroughput`), falling back to decode speed when token counts are missing. The first served load also ran a model trained for 8192 at 16384, which is why the clamp is applied.
- **Measured** (SmolLM2-135M Q4, Vulkan GPU, i5-14400F): the tune chose `llama-server:vulkan`, the quality stage ran on it, the saved profile reads `engine="llama-server:vulkan"`, and loading through the API served it with no fallback. 5 requests of 100 tokens through `/v1/chat/completions`: 450 tok/s end to end on llama-server against 149 on the in-process engine (same prompt repeated, so the server's prompt cache helps a little). Chat, streaming with usage, `/v1/completions`, a JSON schema and `stop` all behaved; a client that cancels a stream mid-way leaves the next request answered in 56 ms; no `llama-server` survived a hard kill of the app on Windows (Node's job object ends children with the parent).
- **Not verified**: POSIX hard-kill behaviour, CUDA and Metal (no hardware), Ollama against a real server, and serving through an attached OpenAI-style server (its profile cannot start it, so it is measured only). A tuned profile applied on a machine without the engine serves in-process, by design.

### ADR-160: Every engine is a descriptor in one catalog; adding one touches nothing else
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-catalog)
- **Context**: Engine knowledge was spread over string checks (`startsWith("llama.cpp:llama-server")`), a servable list, separate adapter and engine ids, and per-engine branches in assessment, the tuner and the app. Each new engine would have meant edits in all of them.
- **Decision**: `src/engine-catalog.js` holds a descriptor per engine (`kind`, `owns(id)`, `servable` as a boolean or a function of the id, `adapters(ctx)`, optional `resolve(id, ctx)` and `candidates(result, ctx)`), validated where it is added (`assertDescriptor`, unique kinds), and a catalog with lookup by id: `adapters`, `resolve`, `isServable`, `candidates`. Assessment, the tuner's device candidates, the engines a profile may name and the app's resolver all ask the catalog. One id per engine everywhere (`node-llama-cpp:vulkan`, `llama-bench`, `llama-server:vulkan`, `ollama`, `openai:vllm`). `--engine-plugin <file>` (on `tune`, `engines` and the app, and passed on to tune children) imports a descriptor from an ES module; the file is code the user named on the command line and runs with their rights, so it is never discovered or loaded implicitly. `tests/engine-contract.js` is the conformance check for a backend (start, generate and complete that stream exactly the text they return, a stop reason, null-or-number counts, `unsupported`, a cancelled request does not run).
- **Verified**: `tests/engine-catalog.test.js` defines a made-up engine and shows it assessed with the others, offered as a candidate and as servable, adopted by the tuner as the fastest and used for the rest of the profile, served through the app's router, and replaced by the in-process engine with a reason when the machine lacks it, all without changing any other file; mutations of `isServable` and of the engine-key stripping fail it. The conformance check passes the toy engine, the OpenAI-compatible backend and the Ollama backend against real local servers, and rejects a broken backend.
- **Consequences**: A descriptor's `servable` is a promise that `resolve` works on any machine the profile is copied to; when it does not, the fallback keeps the model serving. The catalog is the one place that grows; its size is the cost of one engine.

### ADR-161: A profile records the build of the engine it was measured on, and warns when that build changes
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-version-tracking)
- **Context**: Engines are updated independently of ModelDuck (a new llama.cpp release, a new Ollama). A profile adopted on `llama-server b12521` would otherwise be applied unchanged to a later build with no sign that its speed and accuracy were measured on another one.
- **Decision**: A descriptor may offer `version(id, ctx)`, a short string for the build the app would run, asked without starting any process (for llama-server, the release in the variant's `install.json`; a binary passed by hand has none to name). The device stage records it as `device.engineVersion` when it adopts an external engine, and `TunedSettings.resolve` compares it with the engine's current version: a difference adds a warning ("Measured on llama-server:vulkan b100, now b200: tune again so the profile matches the engine that serves it.") and `engineChanged: true`, and the profile is still applied. Nothing is compared when the version was not recorded (an older profile), when the engine does not report one, or for an in-process device (whose build is already part of the profile fingerprint).
- **Why a warning, not a refusal**: a new build is usually faster or the same, and refusing would leave the user without their tuned settings the day they update; the warning says what to do and costs nothing.
- **Verified**: unit tests for recording, matching, mismatching and the three silent cases; a real tune recorded `b12521` from the installed release, the same string the app derives at load time.

### ADR-162: A serving engine process that dies is restarted once, and only before the request produced anything
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-crash-recovery)
- **Context**: Run for real: killing the serving `llama-server` left the app answering every request with a raw `fetch failed` while its status still said ready, so it stayed broken until restarted.
- **Decision**: The three network backends classify a request that failed because the server went away (refused connection, reset, a stream cut short, or the child process having exited) as `engine_crashed`, with a Why that names how the process ended and a Fix. `ServerEngine` restarts the backend once with the same load and retries the request, but only when the request had produced no text and was not cancelled, so a client is never sent part of an answer twice. A second crash is the result; a restart that fails puts the status in `error` and clears the loaded model (the next request is refused with `model_not_loaded` rather than pretending), and the status reports `restarts`. A cancelled request is never mistaken for a crash.
- **Verified**: unit tests for the restart, the no-retry-after-output rule, one retry only, a failed restart, cancellation and the backend's classification; and for real: after the engine process was killed the next chat was answered, and a streamed request after a second kill also recovered.
- **Not done**: a crash after output has started is reported to that client as the stream failure frame (as for the in-process engine), not retried. Attached servers and Ollama are covered by the same classification but only against fakes.

### ADR-163: The app serves through llama-server with its prompt cache off
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; serving-cache-off)
- **Context**: ADR-159 served with llama.cpp's `cache_prompt` on, expecting the same benefit as keeping a session. A four-client test through the app showed one request in 148 ms and the other three at about 5.2 s each.
- **Measured against a real llama-server** (Vulkan, SmolLM2-135M, one slot): four concurrent requests with the cache on took 77, 5372, 5447 and 5521 ms; with it off, 74, 132, 204 and 274 ms. With four slots and the cache on, 1.8 s each. For sequential requests the cache saved nothing: a long shared prefix with a new question, 329 ms for six requests with it and 351 without; the identical prompt repeated, 672 ms with it and 426 without.
- **Decision**: `servingResolver` (the one place the app resolves a profile's engine) builds engines with `cachePrompt` off. The in-process engine drops its sessions between `/v1` requests as well, so this is also parity. The backend keeps the option for a future setting; a larger model on a CPU with a long system prompt may gain from the cache and has not been measured here.
- **Verified**: four concurrent requests through the app now complete in 364 ms in total (they took 5353 ms); sequential serving is 386 tok/s end to end against 149 on the in-process engine (ADR-159's 450 leaned on the cache for an identical repeated prompt, which the test no longer flatters).

### ADR-164: A llama.cpp-family build kept elsewhere is registered as an engine, not copied
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engines-add)
- **Context**: A GitHub search for more engines (ik_llama.cpp, BitNet, shimmy, Lemonade, mlx-serve, mistral.rs, llama-swap...) found two kinds: servers with an OpenAI API, which `--openai-engine` already measures, and builds of llama.cpp itself, which share `llama-server`'s arguments. The latter had only `--llama-server <file>`: measured in a tune, never servable, one at a time.
- **Decision**: `npm run engines:add -- --name <n> --binary <llama-server> [--backend] [--label]` writes an `install.json` with the file's path under `engines/bin/llama.cpp-<n>/` (nothing is copied, so a rebuilt fork is picked up as it is). The catalog treats it like an installed variant: its own id `llama-server:<n>`, assessed, adoptable, servable, with its label as the recorded version. `LlamaServerAdapter` takes the device from a recorded `backend` rather than from the variant name, so a name such as `ik-llama` is not mistaken for a GPU. Names that collide with a shipped variant are refused. The ship-with-the-app rule (pinned, checksum-verified) is unchanged for the shipped builds; a registered build is trusted as the user's own.
- **Verified**: catalog and adapter tests (found by recorded path, servable, versioned, device from the record) and register/remove tests; for real, a second registration of the installed CPU build raced as `llama-server:<name>` next to the original and was removed again. No real fork was built here, so a fork's speed is unmeasured. The serving side was run for real too: the app's serving resolver found the registered build by its recorded path, loaded SmolLM2-135M through it and answered a chat.
- **Also**: the report ends with one line naming the best speed engine for the model (and its gain over the best in-process engine); README no longer says the runtime is never downloaded, which stopped being true with ADR-151.

### ADR-165: A llama-server that cannot be started is a refusal, and a failed start cleans up after itself
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-start-hardening)
- **Context**: An audit of `LlamaServerBackend.start` found two defects. The child process had no `error` listener, so a binary that was missing or not executable (for example a build registered with `engines:add` and deleted later) raised an unhandled `error` event that ends the whole app. And a start that failed because the process exited kept its `process.on("exit")` hook, so a tune trying many candidates leaked one hook per failure.
- **Decision**: `start` listens for `error`, stops the child, and refuses with `engine_start_failed` naming the file, the error code and a Fix. Every failed start now goes through `stop()`, which removes the hook.
- **Verified**: two tests that failed before the change (a spawn that emits `ENOENT`; a server that exits while loading, with the `exit` listener count compared before and after).
- **Not done**: the port is chosen and released before llama-server binds it, so another process could take it in between; that surfaces as an ordinary start failure and is not retried.

### ADR-166: `engines --only` accepts an engine family
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-start-hardening)
- **Context**: `npm run engines -- --only llama-server` was refused as "not an engine id" because the ids are `llama-server:cpu`, `llama-server:vulkan` and any registered build; the user had to know every variant.
- **Decision**: `expandOnly` treats a value as an exact id or as a family (`llama-server` is every `llama-server:*`); a half-typed name such as `llama` still matches nothing and is named in the error.
- **Verified**: a unit test; for real, `--only ollama,llama-server` timed both llama-server builds and reported Ollama as unavailable (SmolLM2-135M: Vulkan 433 tok/s, CPU 55, the CPU figure low because the machine was busy).

### ADR-167: The installer reuses a verified cached download
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-start-hardening)
- **Context**: Reading the installer: `downloadVerified` always fetched, so a failed unpack of the 650 MB CUDA build (or a re-run after an interrupted install) downloaded it again, and its 10-minute total timeout is close to the transfer time of that file on a 10 Mbit/s link.
- **Decision**: a file already at the cache path whose SHA-256 equals the pin is reused (`cached: true`); a corrupt or partial one is fetched again as before. The total timeout is 30 minutes. The hash is the same pinned one, so reuse is exactly as trusted as a fresh download.
- **Verified**: a unit test (matching copy reused with no fetch; corrupt copy replaced). The timeout is a longer limit, not an idle timeout; a stalled connection still waits out the 30 minutes.

### ADR-168: A llama-server that loses its port is started once more on a new port
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; engine-start-hardening)
- **Context**: ADR-165 listed this as not done: the port is chosen (and released) before llama-server binds it, so another program can take it in between and the load fails for no fault of the model or the settings.
- **Decision**: when the server exits and its output says it could not bind, `start` tries once more with a fresh port. Any other exit, a spawn error and a timeout are not retried, so a bad setting still fails at once and a genuinely busy machine fails after two tries rather than looping.
- **Verified**: two unit tests (a first attempt that fails to bind then a healthy second one on a different port; an unrelated exit is spawned once). The race itself was not provoked on the real binary.

### ADR-169: A llama-server crash after start reports the last lines it wrote
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 1)
- **Context**: stderr was kept only to explain a failed start; a later `engine_crashed` said "it exited with N" and nothing else, so an out-of-memory or driver abort left no trace for the user.
- **Decision**: the backend keeps the last 4,000 characters of stderr for the life of the process and `engine_crashed` appends the last three lines (at most 400 characters) after the exit code. Nothing else about the crash path changes.
- **Verified**: a unit test (a server that writes an out-of-memory line and exits is reported with that line in the Why). Not run against the real binary.

### ADR-170: The API lists the engines and a load may name one
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 2)
- **Context**: the load route ignored `body.engine`, so an untuned model always ran in-process even where llama-server is faster, and what engines exist, whether they run here and what they measured was visible only in `npm run engines`.
- **Decision**: `src/engine-listing.js` asks the catalog (ADR-160) for every engine and reads `<model>.engines.json`; `GET /api/engines` returns it with the quickest servable measured engine as `fastest`. The load route accepts `engine`, checks it with `assertServable` (400 `engine_unknown` with the choices) and lets it override the profile's engine. The router's fallback still applies if a valid engine fails to start, and the status says so. No UI yet (phase 3).
- **Verified**: four unit/route tests with a made-up catalog (listing, no measurements, refusals, the two routes). Not exercised against a real llama-server build.

### ADR-171: The README's test-wiring paragraph moves to docs/DEVELOPMENT.md
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 9)
- **Context**: the README stood at 37,490 of its 37,500 characters, so the tree lines for ADR-170's new files could not be added.
- **Decision**: the paragraph on what `npm test` and `npm run ui:smoke` check moves word for word to `docs/DEVELOPMENT.md` and the README links it. The README now has 375 characters of headroom.
- **Verified**: `update_knowledge_base.py --check` passes (tree lists every new file, size under the cap).

### ADR-172: The Installed list offers an engine chooser per model
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 3; `ui finish` not recorded, see Verified)
- **Context**: ADR-170 made the engine choosable over the API; nothing in the app used it.
- **Decision**: each loadable row in Models > Installed shows an Engine select (Automatic, then every servable engine with its measured tok/s and "fastest here" on the quickest). The choice is kept per model for the session and sent as `engine` on load; with no servable engine the select is not drawn. The list comes from `GET /api/engines?model=` when the dialog opens.
- **Verified**: screenshots at 1440px and 390px against the real library (21 models) with a faked engine list: the select fits the row and wraps under the title on mobile, no horizontal overflow. `ui verify` passed. `ui finish --reviewed` was denied by the permission classifier, so the UI contract for this surface is not recorded. No UI test was added.

### ADR-173: The engine download has an idle limit and retries a dropped connection
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 5)
- **Context**: `downloadVerified` aborted after 30 minutes in total (ADR-167 listed it as a longer limit, not an idle one), so a slow but moving link could be cut off and a stalled one waited the full half hour; any network error ended the install.
- **Decision**: the limit is 60 s without a byte (reset on every chunk), `timeoutMs` is gone. A stall, a dropped connection (`fetch failed`, ECONNRESET, ETIMEDOUT, EPIPE, undici socket codes) and an HTTP 5xx or 429 are tried again up to twice with 1 s then 2 s back-off; a 4xx and a checksum mismatch are final. The partial file is removed before each try. No `--retry` flag: retrying is the default and the installer can simply be run again.
- **Verified**: two unit tests (a body that trickles for longer than the idle limit succeeds, a stalled one is refused with the seconds in its Why and leaves no `.part`; one reset is retried, a 404 is not, a 503 is tried three times). Not run against GitHub's servers.

### ADR-174: external-engines.js is split into backends, ServerEngine and RoutedEngine
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 8)
- **Context**: one 826-line file held three backends, the `ServerEngine` that adapts a backend to the engine interface, and the `RoutedEngine` that picks an engine per load; adding an engine meant editing it.
- **Decision**: `ServerEngine` moves to `src/server-engine.js` and `RoutedEngine` to `src/engine-router.js`, unchanged. `external-engines.js` (499 lines) keeps the backends and exports the two helpers the others share (`refusal`, `conversation`); it imports neither new file, so there is no cycle. Importers and tests use the new paths; no re-export is left behind. `src/engine-env.js`, which no test named, gets `tests/engine-env.test.js` (PATH cleaning on and off Windows, the version line, binary lookup).
- **Verified**: the 72 engine tests pass unchanged apart from their import lines; four new tests.

### ADR-175: A ui:smoke failure on the Bench suite now says what the panel held
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 7; cause of the flake still not found)
- **Context**: `ui:smoke` failed once in five runs with "the Bench suite did not render three tasks" after a 15 s wait while `/api/benchmarks/suite` answered in ~0.2 s by hand. Eight later runs (three alone, two beside the full test suite, three more in the gates) all passed, so it did not reproduce.
- **Decision**: no change to the wait or to the app. When the wait expires, the failure reports the elapsed time, the task count, the first 160 characters of the suite panel and the suite request's duration, so the next occurrence points at a slow fetch, an error panel or a render that never ran.
- **Verified**: the script still passes; the failure path itself was not provoked.

### ADR-176: A machine with no prebuilt llama.cpp is told so in the app
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; Wave 3 phase 4, first half)
- **Context**: Windows-on-ARM and Linux-on-ARM have no pinned build; the installer refuses with a Why and a Fix, but a user who never runs it only ever saw the in-process engine with no word that faster ones exist.
- **Decision**: `prebuiltNotice` (engine-listing.js) asks the manifest through `planInstall` and returns one sentence on `engine_platform`, else null; any other failure (an unreadable manifest) is also null so a fault never shows as a false notice. `GET /api/engines` returns it as `notice` and Models > Installed shows it above the list. Auto-running the installer on first launch for macOS and Linux is not done: it downloads hundreds of MB, so it stays the user's decision.
- **Verified**: a unit test (unsupported pair gets the sentence, win32-x64 gets null, a missing manifest gets null); screenshots at 1440px and 390px with the notice injected show no overflow. `ui finish` is still unrecorded (ADR-172).

### ADR-177: Wave 3 phases 4 and 6 closed as far as this machine allows
- **Date**: 2026-11-19
- **Status**: Accepted (record; no code change)
- **Context**: phase 4's second half (auto-install on first launch for macOS and Linux) and phase 6 (a real-hardware pass over the attached-engine candidates) were left open; the user said to proceed without asking.
- **Decision**: no auto-install on first launch: it downloads hundreds of MB without the user asking, and ADR-176's notice already tells an unsupported machine what to run. Phase 6: LM Studio is not installed here (only the `lms` shim remains; `lms server start` reports no installation), and no shimmy or mistral.rs binary exists on this machine, so none of the attached candidates could be measured; they stay unmeasured in docs/ENGINES.md.
- **Verified for real instead**: ADR-170 against the installed llama.cpp build: `GET /api/engines` listed `llama-server:cpu`, `llama-server:vulkan` and `ollama`; `engine: "llama-server:nope"` was refused 400 `engine_unknown`; `engine: "llama-server:cpu"` loaded SmolLM2-135M Q4_K_M in 2.4 s with no fallback and `/v1/chat/completions` answered (53 prompt, 16 output tokens).
- **Found**: `ollama` is listed as servable with no Ollama server running, because the descriptor resolves without contacting the server. Choosing it falls back to the in-process engine and the status says why (ADR-156); the chooser could hide it until a probe succeeds. Not changed here.

### ADR-178: The engine list offers only engines that answer on this machine
- **Date**: 2026-11-19
- **Status**: Accepted (implemented)
- **Context**: ADR-177's real run listed `ollama` as servable with no Ollama server running: the descriptor resolves without contacting anything, so the chooser offered an engine whose load could only fall back.
- **Decision**: `list()` asks each catalog-servable engine's adapter `detect()` and sets `servable` only when it is available, with the adapter's `reason` otherwise. Probes are cached per engine for 60 s and shared by concurrent lists, because a llama-server probe starts the binary twice and the UI lists every installed model at once. An adapter without `detect` is taken as available. `assertServable` on load is unchanged (catalog-level); an engine that dies between listing and loading still falls back with its reason (ADR-156).
- **Verified**: a unit test (an unreachable engine is not servable and carries its reason; two concurrent lists probe once; reused at 30 s, asked again at 61 s). For real: `ollama=false (No Ollama server answered at http://127.0.0.1:11434.)`, `llama-server:cpu` and `llama-server:vulkan` true, and loading through `llama-server:cpu` still answered.

### ADR-179: Tuning leaves the system prompt alone unless asked
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; tuner v12)
- **Context**: The tuning report's follow-up (section 10, F2) read 30 recorded runs: the system-prompt axis took 49,282 of 136,836 sweep answers (36%) over 20 sweeps, changed the choice once (undone on the next pass), and every saved profile kept `SYSTEM_PROMPT`. The Tune panel already leaves the whole prompt stage unchecked, but the CLI, the gate's baseline re-tune and a user who ticks Prompt for reasoning or repetition all paid for it. The user asked for system prompts to be optional and off by default.
- **Decision**: A boolean step `prompt.tuneSystemPrompt`, default `false`, in Tune settings as a checkbox. `promptAxes` leaves the axis out unless it is on, unless a run's `--settings` names `systemPrompt`, or unless the steps hold a custom prompt list and no explicit value (a list the user wrote shows the intent; `normalizeSteps` stores that as `true`, and a non-boolean is reported and ignored). With the axis out, the prompt stage still stores the system prompt every answer used, because the app's own default prompt differs from the suite's and serving must match what was measured. `TUNER_VERSION` 12: the search changed, so saved profiles are stale (they remain valid presets; they were searched over a superset).
- **Consequences**: A default prompt stage asks 5 configs per task (reasoning, repeats) instead of 27; `expectedAnswers` and the preflight shrink to match. Opting in restores the old search exactly. The gate baseline is regenerated with `--update-baseline --reuse-from` as for tuner v11.
- **Verified**: four failing-first tests (default axes, opt-in normalization incl. the custom-list and non-boolean cases, the prompt-stage answer count, and a tune whose preset keeps the measured prompt with no prompt sweep); two existing expectations moved to the opt-in case (the 22-prompt lists and the custom-list test).

### ADR-180: A fully scored axis halves after its screen, and every engine is timed at one thread count
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; tuner v12; follows the tuning report's section 10)
- **Context**: F1: ADR-049's quarter-of-the-items screen expected about 6 of 22 prompts to survive, but since ADR-063 a candidate stops only on a significant one-sided paired test, which at 12 items almost never fires: 358 of 362 recorded prompts answered the full 48 items. The halving rule (keep the top half, the current setting and anything within one standard error of the leader) skipped full axes (`if (axis.full) continue`). F6: the engine timings loaded node-llama-cpp with its default of 4 threads, llama-server with 8 and llama-bench with its own default, so a CPU ranking compared thread settings (llama-server CPU: 25-28 tok/s at 4 threads, 23-24 at 6, 28-34 at 8; the verdict reported 18.8).
- **Decision**: F1: the sweep applies the same halving after a full axis's screen. The values it cuts are recorded in the sweep's `dropped` with `screened: true`, their solved count and how far behind the leader they were, so the evidence a stopped value carries is kept. F6: `cpuTimingThreads()` (three quarters of the logical threads, at most 8, the tuner's own cap) is passed to all three adapters as `threads`; llama-bench gets `-t`. F3 (skip a no-change axis in pass 2) is not built: pass 2 is 13% of recorded answers and skipping risks the interaction it exists to catch.
- **Consequences**: Opted-in system-prompt sweeps ask roughly half the answers on a typical field (simulated: about 8 of 22 survive and a truly +10-point prompt is kept 76% of the time). Engine speed numbers from before this change are not comparable on the CPU engines. Both are inside tuner v12, so one baseline regeneration covers them.
- **Verified**: a failing-first test for each (a ten-value field where only the top half and the near-leader are measured on everything and each cut value is recorded; the three adapters receive the same thread count, llama-bench as `-t`); the existing 3-prompt screen test passes unchanged. One existing llama-bench test pinned the exact command line and now expects the added `-t 6`.

### ADR-181: Engine verdicts say when they are within noise, and the API ranks engines per task
- **Date**: 2026-11-19
- **Status**: Accepted (implemented)
- **Context**: ADR-180 left two parts of the tuning report's F5 and F6 open: the engine table marked the highest median as fastest even when another engine's repeated runs reached it (in-process CPU 32 tok/s and llama-server CPU 28-34 at equal threads), and `fastest` used generation speed only although llama-server vulkan generates 20% faster and reads prompts 18% slower.
- **Decision**: `tiedWithFastest(results)` names the measured engines whose generation range reaches the fastest one's lower end (a single reading counts as a range of one); the verdict line appends "within the measured spread of ..., so not a clear win". `fastest` itself is unchanged, because the tuner's device stage adopts by it. `fastestPerTask(engines, tasks)` ranks servable, measured engines per task by prompt tokens over prompt speed plus output tokens over generation speed, using the token counts the model's profile recorded, and `GET /api/engines?model=` returns it as `byTask`. Nothing that chooses an engine changes: the tuner and the Models list still use `fastest`.
- **Consequences**: A close call is no longer presented as a win, and a client can see that a long-context task prefers a different engine. Engine timings come from one 256-token workload, so `byTask` is an estimate of the order, not of seconds. Whether the tuner should adopt per task is open: a profile holds one engine, so it would mean a profile per task.
- **Verified**: failing-first unit tests (ties by range and by single reading, none for a lone engine or a clearly slower one; per-task ranking including exclusion of unservable and unmeasured engines and tasks with no tokens; the listing reading the profile and the measurements). Not run against the real engines beyond ADR-180's timings.

### ADR-182: An answer that ended by itself is reused under every larger token cap
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; tuner v12, no decision changes)
- **Context**: "Tuning takes too much." The recorded runs show generation is 90% of the wall time and the token-budget axis is 47% of sweep time. Same prompt, sampler and seed give the same tokens until the cap, so an answer that ended after n tokens is the same answer under every cap above n, yet each candidate cap asked the model again. Measured on 61,144 recorded answers: of the 7,359 pairs where a finished smaller-cap answer exists, 7,313 had identical text (all 6,388 sampled ones; the 46 exceptions were early greedy runs) and pass/fail differed in 4.
- **Decision**: `Measurements` keeps the slots that differ only in `maxTokens` together. Before asking the model for items a slot lacks, it copies, from a sibling slot, any answer with `stopReason === "eogToken"`, no error and `outputTokens` below this slot's cap (a missing cap counts as infinite), tagged `reusedFromCap`. Cut, aborted and failed answers, other seeds and other settings never match; the order the caps are measured in does not matter. A reused answer is not a measured one: it does not count toward `maxRuns` or the quota and is not written to the run record.
- **Consequences**: In the recorded measurement order this would have saved 3.8% of answer time (0.34 of 8.8 h). My first estimate, 22.8%, was wrong: it treated aborted answers as finished and ignored the order the caps were measured in. The saving is small because most candidate caps are measured on different item subsets, and the loopers that dominate the axis's cost are re-asked at every cap by design (a continued generation is not available). Gate and tune answers are unchanged; the run record has fewer rows.
- **Verified**: two failing-first unit tests (finished answers reused under a larger cap and under no cap; truncated, aborted, errored, other-seed, other-sampler and equal-or-smaller-cap answers measured; order independence). Not yet measured on a whole tune.

### ADR-183: A second GitHub search for engines that call themselves fast, recorded without adopting any
- **Date**: 2026-11-19
- **Status**: Accepted (record; no code change)
- **Context**: The user asked for more GitHub engines that brand themselves as fast, after a question about whether Rust could make tuning faster (the recorded runs say 90% of tuning time is generation, in native code, so the lever is the engine, not the tuner's language).
- **Decision**: Searched 800 repositories (phrase, topic and targeted queries), kept those active since May 2026 with a speed claim in the description, read the READMEs and release assets of the plausible ones and recorded them in `docs/ENGINES.md` with each claim, its measured hardware and its fit for this Windows, AMD Radeon PC. Nothing was installed or run. Kinetic (Rust, Apache-2.0, drop-in `llama-server`, Windows build, Vulkan) is the one worth a timed test through `engines:add`; its own notes warn about AMD RX 9070 crashes and say its large gains are for repeated edits. The 33.7 MB Windows archive was downloaded into an isolated folder, its SHA-256 matched the release's `SHA256SUMS`, and its file list was read without extracting. Magnitude (Rust, Apache-2.0) is attachable by `--openai-engine`, measured only; its 2x is against Ollama on Mac and NVIDIA.
- **Consequences**: No engine is added to the catalog. Whether any of them beats llama.cpp's Vulkan build on this GPU is open until it is timed alone on the machine (the baseline regeneration is using it now). All numbers in the table are the projects' own.
- **Verified**: the facts come from each repository's README, release list and API record (stars, licence, last push); none was checked by running the engine.

### ADR-184: `tune:gate --update-baseline` can tune the core models side by side
- **Date**: 2026-11-19
- **Status**: Accepted (implemented; opt-in)
- **Context**: "Tuning takes too much." A baseline regeneration tunes the three core models strictly one after another; on 2026-11-19 it ran for hours on the first model alone. The models are independent (own engine, profile and run record), the gate's check already runs them on a bounded pool (ADR-091), and earlier measurements show models on different devices barely slow each other (ADR-032 follow-up: about 1.6x combined throughput).
- **Decision**: `updateBaseline` measures each model through `measureOne` and runs them with the new `runModelsInOrder` (model-pool.mjs): up to `--models-parallel` lanes, values in input order, every lane settled before the first failure in model order is thrown. The default stays one lane, because the speed and device stages time their answers and a decision made under shared load can differ from a sequential one; passing 2 or 3 opts in, and output lines then carry the model id. `--from-profile` re-measurement uses the same path.
- **Consequences**: A baseline can be regenerated in roughly the time of its slowest model instead of the sum, at the cost of timing-based decisions (threads, batch, device) made under contention; the CHANGELOG row for a baseline made this way should say so. Nothing changes for a default run.
- **Verified**: unit tests for the helper (input order with one and three lanes, the lanes finishing in their own order, every lane settled before a failure is thrown, the first failure in model order wins); the output prefix checked on sample lines. Not run end to end: the running baseline regeneration is using the machine, and the update path starts real engines.

### ADR-185: Saved answers are checked per family of items, so one stale family no longer discards them all
- **Date**: 2026-11-20
- **Status**: Accepted (implemented; no decision changes)
- **Context**: "Tuning takes too much." A baseline regeneration with `--reuse-from` replays saved answers only after ADR-123's live spot-check passes, and the check was all or nothing: 8 saved answers spread over everything, any difference and every answer was measured again. All three baseline attempts on 2026-11-19 logged "Reuse: off. 1 to 3 of 8 saved answers re-asked live came out different", each with a different sample (recall, code reading), and so redid hours of work that the v11 baseline had replayed in 37 minutes. Cross-run history says the engine is not the cause: 1,000 pairs of identical Vulkan answers across runs and thread counts were 100% identical. Re-asking the Coder model's saved answers live: 7 of 8 identical, live against live identical, and today's judge gives the same verdict on 575 saved answers (0 changed), so what differs is a few items' text.
- **Decision**: `verifyRestoreByFamily` re-asks up to 3 of the cheapest saved answers of each family (the suite's item category), at the same alternating thread counts as before. A family with a difference (text or verdict) is dropped from the replay and measured again; the families that came out identical keep every saved answer. Only when no family verifies is nothing reused. `verifyRestore` is unchanged for its other callers. The tune's note says how many rows were kept and which families were dropped.
- **Consequences**: On the Coder model's 18,211 saved answers the check took 81 s for 30 re-asks, found one stale family (`code-long`, one item) and kept 17,840 rows. A stale item inside a family whose sampled answers matched is still replayed, the same limit the 8-answer check had. The cheapest-half sampling favours short answers, which the long code families (80% of a tune's time) are less likely to be in; the per-family minimum of one keeps every category in the check.
- **Verified**: a unit test (the identical families keep all rows, the stale family is dropped, the cheapest half is what is re-asked, all-stale reuses nothing, a changed verdict counts, timed and empty stores); the live run above. Not yet seen end to end in a baseline regeneration.

### ADR-186: Adaptive informative rungs are proposed for tuner v13, not built
- **Date**: 2026-11-20
- **Status**: Proposed; built as an opt-in option by ADR-188 (not yet validated by an A/B)
- **Context**: The user asked for abstract and creative thinking about tuning speed. Stepping back from "how many answers" to "how much does an answer tell us": 90.3% of the code task's sampling and prompt time, 85.8% of comprehension's and 86.8% of recall's went to items on which every candidate agreed, which cannot influence a paired comparison. The tuner excludes only items that never flipped in any recorded sweep (11 of 48 code items, none for the other tasks) and refills their slots, which spends the saving on power rather than speed.
- **Decision**: Record the design in `docs/tuning-improvement-report.md` (F10) and keep it out of the code until an A/B on the three core models supports it: per-task online item statistics (flips, sweeps seen, measured ms), the search rung ordered by flips per second within ADR-070's category pattern from the third sweep of a task, a quarter of the rung's cost plus a 10% random tripwire, and a challenger that leads on the subset (one-sided exact p <= 0.3) re-tested on the whole rung before it may win. The choice uses only earlier sweeps' outcomes, so within a sweep the order is fixed before the data. Accept only if held-back rates are not lower on any task and the code tune is at least 30% faster.
- **Consequences**: Evidence so far, all from three small models and replayed offline: items ranked out of sample by flips per second hold 83% of the later disagreement in 25% of the cost (code); learned inside one tune, 94%; the ranking does not transfer between models (10% for the strongest model when ranked by the other two), so it has to be learned per model online; replayed over 127 sweeps with complete outcomes, the subset plus escalation reaches the same decision in all 127 (all 4 real changes found, no false change) at 44% of the full rung cost. The replay learns from the same run, ignores nested rungs and early stopping, and has only 4 real changes to find. Ideas measured and set aside are listed in F10 (counterfactual sampler replay, stopping looping answers, skipping axes in pass 2, within-model parallelism, a Rust tuner).
- **Verified**: the analysis scripts are in `docs/tuning-repro/` (`item-concordance.py`, `item-online-order.py`, `decision-replay.py`) and reproduce the report's figures from a tune history; they need the reader's own `~/.modelduck/tune-runs`.

### ADR-187: kinetic was tried and is not faster for ModelDuck; the engine verdict now names an engine that only decodes faster
- **Date**: 2026-11-20
- **Status**: Accepted (implemented; docs and the `engines` report)
- **Context**: The user asked to try kinetic (ADR-183's best candidate: Rust, Apache-2.0, a drop-in `llama-server`). The baseline regeneration was still using the machine, so timings were interleaved and read as ratios.
- **Decision**: Run it for real, then remove it. `kinetic doctor` saw the RX 9060 XT through Vulkan (CUDA not present). Started as `llama-server` with ModelDuck's argument list it was healthy in 4 s and its streamed chat endpoint matched what ModelDuck reads. On the Coder 1.5B file it gave 7 of 8 identical greedy answers; SmolLM2 135M and Qwen2.5 0.5B Q4_K_M fail on Vulkan ("no Vulkan GEMV kernel for Q5_0"). On the engines workload it generated 2.5x faster and read prompts 8x slower. On the suite's own items, 20 per task, judged by the suite: kinetic took 1.84x as long on code, 3.5x on comprehension and 8.0x on recall, with equal pass counts (14 against 13, 17, 15). The registration and the copied binary were removed. `npm run engines` gained `endToEndSeconds` (the standard workload's seconds from the measured prompt and generation speeds) and adds a note when the engine with the best generation rate does not answer that workload soonest.
- **Consequences**: No engine is adopted. The tuner already judged engines end to end (ADR-159) so it was never at risk; the report's "fastest generation" star and "Best speed engine" line were, and still rank by generation speed, now with the note beside them. The per-task API ranking (ADR-181) is the right shape for this and agrees with the measurement. The result is for kinetic 0.1.0 Beta 1 on one GPU, three small models and one quantisation family; a later release may differ.
- **Verified**: run on this machine (numbers in `docs/ENGINES.md`); a failing-first unit test for the note and for `endToEndSeconds`.

### ADR-188: Adaptive informative rungs exist as an opt-in option, off by default
- **Date**: 2026-11-20
- **Status**: Accepted as an experiment (implemented behind `--adaptive`; not on by default; not yet validated by an A/B tune)
- **Context**: ADR-186 proposed cutting each task's search rung to the items that tell candidates apart per second of answer time, learned from the earlier sweeps of the same tune, with a full-rung re-test of anything that looks ahead. The user asked to keep working on tuning speed.
- **Decision**: `benchmarks/tune-adaptive.mjs` holds the pure parts: `ItemInformation` (per task, per item: sweeps seen, disagreements between candidates, answer time), `subset` (items ranked by `(flips + 0.15) / (seen + 1)` per millisecond within their category, taken until a quarter of the rung's estimated cost and never fewer than 16, plus a deterministic tenth of the rest as a tripwire), `exactGainP` and `promisingChallengers` (ahead of the incumbent with one-sided exact p <= 0.3). In `tune.mjs`, `sweepAdaptive` runs a sweep on the subset once one sweep of that task is in (replayed: one warm-up sweep decides as safely as two and also covers the costly `maxTokens` axis); a sweep that changed the setting or has a promising challenger is run again on the whole rung with only those values, with Holm still counting every challenger of the subset sweep. The subset is chosen once per task stage so its sweeps stay comparable. The stage's best score is now kept per search rung (`stageBestBy`), which changes nothing when there is a single rung. Off unless `adaptive` is set: `npm run tune -- --adaptive`, `tune:gate -- --update-baseline --adaptive`. Pair, full-rung, memory-budget and quick runs are never adaptive. The record of an adaptive sweep carries `adaptive: { items, of, escalated }`.
- **Consequences**: With the option off every existing test passes unchanged. On a synthetic model with a few deciding items the adaptive run asked fewer than 80% of the answers, reached the same settings and found a late real gain only through the escalation. The learning does not survive a pause (a resumed tune warms up again), the escalation spends full-rung answers on every lead that is not real, and the replay that motivated it (F10) was optimistic, so the real saving and any lost change are unknown until an A/B on the three core models. Accept it for use only if the held-back rates are not lower on any task and the code tune is at least 30% faster; otherwise remove it.
- **Verified**: unit tests for the helpers (tests/tune-adaptive.test.js) and a mechanics test through `tune()`; both were written together with the code, so they are not failing-first. Not run on a real model.

### ADR-189: First A/B of the adaptive option, and what it changed
- **Date**: 2026-11-20
- **Status**: Accepted (record; the option stays opt-in and unvalidated until the second A/B)
- **Context**: ADR-188's acceptance test: held-back rates not lower on any task and the code tune at least 30% faster. First A/B on Qwen2.5 Coder 1.5B, code task, `--stages device,sampling,prompt`, a normal tune against `--adaptive`, each in a fresh temporary home on an otherwise idle machine (earlier attempts beside other jobs ran 30x slower and were discarded; a first design without the device stage ran on the CPU and was discarded too).
- **Result**: normal 1,524 answers, 18.5 min of answers; adaptive 1,441 answers (95%), 16.5 min (89%). Same final settings, same held-back result (the tuned preset fell back to the defaults in both: 56.1% against 61%). One sweep had another winner (prompt/reasoning, pass 1). Far short of 30%.
- **Why**: the first sweep of the code task (`sampler`, six candidates that all survive to the full 48 items) is about 44% of a tune's answers and is the warm-up, so adaptive cannot touch it; the two pair checks are about 40% of the adaptive run's answers because they tried four combinations on the whole rung; and an escalated sweep re-tested only the leaders, so no runner-up was left and the pair check, which builds its combinations from each axis's winner and runner-up, was silently skipped in the synthetic test.
- **Decision**: the pair check runs through `sweepAdaptive` too (subset first, escalation only for a combination that looks ahead), and an escalation keeps the runner-up in its re-test set. A futility stop was measured and rejected: stopping a challenger that is not ahead at the middle look would end 77% of evaluations early but lose 2 of the 7 real changes (they were level at the middle look); stopping only one that is behind (net <= -1) ends 11% and loses none.
- **Second A/B** (pair checks adaptive, runner-up kept; same normal run as the baseline of the comparison): 1,294 answers (85%), 15.2 min of answers (82%), 16.1 min wall against 22.9. The held-back check passed (63.4% against the 61% default) where the normal run's preset fell back (56.1%): the normal run had adopted `reasoning: auto` with a 1,024-token cap, the adaptive run kept `reasoning: off`. One sweep, one model, one task: not evidence that adaptive decides better. Still short of 30% fewer answers, because the first sweep, which is about half of a code tune, was the warm-up and ran whole.
- **Decision (continued)**: a probe. Before the first sweep of a task, the current setting and the axis's last value (the farthest from it) answer the whole rung; that teaches the item statistics, and the sweep itself then runs on the subset, so the biggest sweep is no longer the warm-up. The two probe candidates are mostly work the sweep would have done anyway. `adaptive.probe` (default true) switches it; an axis with fewer than three values is not probed.
- **Consequences**: the third A/B decides whether the option is kept: about a third fewer answers than the normal run on the code tune with the held-back result not lower. If it does not reach that, the option is removed rather than left as dead weight.
- **Third A/B** (the probe on; Coder 1.5B, code task, same normal run): 977 answers (64%: 36% fewer), 11.6 min of answers (63%), 12.5 min wall against 22.9; held-back 63.4% against the 61% default (the normal run's preset fell back at 56.1%); every sweep after the probe ran on 20 to 21 of the 48 items and none needed an escalation. This meets ADR-188's bar on this one model and task. It does not yet show held-back not lower on every task, or on the other models: the 0.5B model on all three tasks is running next.
- **Fourth A/B** (Qwen2.5 0.5B, all three tasks, `--stages device,sampling,prompt`): 2,731 answers against 4,893 (56%: 44% fewer), 8.2 min of answers against 15.1 (54%), 8.8 min wall against 16.1. The final presets of code, comprehension and recall are identical to the normal run's, as are the load settings; held-back 39%, 51.5% and 20.8% in both (defaults 36.6%, 51.5%, 20.8%), none fell back. Two sweeps wrote their winner differently (a patch with or without keys it did not change), with the same effective settings. 23 sweeps were adaptive, 3 escalated.
- **Verified**: unit and mechanics tests (the pair check and the probe each have one, with three seeds and tied values as a real tune has); the A/Bs above, each in a fresh temporary home on an otherwise idle machine.
- **Fifth A/B and a correction** (Coder 1.5B, comprehension and recall): adaptive asked 1,799 answers against 3,206 (44% fewer, 4.5 against 9.6 min) and kept comprehension identical, but on recall it MISSED `promptRepeat: 2`, the one real gain of that task (held-back 58.3% in the normal run, 39.6% = the default in the adaptive run). The subset had been chosen from sampling-axis flips; a prompt axis changes other items (repeating the prompt helps long-context retrieval), so cross-axis information does not transfer to it, and the replay could not show this because it held no such change. That breaks ADR-188's rule (held-back not lower on any task).
- **Correction**: adaptivity is limited to the sampling stage. The prompt stage (reasoning, prompt repeat, and their pair check) runs whole as before. A test fixes it (a gain that only the prompt axis can find is found with the option on). The earlier A/Bs ran the prompt stage adaptively, so their savings were a little larger than this version's; the sampling-stage results (identical presets) stand, and the pairs are being rerun with this version.
- **Reruns with the correction** (sampling stage only, fresh temporary homes, quiet machine): Coder 1.5B comprehension and recall: 2,189 answers against 3,206 (68%), 6.7 min of answers against 9.6; presets identical, `promptRepeat: 2` found on recall (held-back 58.3% in both, default 39.6%), comprehension 63.6% in both. SmolLM2-135M, all three tasks: 3,682 answers against 5,489 (67%), 117 against 166 min of answers; held-back identical on every task (12.2%, 0%, 6.3%); the recall presets differ in `maxTokens`/`repeatPenalty` but neither beats the default in either run (6.3%). Held-back is not lower anywhere, so the bar of ADR-188 is met on three models; the option stays opt-in (off by default, G-004), with about a third fewer answers.

### ADR-190: Code sampling no longer starts with the newline penalty off on llama-server

- **Context**: Re-tuning the saved Qwen2.5 0.5B Q4 profile chose `llama-server:vulkan` at the device stage (254 tok/s against 70 on the CPU), then stopped in the code sampling stage: "The model could not load with any sampler tried". The code task starts with `penalizeNewLine: false` (lit review section 2), and llama-server's chat endpoint refuses that setting (`unsupported`, ADR-160), so every candidate failed on its first answer.
- **Decision**: the code start leaves `penalizeNewLine` alone when the engine chosen at the device stage is a llama-server. The setting stays at its default there, which that engine applies anyway. A test fixes it.
- **Consequence**: a tune built on llama-server can reach the sampling stage. The `penalizeNewLine` axis still offers `false` there and that value fails as a candidate (the incumbent stays); it is now skipped on llama-server (the axis's `skipWhen` checks the engine).

### ADR-191: Five saved profiles now carry a measured engine, and Llama-3.2-3B finished its interrupted recall stage

- **Date**: 2026-11-21
- **Status**: Accepted (record; re-tune wave, no code change)
- **Context**: Report follow-up F4 found no saved profile had been through the engine stage (all dated 2026-11-14, before ADR-156), while llama-server:vulkan was measured 20% faster than the in-process runtime on Coder 1.5B. A re-tune wave under tuner v12 (ADR-179..ADR-190) therefore rebuilt profiles with `--engines`; the Llama-3.2-3B run was interrupted mid-recall by a session end, leaving `sampling:recall` partial and no `prompt:recall`.
- **Decision**: Resume the interrupted run with `--continue` against the recorded run rather than `--force` (saved answers from 4,154 to 4,454 rows verified live per family, ADR-185), and audit the wave before recording it. No suite, prompt, check or search changed, so G-003 needs no `SUITE_VERSION` bump and no `benchmarks/CHANGELOG.md` row; this ADR is the record.
- **Result** (each profile at tuner v12, suite 18, engine `llama-server:vulkan`, every task done, held-back not lower than the defaults anywhere):
  - llama-3.2-3b-instruct-q4: code 56.3% (hold 68.3 vs 57.7 default), comprehension 68.1% (77.3 vs 77.3), recall 76.1% (77.1 vs 77.1, `promptRepeat: 3` found, +8.7 pts on the tune rung, p=0.0938). The resumed stage took 9.9 min and asked 813 answers (78% generate, 19% load); the earlier part of the run had already fixed device (53.7 vs 8.27 tok/s CPU, 6/6 correct), quality (f16) and speed (8 threads, batch 512).
  - qwen2.5-0.5b-instruct-q4: code 33.3% (39 vs 32.5), comprehension 50% (63.6 vs 48.5), recall 33.3% (20.8 vs 20.8).
  - qwen2.5-0.5b-instruct-q5: code 33.3% (39 vs 35.8), comprehension 52.1% (56.1 vs 56.1), recall 34.1% (18.7 vs 18.7).
  - qwen2.5-0.5b-instruct-q8: code 33.3% (41.5 vs 32.5), comprehension 52.1% (54.5 vs 54.5), recall 36.2% (22.9 vs 22.9).
  - qwen2.5-1.5b-instruct-q4: code 48.6% (52 vs 50.4), comprehension 63.9% (68.2 vs 68.2), recall 53.6% (43.7 vs 39.6).
- **Consequences**: every saved profile the app serves through llama-server now measures the engine it serves with, closing F4 for five of eight profiles. Still stale: qwen2.5-coder-1.5b-instruct-q4 and smollm2-135m-instruct-q4 (tuner 11, no engine; the two strongest core gate models) and phi-3.5-mini (tuner 8); they keep their presets with a stale warning until re-tuned. The engine table printed at the start of a tune is measured under whatever else runs on the machine (117.98 vs 13.13 tok/s in one run, 95.3 vs 71.47 in another); the device stage's own probe is the number a profile records.
- **Verified**: the resumed run's record (`outcome: done`, 2026-11-21T09:41:40Z) and the saved profile (`stages` all `done`, `fingerprint.tunerVersion` 12); the audit table above read from `profiles/*.json`; `npm test` and the project gates pass.

### ADR-192: In-process JS syntax check and a resilient, memoized GPU route (app speed, no tuning)
- **Date**: 2026-11-22
- **Status**: Accepted
- **Context**: The user asked to make the app faster without tuning any model. A measured profile of non-generation paths found `benchmarks/suite.mjs::checkJavaScriptSyntax` spent **47.15 ms per answer** spawning `node --check` with a temp file and directory; `GET /api/gpu` did a fresh dynamic `import("node-llama-cpp")` on every poll and returned **500** on this source checkout where the native package is absent (one red test: `the GPU endpoint reports detected backend types`). Neither path touches generation, prompts, settings or the chat UI, so G-001's `tune:gate` is not engaged and no `SUITE_VERSION` bump is needed.
- **Decision**:
  1. Parse plain script answers with `new vm.Script(code)` in-process — the same V8 grammar as `node --check`, no execution. Replies with top-level `import`/`export` keep the original `node --check` path because that route parses them as modules. The verdict detail stays `node --check` so saved baselines remain comparable.
  2. Move GPU detection to `src/gpu-info.js`: load `node-llama-cpp` once behind a memoized promise, return an empty backend list when the runtime is missing, and keep the route's response shape and note unchanged.
- **Consequences**: the measured syntax check drops from **47.15 ms to ~0.005 ms per answer**; 20 checks now take ~1.3 ms instead of 1,131 ms. `/api/gpu` answers 200 with an empty list on a source checkout and repeated polls reuse one detection. Three failing-first tests pin the new contracts; `npm test` passes 1,093 tests (1 skipped).
- **Cross-principle check:** PRINCIPLE-014: no assertion was weakened, and the new tests failed before the code; PRINCIPLE-011: the route gives a usable answer instead of a 500; G-001/G-003: no generation, prompt, settings or UI change, so no tune gate or suite bump.

### ADR-193: Optional in-process Rust GGUF guard, kept behind the JavaScript guard
- **Date**: 2026-11-22
- **Status**: Accepted
- **Context**: App-speed milestone M3 targeted `src/gguf-guard.js::inspectGgufHeader`, which walks every GGUF header on a scan-cache miss; ADR-019 measured 107 ms for a 151k-token vocabulary. A first Rust rewrite as a CLI was **rejected by measurement**: on this Windows host a spawn cost ~104 ms per file versus 7.5 ms for the JavaScript walk, i.e. 14x slower. An in-process N-API addon removes the spawn entirely.
- **Decision**:
  1. Add `rust/gguf-guard/` with no crates: a bounded v2/v3 header walker shared by a CLI twin and a hand-written N-API cdylib exposing `inspectGguf(path)`.
  2. Load it with `process.dlopen` in `src/gguf-native.js`; a rejection returns `null` so the original JavaScript guard still builds the exact `422 gguf_header_rejected` AppError with its Why/Fix text. The addon is optional: without `npm run build:native` the app behaves exactly as before.
  3. Build statically labelled bounds in Rust (no per-token `format!`) and consume skips through the `BufReader` instead of seeking, so a large vocabulary does not turn into one system call per string.
  4. Add `npm run bench:gguf`, which builds a synthetic 20k-token / 2k-tensor header and times both implementations.
- **Consequences**: on that fixture the JavaScript walk takes **8.19 ms** and the in-process Rust guard **1.38 ms (~5.9x faster)**; with a real 151k vocabulary the gap should be larger, but that has not been measured here. Two tests pin native/JavaScript fact parity and the hostile-header fallback; `npm test` passes 1,095 tests. Build host note: Windows GNU needs a tiny `node.def`-generated import library because the Node distribution ships no `node.lib`; `scripts/build-native.mjs` creates it.
- **Cross-principle check:** PRINCIPLE-014: the CLI variant was dropped because it was slower, and the shipped path has failing-first tests with unchanged assertions; G-006: LICENSE is untouched; G-001/G-003: only scan validation changed, not generation, prompts, settings or suite hashes.

### ADR-194: Cache CPU topology and defer the benchmark suite out of server startup
- **Date**: 2026-11-22
- **Status**: Accepted
- **Context**: Speed wave 2 profiled the running app rather than guessing. `systemInfo()` cost **345.5 us per call** because `os.cpus()` (347 us) was re-read on every `/api/health`, `/api/metrics` and fingerprint resolution even though CPU model and core count cannot change during a process. The server also statically imported `benchmarks/tasks.mjs` and `benchmarks/multistep-items.mjs`, pulling the whole prompt/item suite into its startup graph solely for task-id validation and one summary route.
- **Decision**:
  1. `src/system.js` reads CPU topology once into a frozen `cpuTopology()` record, with `resetSystemInfoCache()` for tests; `systemInfo()` still reads free memory and uptime live.
  2. Move the static `TASKS` vocabulary into `benchmarks/task-ids.mjs`; `tasks.mjs` re-exports the same frozen array, and `server.js` imports the lightweight module. The two heavy summaries are dynamically imported only inside the `/api/benchmarks/suite` route.
- **Consequences**: `systemInfo()` measures **1.3 us/op** (about 265x faster). Server startup no longer loads suite/item modules; a source test pins that the heavy imports are absent and another pins that the two task arrays are the same object. `npm test` passes 1,100 tests (1 skipped).
- **Cross-principle check:** PRINCIPLE-014: failing-first tests were added before each change and no assertion was weakened; G-001/G-003: no prompt, check, task subset, setting or generation path changed, so no `tune:gate` or `SUITE_VERSION` bump.

### ADR-195: Memoize the task-subset hash used by profile fingerprints
- **Date**: 2026-11-22
- **Status**: Accepted
- **Context**: Speed wave 3 profiled `/api/recommendations` at **18.76 ms per request** with eight installed models. Each `currentFingerprint` call recomputed `taskSubsetHash()`, which serializes every prompt definition and SHA-256 hashes it (**1.79 ms per call**); eight models meant ~14 ms of identical hashing per request. The suite is frozen for a process, so the work is constant.
- **Decision**: Cache the hash by prompt array in `benchmarks/tasks.mjs`. The default frozen `PROMPTS` array is hashed once; a caller passing a different array still gets its own hash. `resetTaskSubsetHash()` and `taskSubsetHashComputations()` are test seams, and a parity test recomputes the original definition hash to prove the cached value is byte-identical.
- **Consequences**: `taskSubsetHash()` drops from 1.79 ms to ~0.00 ms per call; `/api/recommendations` drops from **18.76 ms to 5.12 ms** with eight models. `npm test` passes 1,103 tests (1 skipped).
- **Cross-principle check:** PRINCIPLE-014: failing-first tests and byte-parity check added before the change; G-003: no prompt, check, task subset or version changed — only the cost of hashing the same static suite, so no `SUITE_VERSION` bump or baseline update.

### ADR-196: A failed engine spawn refuses at once, without the exit wait
- **Date**: 2026-11-22
- **Status**: Accepted
- **Context**: Looking at tuning/engine test speed without running a whole tune, a TAP profile showed `a binary that cannot be started is a refusal, not a crash` spending **5,131 ms**: `LlamaServerBackend.stop()` waited up to 5 s for an `exit` event after `kill()`, but a child that fails to spawn emits only `error` and never exits. The app had the same delay before telling the user the engine binary was missing.
- **Decision**: Track a `#childGone` flag when the child emits `exit` or `error`, and have `stop()` skip the exit wait in that case (it still calls `kill()` and removes the exit hook). The refusal code, Why/Fix text and listener cleanup are unchanged.
- **Consequences**: the failing-first test drops from **5,154 ms to 143 ms**; all 35 external-engine tests pass and the whole suite drops from ~17.4 s to ~13.8 s wall time. No tuning was run and no tuning setting, prompt or suite hash changed.
- **Cross-principle check:** PRINCIPLE-014: the new timing test failed before the fix and no assertion was weakened; G-001/G-003: no generation, prompt, settings or suite change, so no `tune:gate` run or baseline update.

### ADR-197: Cache shipped presets by an exact directory stamp
- **Date**: 2026-11-22
- **Status**: Accepted
- **Context**: Continuing speed work without running a tune, `readShippedPresets()` was measured at **1.52 ms per call**, re-reading and re-parsing ~135 KB of preset JSON on every `/api/recommendations` and preset-detail request.
- **Decision**: Cache parsed recipes per directory, keyed by a stamp of every preset file's name, mtime and size. Any add, remove or edit changes the stamp and forces a fresh read; invalid files are still skipped exactly as before. `resetShippedPresetCache()` and `shippedPresetReads()` are test seams.
- **Consequences**: `readShippedPresets()` drops to **0.27 ms per call** and `/api/recommendations` from 5.12 ms to **4.52 ms** with eight models. Two failing-first tests pin reuse and invalidation; `npm test` passes 1,106 tests and the suite wall time is ~8.8 s.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests with a read counter, no assertion weakened; G-001/G-003: no tuning setting, prompt, check or suite hash changed, so no `tune:gate` or baseline update.

### ADR-198: Concurrent multistep chains were tried and reversed
- **Date**: 2026-11-23
- **Status**: Rejected — reversed in the working tree
- **Context**: Continuing the speed work, the profiled multistep test file took 2.8–3.9 s because each chain's sandboxed judge child ran after the previous one, although the five chains share no mutable state.
- **Experiment**: Mark the two tests generated per chain with Node's `concurrency: true` option; assertions, sandbox flags and child count unchanged.
- **Result**: that file's median improved from ~3.44 s to ~2.87 s, but the full suite regressed: a timing-sensitive `openai-engines` assertion ("two gaps of about 15 ms") failed under the extra child-process contention and the gate run took 48 s instead of ~9 s. The change was reverted before delivery. The objective explicitly says to reverse anything that worsens speed and to keep all functionality intact; this experiment met neither bar in the full run.
- **Cross-principle check:** PRINCIPLE-014: no assertion was weakened or deleted; the rejected option never reached a commit.

### ADR-199: Cache profile-list summaries by an exact directory stamp
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `listProfiles(12)` measured **1.31 ms** and `/api/profiles` **2.91 ms**: the UI polls the route, and every poll re-read and re-parsed every saved profile just to return three summary fields.
- **Decision**: Cache the summary array per directory, keyed by each profile file's name, mtime and size. A tune writing a profile changes the stamp and the next poll reads fresh; callers receive a shallow copy so they cannot mutate the cache. `resetProfileListCache()` and `profileListParses()` are test seams. ENOENT still returns an empty list.
- **Consequences**: `listProfiles(12)` drops to **0.41 ms** and `/api/profiles` to **1.42 ms** (~2x). Two failing-first tests pin reuse, copy-by-value and invalidation on add; no profile content, setting or suite hash changed.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: read-only summaries, so no `tune:gate` or baseline update.

### ADR-200: Measure loop lag in the check phase instead of the timer wheel
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `/api/health` measured **7.49 ms per request** because `measureLoopLag()` awaited `setTimeout(0)`; on this Windows host a single timer turn costs ~10.6 ms. A broader route profile showed it was the slowest endpoint in the app.
- **Decision**: Schedule the probe with `setImmediate` instead. It still measures the exact delay between scheduling and the event loop getting back to the callback; a 20 ms synchronous block scheduled after the probe reports ~20.6 ms, so the health signal is preserved. No caching or stale samples.
- **Consequences**: `/api/health` drops from **7.49 ms to 0.68 ms** (~11x); the probe itself from 10.6 ms to ~0.007 ms. Two failing-first tests pin the speed and the blocked-loop behavior; no settings, prompts or generation changed.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests with preserved functional assertion, no gate weakened; G-001/G-003: read-only health probe, no `tune:gate` or baseline update.

### ADR-201: Include the explicit runtime version in the fingerprint cache key
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `/api/recommendations` with 60 installed models measured **76 ms**. `currentFingerprint()` cached only when no runtime was passed; a caller that pins `nodeLlamaCpp` (the test harness, and any caller measuring against a fixed runtime) recomputed the fingerprint for every model on every request — 13.8 ms for 60 models.
- **Decision**: Cache by `fileName|size|runtime` whenever the runtime is a string (still no cache when a custom `system` object is supplied). A computation counter is exposed for tests.
- **Consequences**: `/api/recommendations` with 60 models drops from **76 ms to ~8–10 ms**; two failing-first tests pin runtime-keyed reuse and distinct-runtime separation. Fingerprint fields and values are unchanged, so saved profiles remain comparable.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: the fingerprint formula is unchanged — only when its result is reused — so no `SUITE_VERSION` or baseline update.

### ADR-202: Do not re-read a profile that stat already proved missing
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `loadProfile()` statted a profile file and then still attempted `readFile`, which failed for models with no saved profile. 600 missing lookups measured **107 us each**; a 60-model recommendation path pays that for every unprofiled model.
- **Decision**: Return `null` immediately when stat reports the file absent. A file created later is found by the next call's stat, so no profile is lost; damaged-file quarantine and all other branches are unchanged.
- **Consequences**: 600 missing lookups drop to **~48 us each (~2.2x)** with stable repeated measurements. Two failing-first tests pin the skipped read and the create-later behavior. End-to-end endpoint timings were noisy under concurrent host load, so the stable microbenchmark is the reported evidence.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests with the functional case preserved, no assertion weakened; G-001/G-003: read-only profile lookup, no tuning or suite change.

### ADR-203: Negative-cache missing install receipts instead of statting every file
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `readInstallReceipt()` issued a failing `readFile` for each model without a receipt — 1,718 us each on this host. A first attempt that statted before reading was **rejected by measurement**: it sped the missing case but regressed the present-receipt case from ~152 us to ~270 us.
- **Decision**: Remember only the negative result for 500 ms, so a burst of `/api/models` or `/api/state` reads skips repeated failed reads while the common present-receipt path keeps its single successful read. App downloads and deletes invalidate the mark immediately; an external file creation becomes visible after the short window.
- **Consequences**: missing receipts drop to **~128 us each (~13x)**; present receipts stay at **~137–178 us** (baseline ~152 us). Two failing-first tests pin the skip and the create-later behavior; `npm test` passes 1,116 tests. The rejected stat-first variant never reached a commit.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened, and a slower variant was reversed; G-001/G-003: read-only receipt lookup, no tuning or suite change.

### ADR-204: Check process liveness once per pid when listing tune runs
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `listRuns(50)` measured **176 ms** because `present()` called `process.kill(pid, 0)` for every run, although a tune writes all its runs from one process and they share a pid.
- **Decision**: Memoize the liveness answer per distinct pid within a single `listRuns` call. A pid cannot change from dead to alive during one listing, so every run still gets the same verdict it would have had individually; custom `isAlive` injections are supported as before.
- **Consequences**: `listRuns(50)` drops to **10.6 ms (~17x)**. Two failing-first tests pin one probe for 40 same-pid runs and one probe per distinct pid. Run summaries and the interrupted-vs-running verdict are unchanged.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: read-only run listing, no tuning or suite change.

### ADR-205: Hold a full wave of verified judge results
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: The sandbox hotspot remained: each uncached answer costs a ~76 ms child spawn. The judge result is a pure function of answer text + check + timeout, and a quick tune repeats answers across load variants, but the cache held only 512 entries. A 700-answer cycle had **0 hits** because the first answers were evicted before their variants ran.
- **Decision**: Raise the bound to 4096 entries (bounded memory, ~tens of MB) and export the constant so a test can pin it. Verdicts, sandbox flags and eviction order are unchanged.
- **Consequences**: a controlled 600-answer A/B (same machine, alternating constant) went from **66.5 s / 0 hits / 600 spawns** to **46.3 s / 50 hits / 550 spawns** (~30% faster). No tuning settings, prompts or suite hashes changed; the cache still stores only results of the same pure verification.
- **Cross-principle check:** PRINCIPLE-014: failing-first test and controlled A/B, no assertion weakened; G-001/G-003: no tuning change — only reuse of already-verified answers.

### ADR-206: Load the server graph only when the app actually starts
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `node src/main.js --help` cost ~200 ms because the entry statically imported the server, engine, registry, tuner and benchmark graph before printing three lines of help.
- **Decision**: Keep only `config.js` and `errors.js` static; load the other 15 modules with dynamic `import()` inside `main()` after the help/version early returns. The entry path (`node src/main.js`) and all flags are unchanged.
- **Consequences**: help drops from ~200 ms to **57–62 ms**; `ui:smoke` proves the real start path still serves the full control panel, and the full suite passes 1,120 tests. No settings, prompts or generation changed.
- **Cross-principle check:** PRINCIPLE-014: failing-first source test plus real start-path smoke, no assertion weakened; G-001/G-003: CLI startup only, no `tune:gate` or baseline update.

### ADR-207: Sandbox startup flags tested and rejected
- **Date**: 2026-11-23
- **Status**: Rejected — no code change
- **Context**: The remaining profiled hotspot is the ~76 ms sandbox child spawn in `runJavaScriptTests`. A controlled A/B harness re-wrote the spawn flags, ran 80 unique answers (judge verdicts asserted identical), alternated variants over five rounds, and always restored the original file.
- **Results**:
  - `--disable-source-map`: invalid on Node 26 (`bad option`, child exit 9) — rejected immediately as a correctness regression.
  - `--no-warnings`: median 7,184 ms → **7,724 ms** over five rounds (~7.5% slower) — rejected.
  - `--max-old-space-size=128` instead of 256: median 5,341 ms → 5,385 ms (flat/noise) — rejected.
- **Consequences**: `benchmarks/suite.mjs` is unchanged (verified by a clean `git diff`). No process-isolation property was relaxed in any variant: `--permission`, the neutral environment, heap cap, timeout and one-child-per-answer remained. The A/B harness asserts every verdict still passes, so a flag that broke judging would have been caught.
- **Cross-principle check:** PRINCIPLE-014: no assertion weakened; the slower/invalid variants never reached a commit, and the tree remains green.
### ADR-208: Cache the per-limit Bench summary with the parsed report
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, the Bench panel polls `/api/benchmarks`; a cache hit still re-summarized a 2.3 MB baseline at **0.55 ms per call**.
- **Decision**: Keep a `Map` of summary results by `limit` inside the existing stamp-keyed report cache. A new file stamp replaces the whole entry, so edits still invalidate exactly; each distinct limit is summarized once.
- **Consequences**: cached reads drop to **0.27 ms (~2x)**. A failing-first test pins one computation per limit. Summary shape and values are unchanged.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: read-only Bench reporting, no tuning or suite change.

### ADR-209: Compute the static state-machine catalog once
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `machineCatalog()` cost **8.06 us** per call because it rebuilt the same frozen machine vocabulary on every `/api/health` poll.
- **Decision**: Memoize the catalog at module scope and return a fresh shallow copy per call, so a caller cannot mutate the cached record. A computation counter is exposed for tests.
- **Consequences**: `machineCatalog()` drops to **0.03 us** (~270x). The value shape is unchanged and the full suite passes 1,122 tests. Sandbox startup flags were A/B tested this turn and all rejected (invalid, slower or flat), so no isolation property was relaxed.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: read-only state vocabulary, no tuning change.

### ADR-210: Memoize the static suite and multistep summaries
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `/api/benchmarks/suite` rebuilt `suiteSummary()` over 277 prompts at **879 us** plus `multistepSummary()` at **62 us** on every poll.
- **Decision**: Cache each summary by the identity of its prompt/chain array, with computation counters exposed for tests. The default static arrays are computed once; a caller passing a different array still gets its own summary.
- **Consequences**: both builders drop to **0.03–0.04 us** (~20,000x). Three failing-first tests pin default reuse and custom-argument behavior. Summary values and shapes are unchanged.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check, suite version or hash changed — only reuse of the same computed summary.

### ADR-211: Prune stale sampling overrides on a cached scan
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Repeated gate runs exposed a pre-existing flake (~1 in 3) in `model-registry.test.js`: after a file was deleted outside the API, a full scan inside the 1 s directory-stamp TTL could return the cached listing and keep a per-model sampling override attached to a vanished model.
- **Decision**: On the cached-scan path, verify only the few override target paths with `fs.access` and delete overrides whose file is gone. The full scan's pruning logic and the 1 s scan cache stay unchanged; no assertion was loosened.
- **Consequences**: five consecutive full `npm test` runs passed (previously ~1 in 3 failed). Cost is one `access` per existing override, normally zero, so the cached `/api/state` path keeps its speed.
- **Cross-principle check:** PRINCIPLE-014: a new regression test pins the behavior and no assertion was weakened; G-001/G-003: registry bookkeeping only, no tuning or suite change.

### ADR-212: Probe saved profiles with one cached list instead of N failed reads
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `/api/recommendations` with 60 installed models measured **8.7 ms**: it called `loadProfile()` for every model even though most libraries have few or no saved profiles, paying a failing read each time.
- **Decision**: Use the already directory-stamp-cached `listProfiles()` to build the set of saved catalog ids, and call `loadProfile()` only for models in that set. Response shape and profile application are unchanged; a profile written during a request is visible on the next poll.
- **Consequences**: the same 60-model endpoint drops to **1.34 ms (~6.5x)**; a failing-first test pins zero profile reads for an unprofiled library while all 60 models are still recommended.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: read-only recommendation path, no tuning or suite change.

### ADR-213: Buffered line scan for the tune run summary
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `/api/tune/runs/:id` re-parsed every answer line through `readline` streaming. A controlled 7-round alternating A/B on 10k rows measured a **3.14 ms** median.
- **Decision**: Read the app-written, row-capped `answers.jsonl` once and scan it by newline index instead of streaming through `readline`. The two larger readers (`itemOutcomes`, `cachedAnswers`) keep streaming. Malformed/cut-off line handling, CRLF tolerance, nearest-rank percentiles and empty/missing-file behavior are unchanged.
- **Consequences**: the same summary loop drops to a **2.48 ms** median (**1.26x**). Three failing-first tests pin the read mode plus CRLF, truncated-line, unreadable-example, error/wrong counts and empty/missing-file equivalence.
- **Cross-principle check:** PRINCIPLE-010: the file is app-written and row-capped, and `cachedAnswers()` already reads it whole, so this is controlled input; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: read-only summary, no tuning or suite change.

### ADR-214: Cache the sorted public model list
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `listPublic()` rebuilt and re-sorted a 60-model public list on every call, and `/api/state` plus 15+ callers invoke it on each poll. A same-process A/B measured **21.37 us** for the rebuild.
- **Decision**: Build the public list once and return a shallow copy of it; invalidate it when `entries` is reassigned by a scan or a row is removed by `deleteById`. `scan()` already rebuilds it on its return path, so a normal scan keeps the cache warm.
- **Consequences**: a repeated `listPublic()` drops to **0.083 us (~258x)**. Two failing-first tests pin single rebuild, caller-tamper isolation and delete invalidation. Row values and sort order are unchanged.
- **Cross-principle check:** PRINCIPLE-009: no new module, tiny role; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: read-only model listing, no tuning or suite change.

### ADR-215: Probe saved profiles before loading them in /api/tune/overview
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `/api/tune/overview` called `profileFingerprint()` and `loadProfile()` for every one of 60 installed models even when the library had zero saved profiles. A controlled 5-round A/B measured a **4.36 ms** median.
- **Decision**: Use the directory-stamp-cached `listProfiles()` once per request to build the set of saved catalog ids, and call `loadProfile()` only for models in that set. Response shape and profile application are unchanged; a profile created during a request is visible on the next poll. Both readers skip the same invalid/corrupt files, so behavior matches on damaged profiles too.
- **Consequences**: the same 60-model endpoint drops to a **1.03 ms** median (**4.24x**). Two failing-first tests pin zero profile loads for an unprofiled library and full parity when a saved profile exists.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: read-only tune overview, no tuning or suite change.

### ADR-216: Buffer the two remaining tune-run JSONL readers
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `itemOutcomes()` and `cachedAnswers()` were the last large `answers.jsonl` readers still using `readline` streaming. A controlled 5-round A/B on 20k rows measured **11.90 ms** and **14.94 ms** medians.
- **Decision**: Read each app-written answers file once and scan it by newline index. `cachedAnswers()` keeps its `limitRows` cap via a labeled break, and the now-unused `node:readline` import was removed. One file is buffered at a time, so peak memory stays bounded.
- **Consequences**: medians drop to **9.53 ms (1.25x)** and **13.97 ms (1.07x)**; both were faster in all five rounds. Three failing-first tests pin read modes, saturation counts, CRLF/malformed/error rows, settings grouping, width filtering and the row cap. The `node:readline` dependency is no longer imported anywhere in this module.
- **Cross-principle check:** PRINCIPLE-010: app-written bounded files, one at a time; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: read-only tune-run analysis, no tuning or suite change.

### ADR-217: Memoize the judge cache key by argument identity
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, every `runJavaScriptTests` cache hit rebuilt its key by stringifying the whole check, including all 40 cases. A controlled 5-round A/B measured a **4.80 us** median per repeated hit.
- **Decision**: Keep a one-entry memo of the last `(text, check, timeoutMs)` triple by identity. An identity hit returns the previously built key; any different argument rebuilds it. Because comparison is by identity, a mutated check still gets a fresh key and logical dedup is unchanged.
- **Consequences**: the repeated-hit cost drops to a **0.78 us** median (**6.2x**). Two failing-first tests pin key reuse for identical arguments and fresh keys/verdicts for different text or checks.
- **Stability fix**: the recurring `model-registry.test.js` rescan flake (external add/delete inside the 1 s directory-stamp TTL) was repaired by using `scan({ force: true })` for the two rescans that test *rescan behavior*. No assertion was changed or weakened; three consecutive full runs passed.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests and a determinism fix, no assertion weakened; G-003: no prompt, check, suite version or hash changed.

### ADR-218: Single-pass multistep chain aggregation
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `summarizeChains()` rescanned the full results array once per step depth. A controlled 5-round A/B on 1000 chains × 5 steps measured a **160.64 us** median.
- **Decision**: Walk the results once, accumulating totals, all-steps, prefix, errors and per-step counts. Depth still comes from the longest chain, and a step index present in no chain still appears in `byStep` with zero totals. The prior two `allSteps` filters collapse into one counter.
- **Consequences**: the same aggregation drops to a **42.94 us** median (**3.74x**). Two failing-first tests pin the mode and exact field-by-field equivalence on irregular chains with sparse depths and errors; the existing multistep tests also pass.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no chain, check or hash changed — only the aggregation walk.

### ADR-219: Injectable clock for the receipt negative-cache TTL
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work across tests, `receipt-stat-first.test.js` spent a literal 600 ms sleeping to outlast the 500 ms negative-cache TTL. A controlled A/B measured a **685.4 ms** median for that test file.
- **Decision**: `readInstallReceipt()` accepts optional `clock` and `ttlMs` options, defaulting to `Date.now` and the production TTL. Tests inject a controllable clock, so the same cache-hit-then-expiry behavior is verified deterministically without a real-time wait. Production calls are unchanged.
- **Consequences**: the test file drops to a **72.2 ms** median (**613 ms saved**, ~7.5% of a full suite run). The existing assertions and the new failing-first clock test are unchanged in meaning; both still check that a cached miss is served inside the TTL and an external write becomes visible after it.
- **Cross-principle check:** PRINCIPLE-014: a test-speed change that alters no assertion's meaning and touches only the test's timing setup plus an optional test seam; G-001/G-003: no production behavior, tuning or suite change.

### ADR-220: Reuse verdict objects on a judge cache hit
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, every `runJavaScriptTests` cache hit cloned every stored verdict object before returning, even though all callers only read `passed`, `detail` and `unreadable`.
- **Decision**: Return a shallow slice of the cached array. A fresh array still protects the cache's case list from a caller that pushes or pops, while the read-only verdict objects are shared. The one-time clones at cache insertion remain, so the first (uncached) result stays isolated too.
- **Consequences**: a 40-case hit drops from a **0.76 us** to a **0.17 us** median (**4.47x**) in a 5-round controlled A/B. Two failing-first tests pin object reuse between hits and array-level isolation. A `spawn`-vs-`execFile` A/B and a temp-file-entry A/B were also run this pass and rejected: `execFile` is faster under controlled load, and the temp-file variant was noisy with no reliable gain, so the sandbox was left unchanged.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check, suite version or hash changed.

### ADR-221: Memoize the default sandbox environment
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `sandboxEnv()` rebuilt the neutral child environment on every uncached judge, scanning every variable in `process.env` with a `toLowerCase` search. A controlled 5-round A/B measured a **27.45 us** median.
- **Decision**: Cache the result for the default `process.env`/`process.platform` arguments, which are stable for the life of the process, and return a fresh shallow copy to each caller. Custom arguments still build a fresh value. The child gets the same neutral env, so isolation is unchanged.
- **Consequences**: the helper drops to a **0.07 us** median (**392x**). Two failing-first tests pin single construction, value equality, fresh-object return and custom-argument behavior; all sandbox-hardening tests pass.
- **Warm-child pool rejected this pass**: a feasibility probe showed a child pre-started ~400 ms ahead runs a judge in ~16.7 ms vs ~50 ms cold, but the benefit requires module-load spawning plus a custom reimplementation of `execFile`'s timeout, maxBuffer and error semantics in a security-critical path, and cannot be A/B'd end-to-end without a full tune run (forbidden). The sandbox process model was left unchanged.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: child environment values unchanged, no tuning or suite change.

### ADR-222: Deduplicate answer-candidate places before regex work
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `answerCandidates()` examined the whole reply, its first line and its last line separately; for the common single-line answer these are the same string, so each regex and normalization ran three times.
- **Decision**: Deduplicate the raw places with a `Set` before the loop. `normalizeAnswer` is pure, so duplicate inputs produced duplicate outputs that were already deduplicated later; the normalized candidate set is identical.
- **Consequences**: `evaluateTextCheck` drops from **2.64 us to 1.55 us** for exact checks (**1.70x**) and **3.16 us to 2.19 us** for eight-value oneOf checks (**1.44x**). Two failing-first tests pin one place for a single-line reply and unchanged exact/oneOf verdicts including multi-line replies.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-223: Skip fence stripping for already-plain answer candidates
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Continuing the speed work, `answerCandidates()` normalized its candidate strings with `normalizeAnswer()`, which re-ran the code-fence regex and trim even though `plainText()` had already removed any fence.
- **Decision**: Add an internal `normalizePlain()` for those candidates, keeping `normalizeAnswer()` for check values that may legitimately be fenced. A fence-strip counter is exposed for tests.
- **Consequences**: a controlled 7-round A/B on `evaluateTextCheck` showed exact checks dropping from **1.39 us to 1.32 us** and eight-value oneOf from **1.92 us to 1.88 us** — small but faster in 5/7 and 6/7 rounds respectively. Two failing-first tests pin that candidates skip the fence regex and that fenced/plain verdicts stay identical.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-224: Manual two-phase plain normalization
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A CPU profile of judge-heavy work showed `answerCandidates()` and `normalizePlain()` as the top in-process functions. The latter ran two regex engines and a trim for every candidate.
- **Decision**: Replace the regex chain with char-code loops that preserve the exact two-phase order: strip edge quotes, then trailing `.`/`!`, then trim whitespace. A naive combined character class was rejected because it differs on inputs like `'"foo"!!"'`.
- **Consequences**: a controlled 9-round A/B on `evaluateTextCheck` showed exact checks improving from **1.57 us to 1.40 us** and eight-value oneOf from **2.27 us to 2.05 us**; the helper itself is **3.62x** faster. Two failing-first tests pin the mode and byte-identical output across 22 edge cases including quote/punctuation ordering.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-225: Skip line splitting for single-line answers
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A repeated CPU profile still showed `answerCandidates()` as the top in-process judge function. Most replies contain no newline, yet every one paid a `split(/\n+/)`, a `map(trim)` and a `filter`.
- **Decision**: When the plain reply has no newline it is its own single line, so use `[plain]` directly. Multi-line replies keep the original split. A line-split counter is exposed for tests.
- **Consequences**: a controlled 9-round A/B on `evaluateTextCheck` showed exact checks improving from **1.35 us to 1.21 us** and eight-value oneOf from **2.02 us to 1.89 us**, faster in 9/9 rounds for both. Two failing-first tests pin the split behavior and unchanged verdicts for single- and multi-line replies.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-226: One place for single-line answers
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A repeated CPU profile still showed `answerCandidates()` as the top in-process judge function. Even after skipping the line split, a single-line reply still went through the generic `Set` construction, an `answer` regex filter and two array allocations, even though all raw places are the same string.
- **Decision**: For a newline-free reply, set `places = [plain]` directly. Multi-line replies keep the original dedup/filter path. A place-construction counter is exposed for tests.
- **Consequences**: an isolated 7-round A/B showed the candidate pipeline improving **1.38x** with identical output; the controlled end-to-end A/B showed exact checks dropping from **1.25 us to 0.78 us** while the unrelated `choice` path stayed flat. Two failing-first tests pin the path selection and unchanged verdicts.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-227: Short-circuit bare-answer candidate construction
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: `answerCandidates()` remained the top in-process judge function. A bare answer such as "42" still built a Set, ran a colon regex and spread an array even though no lead-in, label or sentence applied.
- **Decision**: When there is exactly one place and neither a lead-in change, a label nor an "is/was/are" sentence, return the single normalized string directly. A shortcut counter is exposed for tests.
- **Consequences**: an isolated 7-round A/B on the candidate loop showed **1.31x** with identical output over 13 shapes including uppercase lead-ins; the end-to-end median improved from **0.72 us to 0.66 us** on a noisy host. The first implementation returned on the first place of multi-line replies and broke three existing verdict tests; it was corrected with a `places.length === 1` guard before shipping.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests plus three pre-existing regression tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-228: Guard the thousands-separator regex
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A CPU profile showed `givenNumber()` among the remaining judge helpers. It ran a `(\d),(?=\d{3}\b)` replace on every reply even when the reply contained no comma.
- **Decision**: Only run the replace when `plain.includes(",")`. A separator counter is exposed for tests. An alternative that also replaced `[...matchAll()].at(-1)` with a `for...of` loop was measured **2x slower** (V8 optimizes the spread form far better) and was rejected.
- **Consequences**: number checks drop from a **0.58 us** to a **0.49 us** median, faster in 8/9 controlled rounds; the separator step alone is **1.42x** faster. Two failing-first tests pin the guard and unchanged number verdicts with and without separators.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-229: Cache normalized expected check values
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A CPU profile showed `normalizeAnswer()` repeatedly processing the same static expected values from exact and oneOf checks on every answer.
- **Decision**: Cache the normalized form by the expected string, which is immutable. The cache is bounded at 4096 entries; candidate normalization still uses `normalizePlain()` and is unchanged. Two other ideas were rejected this pass: guarding `plainText`'s emphasis regex was slower, and guarding its list-marker regex with safe line-terminator detection was also slower (a naive `\n`-only guard was found to change behavior for `\r`/`\u2028` inputs and was discarded).
- **Consequences**: the isolated helper improves **9.58x**; controlled end-to-end A/B shows exact checks dropping from **0.57 us to 0.49 us**, faster in 9/9 rounds, with the `choice` control flat. Two failing-first tests pin single normalization per value and unchanged verdicts.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or expected value changed.

### ADR-230: Cache the static setting-name list
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Several tune API routes and the CLI call `settingNames()`, which rebuilt a fixed 16-name list from deep-frozen definitions at **13.03 us** per call.
- **Decision**: Build the list once on first use and return a slice to callers. `DEFAULT_STEPS` and the axis definitions are deep-frozen, so the result cannot change during a run.
- **Consequences**: the helper drops to **0.03 us** per call (~434x). Two failing-first tests pin single construction, stage order, content and caller-mutation isolation. An initial test that guessed non-existent names was corrected to assert the real static list.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no tune step, axis or setting changed.

### ADR-231: Memoize the public catalog view
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: `publicCatalog()` rebuilt a 9-model array with derived homepage strings on every `/api/state`, `/api/recommendations` and tune request, at **0.29 us** per call.
- **Decision**: Build the derived view once from the static `MODEL_CATALOG` constant and return a fresh array slice to callers. All callers were checked to only read the rows.
- **Consequences**: the helper drops to **0.02 us** (~15x). Two failing-first tests pin single construction, value/order preservation and array-level caller isolation.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no catalog entry or homepage changed.

### ADR-232: Memoize the setting presets view
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: `/api/state` called `settingPresets()` on every request, which rebuilt preset objects with nested settings copies from a module constant at **0.24 us** per call.
- **Decision**: Build the preset view once and return a fresh array slice. Callers only read the preset rows.
- **Consequences**: the helper drops to **0.02 us** (~12x). Two failing-first tests pin single construction, content and array-level caller isolation.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no preset value changed.

### ADR-233: Cache tune slot and cap-family keys by settings identity
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: `Measurements.measure()` is called once per item with the same settings object for a whole rung, and each call re-stringified that object to build its slot key and cap-family key (~1 us each).
- **Decision**: Cache both key builders in `WeakMap`s keyed by the settings object and the seed. The existing `slots` Map already treats settings objects as stable measurement keys, so identity caching matches that contract.
- **Consequences**: `slotKeyOf()` and `capFreeKeyOf()` drop from **1.05 / 1.11 us to 0.03 us** (~35x). Two failing-first tests pin single construction, seed inclusion and distinct-settings isolation.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no tune grid, axis or decision rule changed.

### ADR-234: Cache profile ids by filename
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: `profileIdFor()` rescanned the 9-model catalog and ran a regex chain per model on `/api/models`, `/api/recommendations` and `/api/tune/overview`, at **0.44 us** per call.
- **Decision**: Cache the derived id by the immutable filename string in a bounded 4096-entry Map. The catalog is a module constant.
- **Consequences**: the helper drops to **0.01 us** (~44x). Two failing-first tests pin single computation and identical ids for catalog models and hand-imported names.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no profile id or catalog mapping changed.

### ADR-235: Element-wise comparison for tune step arrays
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Three tune-grid equality checks compared dense string arrays by stringifying both sides with `JSON.stringify`, allocating four strings per check. The isolated comparison is **20x** slower than element-wise equality.
- **Decision**: Add `sameStringArray()` and use it in `systemPromptOptIn()` and `promptAxes()`. The two stringify calls that build dedupe/message strings remain unchanged.
- **Consequences**: `promptAxes()` drops from **4.71 us to 2.36 us** (~2x). Two failing-first tests pin the comparison mode and equivalence with the stringify result over equal, different, empty and quoted-array cases.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no tune step, axis or prompt value changed.

### ADR-236: Rejected history, encoding and fit-text micro-variants
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A continued profiling pass examined the remaining app hot spots after the recent caching wins: `parseHistory()` on the 6.75 MB `history.jsonl`, `sendJson()`'s payload encoding, and `fitText()`'s per-call lookup object.
- **Decision**: No code change. Three controlled A/Bs rejected the candidate variants:
  - Replacing `parseHistory()`'s `split("\n")` with an index scan: **16.7 ms → 17.9 ms (0.93x)** on the real file, identical parsed runs/links.
  - Replacing `sendJson()`'s `Buffer.byteLength(payload)` + string `res.end` with `Buffer.from(payload)` + `res.end(buffer)`: **13.04 us → 22.35 us (0.58x)**, identical bytes. V8 optimizes the current string path.
  - Hoisting `fitText()`'s lookup object to module scope: **0.004 us both ways** — escape analysis already removes the allocation.
- **Consequences**: all three paths were left untouched. Earlier profile flags `parseHistory` (~20 ms) are a one-time cost after a file stamp change; the report cache keeps later requests fast.
- **Cross-principle check:** PRINCIPLE-014: A/B-tested alternatives with identical outputs; no assertion weakened, no regression shipped.

### ADR-237: Skip GGUF magic re-reads for cached models
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A forced rescan of 200 models took **59.3 ms** because every file was reopened to read its four-byte magic header even when the metadata cache already held a summary keyed by `(path, size, mtime)`.
- **Decision**: Compute the cache key from the stat result first. If a summary is cached, trust that this exact file already passed the header guard and skip `hasGgufMagic()`. Uncached and non-GGUF files are still checked on every scan.
- **Consequences**: a cached forced rescan drops from **59.3 ms to 12.5 ms**; a controlled 5-round A/B measured **34.5 ms → 14.2 ms (2.43x)**. Two failing-first tests pin that cached rescans skip header reads and non-GGUF files are still rejected.
- **Cross-principle check:** PRINCIPLE-003: trust is keyed on size+mtime, the same assumption the metadata cache already makes; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: no model listing or registry contract changed.

### ADR-238: Parallelize registry scan stats
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: After skipping cached magic re-reads, a first scan of 200 models still paid ~12 ms for 200 sequential `stat` calls (measured 11.7 ms sequential vs 2.0 ms parallel in isolation).
- **Decision**: Gather all file stats with one `Promise.all` before the per-file loop, indexing results by position so insertion order is unchanged. Per-file stat failures still skip that file. Metadata reading stays sequential.
- **Consequences**: a first scan of 200 models drops from **63.4 ms to 5.9 ms**; a controlled 5-round A/B measured **14.1 ms → 4.3 ms (3.28x)**. Two failing-first tests pin the mode and that valid models are still listed in sorted order while bad/tiny/non-GGUF files are skipped.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only syscalls; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: no registry contract changed.

### ADR-239: Parallelize uncached magic-header checks in the scan
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: After parallelizing stats, the first scan of 200 models still took **47.7 ms** because the four-byte GGUF header of each uncached file was read sequentially (~25 ms for 200 files).
- **Decision**: Compute all cache keys from the already-parallel stats, then check every uncached header with one `Promise.all`, storing results by position. Cached files keep skipping the read. Metadata reading stays sequential.
- **Consequences**: a first scan of 200 models drops from **47.7 ms to 9.5 ms**; a controlled 5-round A/B measured **40.2 ms → 11.0 ms (3.65x)**. Three failing-first tests pin the mode, that all headers are checked on a first scan, and that cached rescans skip them.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only four-byte reads; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: no registry contract changed.

### ADR-240: Rejected sentence-regex guard
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A CPU profile still showed `answerCandidates()` as the top in-process judge function, with a backtracking sentence regex running on every answer. An isolated A/B of a cheap `\s(?:is|was|are)\s` guard showed **1.12x** on short answers.
- **Decision**: Rejected and fully reverted. A controlled 9-round end-to-end A/B on a realistic answer ("The answer is 42 and option B.") showed the guard **regressed** exact checks from **0.82 us to 0.90 us**, slower in 8/9 rounds: the answer contains " is ", so the guard ran *in addition to* the original regex instead of replacing it. The isolated win came from a test distribution dominated by short answers that lacked the pattern.
- **Consequences**: `benchmarks/suite.mjs` is byte-identical to HEAD; no production change shipped. This is why end-to-end A/B is required before shipping, not just isolated helper timings.
- **Cross-principle check:** PRINCIPLE-014: regression reverted, no assertion weakened; the objective's "reverse anything that worsens speed" was applied.

### ADR-241: Exec loop for the chosen-letter regex
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A CPU profile flagged the `chosenLetter` regex: `[...plain.matchAll(re)].at(-1)` spread every match into an array just to read the last one.
- **Decision**: Reuse one module-level global regex and iterate with `exec`, keeping the last capture; reset `lastIndex` before each call. A zero-length match guard prevents an infinite loop.
- **Consequences**: isolated helper A/B was **6.4x**; the controlled 9-round end-to-end A/B on a realistic choice answer showed **0.75 us → 0.56 us**, faster in 9/9 rounds, while the unrelated exact path stayed flat (noise only). Two failing-first tests (confirmed against HEAD) pin the single scan and identical verdicts across 12 label shapes including multiple named letters.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no check or verdict changed.

### ADR-242: Exec loops for the number-check regexes
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: A CPU profile flagged `givenNumber()`, whose two `[...matchAll()].at(-1)` spreads allocated arrays of every match just to read the last one.
- **Decision**: Add a shared `lastMatch()` helper using reusable module-level global regexes with `lastIndex` reset and a zero-length guard; use it for both the "answer is N" and the fallback "last number" scans.
- **Consequences**: isolated helper A/B was **3.6x**; the controlled 9-round end-to-end A/B showed the number check dropping from **0.60 us to 0.30 us**, faster in 9/9 rounds, with the exact control flat. Two failing-first tests (confirmed against HEAD) pin the single scan and identical verdicts across 8 answer shapes.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no check or verdict changed.

### ADR-243: Subset-sum recurrence for exact sign-flip tests
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: The exact sign-flip p-value path enumerated 2²⁰ masks with an `O(count)` inner loop, costing **64.4 ms** for 20 differences in a tune gate.
- **Decision**: Add `exactSignedSums()` using the low-bit recurrence `sums[mask] = sums[mask ^ low] + value[bit]`, so each signed subset sum is `2*sums[mask] - total`. Both `signFlipPValue` and `signFlipOneSided` use it.
- **Consequences**: **64.4 ms → 5.0 ms (13x)**. P-values were checked identical against the direct enumeration over 200 randomized inputs before shipping; a failing-first counter test (confirmed against HEAD) pins one operation per mask, plus two p-value equivalence tests.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no statistic or threshold changed.

### ADR-244: Incremental log-binomial for McNemar tails
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: `mcnemarExact` and `mcnemarOneSided` called `logChoose(n, index)` from scratch for every index, each an O(k) loop — O(k²) overall; k=300 cost **526 us**.
- **Decision**: Add `binomialTailLog()` that updates `log C(n, i)` from the previous value with one log add/subtract per step, O(k) total. Both McNemar functions use it; the now-unused `logChoose` was removed.
- **Consequences**: **526 us → 6.7 us (~78x)**. P-values match the direct sum within 1e-12 (float addition order differs by ~3e-16); existing `toFixed(4)`/`close()` assertions are unaffected. A failing-first counter test pins one log step per index, plus equivalence over 7 discordant-pair shapes.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no statistic or threshold changed.

### ADR-245: Inline the seeded LCG in Monte Carlo sign flips
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: With more than 20 differences, `signFlipPValue`/`signFlipOneSided` drew 10,000×N signs through a closure that divided the LCG state by 2³² on every call.
- **Decision**: Inline the LCG into the draw loop and use the exact equivalent test `state < 0x80000000` for `random() < 0.5`. The state sequence and every sign choice remain identical.
- **Consequences**: a controlled 5-round end-to-end A/B measured **15.89 ms → 7.24 ms (2.19x)**; a failing-first draw-counter test (confirmed against HEAD) and an exact p-value equivalence test against the seeded reference both pass.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no statistic or threshold changed.

### ADR-246: Map lookup for smoke-item comparison in recommendations
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: The speed-tuning branch of `recommend()` did a `.some()` plus `.find()` scan over variant prompts for every base prompt — O(n²) across ~300 smoke items.
- **Decision**: Build one `Map` of variant prompts by id and use `has`/`get` per base prompt, O(n) total.
- **Consequences**: isolated comparison was **5.3x**; a controlled 5-round end-to-end A/B on `recommend()` measured **208.7 us → 32.4 us (6.44x)**. Two failing-first tests (confirmed against HEAD) pin the single map build and that a variant losing a base item is still rejected.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no recommendation logic or verdict changed.

### ADR-247: In-process syntax short-circuit for judge answers
- **Date**: 2026-11-23
- **Status**: Accepted
- **Context**: Prose or malformed-code answers still spawned a sandboxed child that immediately failed to parse the script — every case reported "did not run", a verdict fully determined before any process starts.
- **Decision**: Before spawning, parse the exact embedded code with `new Script()` in-process (the same V8 the child uses). On a parse failure, return the deterministic per-case "did not run" verdict directly, with the same `unreadable = !named` and the same cache insertion. Valid code keeps the child path; no isolation property changes because no code is executed.
- **Consequences**: a controlled 5-round end-to-end A/B on a mixed workload (80% syntax-error answers) measured **2201.8 ms → 230.2 ms (9.6x)**. Verdicts were verified byte-identical over 7 syntax-error shapes before shipping; a failing-first counter test plus exact-verdict tests pin the shortcut and that valid code still spawns.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or verdict changed; no code from a failing answer is ever executed in-process.

### ADR-248: In-process no-entry short-circuit for judge answers
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: After the syntax short-circuit, valid code that defines some other function still spawned a child only to report the deterministic "function not found" verdict for every case.
- **Decision**: When the check has no setup or harness, the parsed code contains no occurrence of the entry name, and no dynamic-definition construct (`eval`/`Function`/`globalThis`/`window`/`this`) appears, return the deterministic "function not found" verdict in-process with the same cache insertion. All other answers keep the child path.
- **Consequences**: a controlled 5-round end-to-end A/B on a mixed workload measured **1639.8 ms → 264.3 ms (6.2x)**. Verdicts were verified byte-identical, and failing-first tests (confirmed against HEAD) pin the shortcut, its guards and that valid code still spawns.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no prompt, check or verdict changed; no answer code is executed in-process.

### ADR-249: Direct initialization for score's zeroed maps
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `score()` built its `fractions` and `credit` maps with `new Map(ids.map(id => [id, 0]))`, allocating an intermediate pair array for each on every tuning rung.
- **Decision**: A `zeroed()` helper fills the two maps directly. The other five per-item maps stay empty as before — an initial attempt to zero them too changed the result shape and failed six existing tests, and was corrected before shipping.
- **Consequences**: the two-map init drops from **6.16 us to 3.42 us (1.8x)**. A failing-first counter test (confirmed against HEAD) pins two builds and that the other maps stay empty.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no statistic or result shape changed.

### ADR-250: Memoize judge output limits by case array
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `outputLimit()` re-stringified every expected value on each judge miss even though the case arrays are static per check.
- **Decision**: Cache the byte limit in a `WeakMap` keyed by the cases array; new arrays get their own entry.
- **Consequences**: the helper drops from **2.368 us to 0.011 us (215x)**. The absolute saving per judge is small next to the spawn, but the change is safe and behavior-preserving. A failing-first counter test (confirmed against HEAD) pins one computation per case array.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no check or byte limit changed.

### ADR-251: Blank-line check without per-line trim in history parsing
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `parseHistory()` called `.trim()` on every line of a 6.75 MB history file just to detect blank lines, copying ~50 KB per line.
- **Decision**: Detect empty and lone-CR lines by length/charCode; any other whitespace-only line is still rejected by the existing `JSON.parse` try/catch.
- **Consequences**: parsing the real file drops from **21.3 ms to 16.5 ms (1.29x)** with identical runs and links. Two failing-first tests (confirmed against HEAD) pin the trim avoidance and result equivalence across blank lines.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no report value changed.

### ADR-252: Memoize receipt paths by (dir, name)
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: A CPU profile of 60-model routes showed `receiptPath()` and `path.join` repeatedly deriving the same paths on every state and models request.
- **Decision**: A two-level `Map` (dir -> name -> path) caches the pure derivation, bounded at 4096 names per dir.
- **Consequences**: 60 repeated lookups drop from **45.45 us to 0.58 us (78x)** with identical paths. A failing-first counter test (confirmed against HEAD) pins one derivation per (dir, name) and correct nested/plain names.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: no receipt lookup or invalidation semantics changed.

### ADR-253: Direct loop for per-answer settings selection
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `pick()` in the tune evaluator used `Object.fromEntries(keys.filter(...).map(...))`, allocating two intermediate arrays per answer.
- **Decision**: A direct `for` loop fills the object, and `pick` is exported with a computation counter for tests.
- **Consequences**: **0.536 us → 0.243 us (2.2x)** with identical keys and values. A failing-first equivalence test (confirmed against HEAD) pins the output.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-003: no sampling setting or answer changed.

### ADR-254: Direct loop for appended answer rows
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: Each answer batch built its JSONL text with `rows.map(...).join("")`, allocating an intermediate string array.
- **Decision**: A shared `serializeAnswerRows()` fills one string directly; writes remain serialized by the existing queue.
- **Consequences**: **23.046 us → 17.617 us (1.31x)** per 100 rows with byte-identical output. Two failing-first tests (confirmed against HEAD) pin the mode and exact bytes.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: answer records unchanged.

### ADR-255: Memoize plainText by reply string
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `plainText()` re-stripped fences and ran two regexes on every text check and on repeated answers across load variants.
- **Decision**: A bounded 4096-entry `Map` caches the cleaned text by the immutable reply string.
- **Consequences**: five repeated cleanings drop from **0.84 us to 0.14 us (6x)** with identical output. Two failing-first tests (confirmed against HEAD) pin the single computation and unchanged verdicts.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no check or verdict changed.

### ADR-256: Memoize answer candidates by reply string
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `answerCandidates()` is a pure function of the reply text, but it was recomputed for each text check on the same answer and across load variants that reproduce the same greedy text.
- **Decision**: A bounded 4096-entry `Map` caches the candidate array by the immutable reply string.
- **Consequences**: a controlled 5-round end-to-end A/B on two text checks over the same reply measured **2.198 us → 0.213 us (10.32x)** with identical verdicts. Two failing-first tests (confirmed against HEAD) pin the single computation and unchanged verdicts.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: no check or verdict changed.

### ADR-257: Direct validation in kvShapeFromMetadata
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `kvShapeFromMetadata()` allocated a shape object plus an `Object.values` array just to validate three numbers on every model scanned.
- **Decision**: Validate `layers`, `kvHeads` and `headDim` directly and construct the shape object only on success.
- **Consequences**: **0.075 us → 0.017 us (4.4x)** with identical shapes or null. A failing-first equivalence test (confirmed against HEAD) covers six metadata shapes.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-003: no model summary changed.

### ADR-258: Parallel run-summary reads in listRuns
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `/api/tune/runs` read dozens of small run-summary files one at a time; 50 files cost **5.42 ms**.
- **Decision**: Gather all summary reads with one `Promise.all`, preserving positional order; per-file quiet error handling and the liveness cache are unchanged.
- **Consequences**: the same 50 reads drop to **1.77 ms (3x)** with identical run order. A failing-first test (confirmed against HEAD) pins count, order and repeat listing.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only file reads; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: no run data changed.

### ADR-259: Parallel profile parses in listProfiles
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `listProfiles()` stat'ed files in parallel for the stamp but parsed them one at a time on every cache miss; 40 profiles cost **3.39 ms**.
- **Decision**: Parse all profile files with one `Promise.all`; order and schema filtering are unchanged.
- **Consequences**: the same 40 parses drop to **0.96 ms (3.5x)** with identical summaries. A failing-first test (confirmed against HEAD) pins sorted order, schema filtering and stamp invalidation.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only parses; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: no profile data changed.

### ADR-260: Parallel run-summary reads in tune restore
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `cachedAnswers()` and `itemOutcomes()` read every run summary file sequentially before selecting runs; 30 files cost **3.13 ms**.
- **Decision**: A shared `readRunSummaries()` helper gathers all JSON summaries with one `Promise.all` in name order. An initial edit dropped the `name` binding in `itemOutcomes` and silently skipped all answers; caught by a new test and fixed before shipping.
- **Consequences**: the same 30 reads drop to **0.75 ms (4.2x)** with identical selected runs. A failing-first test (confirmed against HEAD) pins read counts and restore equivalence.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only reads; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: no answer data changed.

### ADR-261: Parallel answer-file reads in itemOutcomes
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `itemOutcomes()` read every qualifying answer file one at a time; 20 files cost **3.43 ms** on the read portion.
- **Decision**: Collect qualifying files, read them all with one `Promise.all`, then count sequentially in the original file order. ENOENT is still skipped and a real read error still throws at the same logical point.
- **Consequences**: read portion **3.43 ms → 1.64 ms (2.1x)**; controlled end-to-end A/B over 20 files x 500 rows measured **~7.3–8.3 ms → ~5.8 ms (~1.3x)** with an identical SHA-256 of the full result. A failing-first test (confirmed against HEAD) pins read count, counts and saturation.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only reads; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: no outcome data changed.

### ADR-262: Parallel answer-file reads in cachedAnswers
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `cachedAnswers()` read its newest run answer files one at a time; with the default three runs the read portion cost **0.47 ms**.
- **Decision**: Resolve the `limitRuns` file paths, read them all with one `Promise.all`, then scan in the original newest-first order so grouping, the `limitRows` early break, the `otherTuner` width filter and ENOENT/error handling are unchanged.
- **Consequences**: 3-file reads **0.47 ms → 0.31 ms (1.5x)**; controlled end-to-end A/B over five call configurations measured **~1.33–1.60 ms → ~1.11–1.16 ms (~1.2–1.3x)** with an identical SHA-256 (`e462f484aace`). A failing-first test (confirmed against HEAD) pins read count, newest-first order and the row cap.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only reads; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: no answer data changed.

### ADR-263: Stat-first directory stamp in registry scan
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `scan()` called `ensureDirectory()` (a `mkdir -r`) before every TTL stamp check. On an existing folder `mkdir -r` costs ~135 us here, so every `/api/state` poll paid for a redundant syscall.
- **Decision**: `dirStamp()` now stats first and only calls `ensureDirectory()` when stat reports ENOENT (or the path is not a folder, preserving the old failure). The unconditional `ensureDirectory()` at scan start is removed. `scanStats()` gains a `mkdirs` counter.
- **Consequences**: isolated stamp **182 us → 47 us (3.9x)**; controlled A/B on repeated cached `scan()` with 60 models measured **180.67 us → 42.96 us (4.2x)**. A stable projection of the `/api/state` models array hashes identically (`a99679780a5f`) before and after. Two failing-first tests (confirmed against HEAD) pin no-mkdir on an existing folder and recreation of a removed one.
- **Cross-principle check:** PRINCIPLE-013: durable state behaviour unchanged; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: model summaries unchanged.

### ADR-264: Parallel directory reads in walkGgufFiles
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: Model discovery recursed into each subdirectory one at a time; a 100-file nested library cost **2.56 ms** on the traversal portion.
- **Decision**: Classify visible entries once with the original branch conditions, read all sibling directories and check all extensionless symlinks concurrently, then assemble `found` in the same depth-first readdir order.
- **Consequences**: isolated traversal **2.56 ms → 0.61 ms (4.2x)**; controlled A/B over a 60-file nested tree measured **3.27 ms → 1.57 ms (~2.1x)** with an identical SHA-256 (`fdf29d4b3ba0`) of the full `readMetadata` call order. A failing-first test (confirmed against HEAD) pins concurrent sibling reads.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only readdirs; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: discovered file list and order unchanged.

### ADR-265: Reverse scan in historySummary
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `historySummary()` filtered, sliced and mapped every run in a multi-MB history just to show the newest eight; 5000 runs cost **33.51 us**.
- **Decision**: Walk `runs` backwards and stop once `limit` phased runs are collected, producing the same newest-first array. The pure function is exported as a test seam.
- **Consequences**: isolated **33.51 us → 0.31 us (108x)**; controlled end-to-end A/B over `summarizeBenchmark` with 5000 runs measured **135 us → 81 us (~1.7x)** with an identical SHA-256 (`559047a742c9`). Two failing-first tests (confirmed against HEAD, including a HEAD-body-plus-export variant) pin order and the absent end-to-end filter.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: report summary unchanged.

### ADR-266: Backward scan in latestCommit
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `latestCommit()` built a `matches` array of every qualifying run once per report phase, then scanned it a second time; 5000 runs cost **19.46 us** per lookup.
- **Decision**: Walk `runs` backwards once and return the first matching run that carries a commit. The pure function is exported as a test seam.
- **Consequences**: isolated **19.46 us → 0.105 us (185x)**; controlled end-to-end A/B over `summarizeBenchmark` with 5000 runs measured **118–125 us → 4.4–5.3 us (~25x)** with an identical SHA-256 (`559047a742c9`). Two failing-first tests (confirmed against HEAD, including a HEAD-body-plus-export variant) pin commit selection across 12 phase/hash combinations and the absent end-to-end filter.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: report summary unchanged.

### ADR-267: Lazy derivation and linear max in summarizePhase
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `summarizePhase()` sorted the whole model array to read its fastest entry, and derived per-category/origin/dataset summaries from every prompt even when all three breakdowns were already in the report; 200 models cost **14.07 us** per phase.
- **Decision**: Find the representative with one strict-`>` pass (stable-sort tie behaviour preserved) and derive breakdowns lazily only for fields that are actually nullish. The pure function is exported as a test seam.
- **Consequences**: isolated **14.07 us → 0.55 us (25x)**; controlled end-to-end A/B over two 100-model phases measured **31.5 us → 3.05 us (~10x)** with an identical SHA-256 (`db16ee82f8ca`). Two failing-first tests (confirmed against HEAD, including a HEAD-body-plus-export variant) pin breakdown selection, first-max ties and the absent sort/derivation.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: report summary unchanged.

### ADR-268: Parallel profile loads in tune routes
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `/api/tune/overview` and `/api/recommendations` awaited `loadProfile()` once per profiled model; 60 saved profiles cost **14.31 ms** on the isolated load loop.
- **Decision**: Gather all per-model profile loads with one `Promise.all`, then build the response in the original model order. Read counters and response key order are preserved.
- **Consequences**: isolated loads **14.31 ms → 1.73 ms (8.3x)**; controlled end-to-end A/B over both routes with 60 profiles measured **~12–14 ms → ~4–5 ms (~2.5–3x)** with an identical SHA-256 (`8a3e7486bd27`). A failing-first test (confirmed against HEAD) observes overlapping profile content reads. An earlier concurrency test using all stats was rejected because the scan's parallel stats masked the sequential profile loop.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only loads; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: route responses unchanged.

### ADR-269: Deferred explanation strings in recommendCatalog
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `recommendCatalog()` built a verbose `why` string for every catalog entry, then returned only the top five; 200 entries cost **26–30 us**.
- **Decision**: Each candidate row carries a temporary `_evidence` reference through filter/sort; after `.slice(0, limit)` the string is built for the shown rows only and the temporary key is deleted. A first attempt using a `WeakMap` was **slower** (120 `set` calls per invocation) and was replaced before shipping.
- **Consequences**: controlled end-to-end A/B measured **26–30 us → 17 us (~1.6x)** with an identical SHA-256 (`df2cdb46b19e`) and identical object key order. A failing-first test (confirmed against HEAD) counts 120 → 5 string interpolations.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: recommendation rows unchanged.

### ADR-270: Deferred explanation strings in recommendModels
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `recommendModels()` built an explanation string for every installed model but returned only the top five; 100 models cost **53 us**.
- **Decision**: Rows carry a temporary `_hasProfile` flag through filter/sort; the explanation is built for the shown rows only and the temporary key is deleted. A `why: null` placeholder keeps the original key order.
- **Consequences**: controlled end-to-end A/B measured **53–54 us → 35–39 us (~1.4x)** with an identical SHA-256 (`2dd6d3c0fc2c`). A failing-first test (confirmed against HEAD) counts 200 → 105 task interpolations (100 profile-key lookups in both, plus five vs one hundred explanations).
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: recommendation rows unchanged.

### ADR-271: Single-task type warnings in settings resolution
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `TunedSettings.resolve()` computed `typeWarnings(profile)` for every task but indexed only the selected one; a 12-task profile cost **7.4 us** per lookup.
- **Decision**: `typeWarnings(profile, onlyTask)` accepts an optional task filter; `resolve()` passes its selected task. The unfiltered call path is unchanged.
- **Consequences**: isolated lookup **7.4 us → ~1 us (~7x)**; controlled A/B on the full `resolve()` measured **113–122 us → 107–112 us (~1.05x)** because profile loading dominates, with an identical SHA-256 (`9c88c5f1c892`). A failing-first test (confirmed against HEAD) counts 12 → 1 task-statistics reads.
- **Cross-principle check:** PRINCIPLE-014: failing-first test, no assertion weakened; G-003: chat settings and warning labels unchanged.

### ADR-272: Number accumulation in parameterCount
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `parameterCount()` multiplied every GGUF tensor dimension as BigInt on every cold model scan; a 400-tensor header cost **33.77 us** in the counter alone.
- **Decision**: Accumulate in Number and convert once, falling back to the exact BigInt loop for non-safe-integer, negative or overflow-vulnerable inputs. The function is exported as a test seam.
- **Consequences**: isolated counter **33.77 us → 13.28 us (2.5x)**; a cold scan of one 400-tensor model **425 us → 274 us (~1.55x)**; controlled end-to-end A/B over three shapes (including MAX_SAFE_INTEGER overflow) kept an identical SHA-256 (`7df181291934`). Two failing-first tests (confirmed against HEAD, including a HEAD-body-plus-export variant) pin exact counts and 400 → 1 BigInt conversions.
- **Cross-principle check:** PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: model parameter labels unchanged.

### ADR-273: Code-level verdict cache for repeated answers
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `runJavaScriptTests()` keyed its cache on the raw reply text, so a reply that produced the same extracted code in a different format (fences, prose) paid another ~50–76 ms child spawn. The verdict is a pure function of the extracted code plus check and timeout.
- **Decision**: A bounded code-keyed verdict cache sits behind the existing text-keyed one. Text hits are unchanged; a text miss that matches by code reuses the stored verdict, and every new verdict is stored under both keys. No answer code is executed in-process.
- **Consequences**: a controlled A/B over four formatting variants of one answer measured **4 child spawns → 1 spawn + 3 code hits**, ~1.5 s → ~0.25–0.4 s (~4–6x), with an identical SHA-256 (`f336072a7ee5`). A failing-first test (confirmed against HEAD) pins 3 → 1 verifications and verdict equality.
- **Cross-principle check:** PRINCIPLE-011: no in-process execution of answer code, sandbox isolation unchanged; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: verdicts byte-identical.

### ADR-274: Cached tune rungs for repeated estimates
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `tuneRungs()` rebuilt the frozen suite's rungs, holdouts, pools and long-context sets on every call. `/api/tune/steps` calls `expectedAnswers()` and `estimateTune()` several times per request, each rebuilding them.
- **Decision**: Cache rungs by prompt-set identity and joined task list; callers only read the result, and `withDiscriminatingRungs` shallow-copies before modifying. A `tuneRungsComputations()` seam and reset helper are exported.
- **Consequences**: a controlled A/B over three estimate calls measured **15–18 ms → ~1 ms (~16x)** with an identical SHA-256 (`ca4f38fdc9be`). Two failing-first tests (confirmed against HEAD) pin result identity, one build for answers-plus-seconds, and reuse on repeats.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation, no new module; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: estimates and rung contents unchanged.

### ADR-275: Cursor-based round robin in stratified
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `stratified()` dealt items round-robin with `queue.shift()`, which moves every remaining element of a bucket each pass. On the full suite `speedItems()` cost **585–749 us**.
- **Decision**: Keep one index cursor per bucket and advance it instead of shifting. The deal order is byte-identical. A long diagnostic benchmark that failed to finish in 300 s first exposed the hotspot; an earlier end-to-end A/B was masked by the new rung cache, so the isolated `speedItems()` measurement is the reported one.
- **Consequences**: isolated `speedItems()` **585–749 us → 125–245 us (~3–6x)** with an identical SHA-256 (`01ab260a60a9`). Two failing-first tests (confirmed against HEAD) pin the exact round-robin selection and 548 → 0 `Array.shift` calls.
- **Cross-principle check:** PRINCIPLE-010: O(n) instead of O(n^2); PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: item order unchanged.

### ADR-276: Memoized speed workload
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `expectedAnswers()` and `estimateTune()` call `speedItems()` directly on every invocation, re-deriving the fixed speed workload from the frozen suite even after ADR-274 cached the rungs.
- **Decision**: Memoize `speedItems()` by prompt-set identity and return a fresh slice to each caller. Computation counter and reset helper are exported.
- **Consequences**: controlled A/B over `speedItems` plus three estimate calls measured **~795 us → ~46 us (~17x)** with an identical SHA-256 (`a23831a950a4`). Two failing-first tests (confirmed against HEAD) pin the single derivation, caller isolation and reuse across estimates.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: estimates and speed items unchanged.

### ADR-277: Memoized sampling axes
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `samplingAxes()` rebuilt its frozen axis list for every task on every `expectedAnswers()`/`estimateTune()` call; each build cost **3.85 us**.
- **Decision**: Memoize by `steps` object identity and task id in a resettable WeakMap; the result is frozen and pure. A computation counter is exported.
- **Consequences**: repeated `samplingAxes` **3.85 us → 0.015 us (~257x)**; controlled A/B over three tune estimates measured **~70 us → ~30–42 us (~2x)** with an identical SHA-256 (`ca4f38fdc9be`). Two failing-first tests (confirmed against HEAD) pin one derivation per task and reuse across passes.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: estimates and axis contents unchanged.

### ADR-278: Memoized quality, speed and prompt axes
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: With rungs, speed items and sampling axes cached, the three remaining builders (`qualityAxes`, `speedAxes`, `promptAxes`) still rebuilt frozen lists on every estimate call: 0.29 us, 1.66 us and 0.81 us respectively.
- **Decision**: A shared WeakMap memo keyed by the steps object and a small primitive (stage, core count, task/only list). Non-object step inputs are built uncached — a caller in `tune.mjs` passes a task string, which the original accepted. All results stay frozen.
- **Consequences**: repeated builders drop to **0.02–0.06 us**; controlled A/B over three tune estimates measured **~29 us → ~16 us (~1.8x)** with an identical SHA-256 (`ca4f38fdc9be`). Two failing-first tests (confirmed against HEAD) pin per-key reuse and the primitive-input path. The first attempt used a non-object WeakMap key and was caught by the full suite before shipping.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivations; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: estimates and axis contents unchanged.

### ADR-279: Reuse listProfiles stamps in loadProfile
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `listProfiles()` stats every profile file to validate its cache, then each `loadProfile()` stat'ed the same file again — 60 redundant stats per tune route request.
- **Decision**: `listProfiles()` publishes per-file stamps keyed by directory/catalog id; `loadProfile()` accepts an optional known stamp and falls back to its own stat when none is given. A stale known stamp only forces a fresh read, never a wrong profile.
- **Consequences**: isolated 60 loads **1.34 ms → 0.70 ms (~1.9x)**; controlled route A/B kept an identical SHA-256 (`8a3e7486bd27`) with tune overview **4.55–4.65 ms → 3.96–4.31 ms** and recommendations **3.89–4.73 ms → 3.29–3.34 ms**. A failing-first test (confirmed against HEAD) pins zero extra stats, equal profiles and the absent-profile case. An initial PowerShell file-swap corrupted `→` in the HEAD copy and produced a false hash mismatch; redoing the A/B with `git stash` confirmed identical output.
- **Cross-principle check:** PRINCIPLE-010: redundant fs metadata call removed; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: profile data unchanged.

### ADR-280: Parallel preset reads on cache miss
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `readShippedPresets()` parsed each preset file one at a time when its directory stamp changed; 30 valid recipes cost **3.75–4.01 ms**.
- **Decision**: Gather all preset file reads with one `Promise.all` and filter invalid recipes afterwards, preserving the sorted catalog-id order and the per-file read counter.
- **Consequences**: controlled A/B measured **3.75–4.01 ms → ~1.0 ms (~4x)** with an identical SHA-256 (`72bdf7d55c42`). A failing-first test (confirmed against HEAD) pins concurrent reads, sorted output and cache reuse. The first benchmark used recipes missing the `kind` field and measured an empty list; it was corrected to valid recipes before the reported run.
- **Cross-principle check:** PRINCIPLE-010: concurrency only for independent read-only reads; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: recipe list unchanged.

### ADR-281: Memoized model ids
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `hashId()` recomputed a SHA-1 for every model path on every scan; 60 paths cost **57.7 us**, while the ids never change for an unchanged path.
- **Decision**: Cache the 12-char id by normalized path in a bounded 4096-entry Map, with a computation counter and reset seam.
- **Consequences**: isolated **57.7 us → 0.5 us (115x)**; controlled end-to-end A/B over a 60-model cold scan measured **1.567 ms → ~1.24 ms (~1.25x)** with an identical SHA-256 (`afc7c25446aa`). A failing-first test (confirmed against HEAD) pins id equality across slash styles, no re-hash on repeat scans and the counter.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: model ids unchanged.

### ADR-282: Memoized type warnings per profile
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: The tune overview computed `typeWarnings()` for each saved profile on every request; 60 profiles cost **104 us**, repeated for each poll.
- **Decision**: Cache the pure result in a resettable WeakMap keyed by profile object and task filter. Non-object profiles still use the original path.
- **Consequences**: 60 profiles **104 us → 0.76 us (~137x)**; controlled A/B **~120 us → ~1 us (~100x)** with an identical SHA-256 (`f4fa714c4e71`). Two failing-first tests (confirmed against HEAD) pin per-filter reuse and warning content. An assertion initially used `equal` on objects and was corrected to `deepEqual` before shipping.

### ADR-283: Static import on the health route
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `/api/health` dynamically imported `./system.js` on every poll although that module was already statically imported there for `systemInfo`; the import cost **7 us** per request.
- **Decision**: Add `measureLoopLag` to the existing static import and remove the per-request `await import(...)`.
- **Consequences**: controlled A/B kept an identical SHA-256 (`90b942574a00`) and measured **0.218-0.225 ms -> 0.189-0.192 ms (~1.15x)** per health request. A failing-first source-guard test (confirmed against HEAD) pins the absence of the dynamic import. One full-suite run had a transient failure that passed on rerun; the final run was clean.

### ADR-284: Static os import in engine memory probe
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `LlamaEngine.totalMemory()` dynamically imported `node:os` on every CPU preflight even though `engine.js` already imported it at module scope.
- **Decision**: Use the module-level `os.totalmem()` directly; the redundant per-call dynamic import and its try/catch are removed (`totalmem` does not throw for this use).
- **Consequences**: controlled A/B kept an identical SHA-256 (`248faf9c6809`) and measured **3.59-3.82 us -> 0.43-0.46 us (~8x)** per CPU memory probe. A failing-first source-guard test (confirmed against HEAD) pins the absence of the dynamic import.
- **Cross-principle check:** PRINCIPLE-011: same value returned; PRINCIPLE-014: failing-first test, no assertion weakened; G-003: memory figures unchanged.

### ADR-285: Static built-in imports in the judge
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `runJavaScriptTests()` awaited two dynamic imports of already-available built-ins on every fresh call, including syntax-error and no-entry answers that never spawn a child. `checkJavaScriptSyntax()` did the same with four more.
- **Decision**: Import `node:child_process`, `node:crypto`, `node:fs/promises`, `node:os` and `node:path` at module scope and remove all six per-call dynamic imports.
- **Consequences**: controlled A/B on a syntax-error shortcut answer kept an identical SHA-256 (`aea8c2b908ad`) and measured **18.7-19.3 us -> 10.8-11.3 us (~1.7x)** per fresh answer. A failing-first source-guard test (confirmed against HEAD) caught the second import site when the first guard was too narrow; the final guard pins both.
- **Cross-principle check:** PRINCIPLE-011: sandbox isolation and verdicts unchanged; PRINCIPLE-014: failing-first test, no assertion weakened; G-003: verdicts byte-identical.

### ADR-286: Memoized profile file paths
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `fileFor()` re-validated a catalog id with a regex and re-joined a path on every `loadProfile` call; 60 calls cost **522 us**.
- **Decision**: Cache the derived path by directory and catalog id in a bounded 4096-entry Map, while keeping validation on every call so invalid ids still throw.
- **Consequences**: isolated `fileFor` **522 us -> 120 us (4.4x)** for 60 calls; controlled A/B over 60 profile loads kept an identical SHA-256 (`bf0780bf68c6`) and measured **~1.48-1.53 ms -> ~1.38-1.46 ms (~1.07x)**. A failing-first test (confirmed against HEAD) pins one derivation per id, reuse, and refusal of invalid ids.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: profile paths unchanged.

### ADR-287: Memoized tune-run file paths
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `summaryFile()` and `answersFile()` re-validated an id and re-joined a path for every run on each tune restore; 50 paths cost **~59 us** in the app's shape (up to ~1.3 ms with longer directories).
- **Decision**: A shared bounded cache keyed by directory, id and suffix; `checkedId()` validation still runs on every call so invalid ids keep throwing.
- **Consequences**: isolated A/B **~59-61 us -> ~9-11 us (~6x)** with an identical SHA-256 (`521f6b9b4e83`); the 50-run `itemOutcomes` A/B kept an identical hash (`d20f51249a8d`). A failing-first test (confirmed against HEAD) pins one derivation per id, reuse, and continued refusal of invalid ids. An assertion initially matched the wrong AppError text and was corrected before shipping.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: run paths unchanged.

### ADR-288: Memoized byte formatting
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `formatBytes()` re-ran `toFixed` and the unit loop for every model on every scan, although library sizes repeat across polls.
- **Decision**: Cache the label by normalized byte value in a bounded 2048-entry Map, with a computation counter and reset seam; the formatting logic itself is unchanged.
- **Consequences**: isolated A/B over 60 sizes kept an identical SHA-256 (`1b90274f8b9b`) and measured **4.73-4.83 us -> 0.76-0.86 us (~6x)**. Two failing-first tests (confirmed against HEAD) pin one derivation per value and all formatting branches. Initial expected labels were wrong (`1.5 KB` vs `1.50 KB`); corrected from the function's actual output before shipping.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: size labels unchanged.

### ADR-289: Memoized scan string helpers
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: `quantFromName()` and `templateOpensThinking()` redid regex and tail scans per model on every cold scan, although file names and chat templates repeat across polls.
- **Decision**: Cache each pure result by its string input in bounded 2048-entry Maps, hoist the quant regex, and expose computation counters plus a reset seam.
- **Consequences**: isolated A/B over 60 templates kept an identical SHA-256 (`59392304eca3`) and measured **3.06-3.21 us -> 0.36-0.49 us (~7x)**. Two failing-first tests (confirmed against HEAD) pin one derivation per string, repeat-scan reuse and all thinking-template branches; the quant test runs a real two-model scan.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivations; PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: quant labels and thinking flags unchanged.
- **Cross-principle check:** PRINCIPLE-011: no behavior change; PRINCIPLE-014: failing-first test, no assertion weakened; G-003: health payload unchanged.
- **Cross-principle check:** PRINCIPLE-009: cached pure derivation; PRINCIPLE-014: failing-first tests, no assertion weakened; G-003: warning labels unchanged.

### ADR-290: Filter narrowed model scans before file I/O
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: openTarget asks for one model, but scan stat'ed and magic-readed every discovered GGUF before applying only(); a cold 200-file narrowed scan cost 6.364ms and 200 header reads
- **Decision**: Apply the existing only(file, {id, relativePath}) predicate during candidate selection, before per-file stat, cache-key construction and GGUF magic reads; keep discovery, full scans and extensionless-symlink handling unchanged
- **Consequences**: Interleaved cold-process A/B measured 6.364ms -> 2.035ms (3.13x) and 200 -> 1 magic read per narrowed scan with identical model ids. A 200-file full scan kept an identical normalized output hash and no regression (9.111ms -> 8.901ms, 1.02x). A failing-first test pins one stat, one magic read and one metadata read for the kept file
- **Cross-principle check:** PRINCIPLE-003: existing predicate and discovery preserved; PRINCIPLE-010: unrelated I/O removed; PRINCIPLE-014: failing-first test, no assertion weakened; G-001/G-003: selected rows and ids unchanged.

### ADR-291: Read Git provenance in two processes
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: currentGitInfo spawned Git five times for hash, subject, branch, date and dirty state; an interleaved probe measured a 215.22ms median and blocked benchmark, merge, link and tune-gate finalization
- **Decision**: Use one git log format for hash/subject/commit date and one git status --porcelain=v1 --branch --untracked-files=no call for branch and tracked dirtiness; retain the optional injected runner and all-null failure fallback
- **Consequences**: A qualified interleaved A/B over 21 pairs measured 1285.642ms -> 453.505ms (2.83x) on a loaded host with an identical Git-info object hash; the non-repository fallback control drifted only 0.3%. An earlier run measured 215.22ms -> 100.695ms (2.14x). Failing-first tests pin exactly two calls, explicit refs, detached HEAD, tracked dirtiness, untracked exclusion, timeouts and fail-fast fallback
- **Cross-principle check:** PRINCIPLE-003: existing Git CLI and timeout retained; PRINCIPLE-010: three process launches removed; PRINCIPLE-014: failing-first tests, no assertion weakened; G-002/G-003: provenance fields and history format unchanged.

### ADR-292: Share stamped tune-history reads across preflight
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: A tune read every run summary twice and reread up to three large answer files during restore; the local 33-file store held 106MB of answers and a warm preflight median varied from 0.5s to 7.8s with storage state
- **Decision**: Create a process-local history cache for itemOutcomes and cachedAnswers, validate text and parsed summaries by before/after mtime+size stamps, retain newest runs first under 64MiB answer and 16MiB summary caps, and clear it before restore verification and generation
- **Consequences**: The real store now opens 39 rather than 42 answer files and 39 rather than 78 summaries per preflight, with identical saturation/restore output hash. A qualified interleaved run measured 1110.991ms -> 926.643ms (1.20x) with 1.2% control drift; repeated warm runs ranged 0.94-1.21x, so the deterministic I/O reduction is the primary evidence. Failing-first tests pin duplicate-read removal, append/rewrite invalidation, bounds and newest-run eviction
- **Cross-principle check:** PRINCIPLE-003: both readers keep their filters and quarantine behavior; PRINCIPLE-010: duplicate I/O removed under explicit byte/entry caps; PRINCIPLE-013: concurrent appends cannot pin a mismatched stamp; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: saturation and restored rows are byte-identical.

### ADR-293: Commit benchmark history one logical write at a time
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: recordRun autocommitted the run, every model and every prompt separately; a synthetic 50-model x 20-prompt result took 6.786s median and a mid-run failure left partial SQLite rows
- **Decision**: Wrap each insertRun and each importHistory batch in one BEGIN/COMMIT transaction with ROLLBACK on error, wrap link updates likewise, and prepare model/prompt statements once per run; keep JSONL appended before SQLite and retain the existing fallback
- **Consequences**: A qualified interleaved 50-model x 20-prompt A/B measured 9498.247ms -> 115.102ms (82.52x) on a loaded host with 10.2% read-only control drift. Row counts, 50 models, 20 prompt groups, one JSONL line and PRAGMA integrity_check remained identical. Failing-first tests prove mid-run and mid-import rollback leave zero partial rows while JSONL remains durable
- **Cross-principle check:** PRINCIPLE-003: existing node:sqlite and schema retained; PRINCIPLE-010: 1000-plus autocommits replaced by one commit and statements reused; PRINCIPLE-013: failed writes roll back atomically; PRINCIPLE-014: failing-first rollback tests, no assertion weakened; G-002/G-003: JSONL-first history and row fields unchanged.

### ADR-294: Reuse paired evidence within one tune sweep
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: The sweep computed incumbent-to-challenger p-values, recomputed the chosen comparison, and repeated grouped evidence while balancing coding views; a deterministic 96-item clustered sweep performed 3.84 million Monte Carlo draws
- **Decision**: Cache paired evidence by ordered before/after stats object identity for the life of one sweep, and cache balanced-choice group statistics by after-stats identity plus clustered/item-level mode; keep reverse direction and the final unclustered group report distinct
- **Consequences**: A qualified 15-pair interleaved A/B measured 55.679ms -> 45.392ms (1.23x) and 3.84M -> 2.88M draws with an identical sweep hash; the uncached groupEvidence control drifted 6.2%. A separate run measured 1.31x. A failing-first test pins one draw set per ordered comparison, object reuse and reverse-direction separation; existing choice, guard and statistical simulations pass
- **Cross-principle check:** PRINCIPLE-003: ordered identity and clustering mode preserve the statistic's inputs; PRINCIPLE-010: repeated Monte Carlo work removed; PRINCIPLE-014: failing-first draw-count test, no assertion weakened; G-001/G-003: sweep records, winners, guards and p-values are byte-identical, so TUNER_VERSION and baselines stay unchanged.

### ADR-295: Cache slim tune-run listings by file stamp
- **Date**: 2026-11-24
- **Status**: Accepted
- **Context**: listRuns parsed 16.2MB of full run summaries on every UI request even though the stripped listing was only 36KB; the real 39-run store took a 58.063ms median
- **Decision**: Keep a bounded process-local cache of each valid stripped summary keyed by mtime+size, validate it with one stat per file, clone cached rows for callers, and run present() after cloning so process liveness and unfinished duration stay live; changed and corrupt files still use the quarantine reader
- **Consequences**: A qualified 30-pair interleaved A/B measured 60.247ms -> 1.058ms (56.94x) with an identical normalized listing hash; the full-loadRun control drifted 0.8%. Only the initial 39 summaries were parsed across warmup plus 30 candidate listings. Failing-first tests pin one parse per unchanged file, caller-mutation isolation, live interrupted status/duration, single-file rewrite refresh and corrupt-file quarantine
- **Cross-principle check:** PRINCIPLE-003: existing schema filter, order and quarantine behavior retained; PRINCIPLE-010: repeated 16.2MB parses removed under a 4096-entry cap; PRINCIPLE-013: before/after stamps prevent caching a mixed rewrite; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: no generation, prompt, settings or tune-decision data changes.

### ADR-296: Cache slim parsed profiles for read-only consumers
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Overview, recommendations and per-chat tuned-settings resolution reparsed full 1-2MB profiles on every call although they never use sweeps or resume progress; eight real profiles occupied 9.4MB
- **Decision**: Add loadProfileSlim with a stamped parsed projection that omits sweeps/progress, precomputes type warnings, clones both per caller, and is invalidated by saveProfile; use it for overview, recommendations and TunedSettings while keeping loadProfile full for resume/detail/export and leaving the schema-less scheduler lane reader unchanged
- **Consequences**: A qualified 30-pair interleaved A/B measured 29.546ms -> 3.535ms (8.36x) with an identical overview hash; the 100000-call profileIdFor control drifted 11.1%. Only eight profile parses occurred across warmup plus 30 candidate overviews. The first cold overview paid a small one-time cache/clone cost. Failing-first tests pin parse reuse, caller-mutation isolation, save invalidation, warning cloning and full-profile resume preservation
- **Cross-principle check:** PRINCIPLE-003: full resume/detail/export and schema-less lane behavior retained; PRINCIPLE-010: repeated full-profile parses removed under the existing 16-entry bound; PRINCIPLE-013: save invalidation and exact stamps refresh changed profiles; PRINCIPLE-014: failing-first tests, no assertion weakened; G-001/G-003: settings, stats, warnings and overview bytes are identical.

### ADR-297: Serialize benchmark output payloads once
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Standard benchmark finalization and shard merges pretty-printed the same 2.36MB result twice for two destination files; each full serialization is a synchronous CPU cost before history recording
- **Decision**: Create one payload string at the shared mutation point and reuse it for the standard result/latest files and merge outputs; keep later baseline, gate, ceiling and stdout serialization separate because result changes afterward
- **Consequences**: An interleaved serialization A/B measured 36.746ms -> 15.602ms (2.36x), saving 21.144ms per two-file finalization, with the same normalized baseline content hash; an unchanged JSON.parse control drifted 11.1%. Existing flash, merge and history tests cover output naming, repro isolation and history behavior
- **Cross-principle check:** PRINCIPLE-003: reuse is scoped to one mutation state and distinct paths; PRINCIPLE-010: one synchronous pretty-print removed; PRINCIPLE-014: existing output/history tests and byte-hash proof, no assertion weakened; G-002/G-003: result contents and history inputs are unchanged.

### ADR-298: Batch benchmark-history model loading
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: listRuns queried the selected runs and then issued one model_results query per run; the real 87-run history performed 88 query cycles and took about 25ms per report listing
- **Decision**: Fetch all selected runs' model rows with one parameterized IN query, group them by run uid, and preserve each run's model_key/variant_id ordering and empty-model behavior
- **Consequences**: A qualified 30-pair interleaved A/B measured 48.887ms -> 24.693ms (1.98x) with an identical 87-run/217-model output hash; a 100000-call deriveRunScope control drifted 5.7%. A failing-first test proves two prepared queries instead of one plus one per run
- **Cross-principle check:** PRINCIPLE-003: selected uids, row fields and ordering are preserved; PRINCIPLE-010: N model queries replaced by one; PRINCIPLE-014: failing-first query-count test and exact output hash, no assertion weakened; G-002/G-003: history schema and report contents are unchanged.

### ADR-299: Snapshot installed engines by exact stamps
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Each engine listing rediscovered installs repeatedly across descriptors, resolve and version calls; a 60-list fanout took 173.11ms with 960 install.json reads and 1440 directory scans
- **Decision**: Cache installed records and resolved llama-server/llama-bench binaries under bounded process-local maps, validate bin-directory plus install-file/directory stamps with stat on warm calls, share one snapshot per listing context, cache the prebuilt notice by manifest stamp, and invalidate explicitly after install, register and unregister
- **Consequences**: A qualified 15-pair interleaved fanout A/B measured 793.638ms -> 125.129ms (6.34x) on a loaded host with an identical listing hash; install reads and directory scans fell from 960/1440 to 0/0. An earlier single-process run measured 173.11ms -> 35.818ms (4.83x). The unchanged catalog isServable control drifted 13.0%. Failing-first tests pin fanout read/scan counts, add/edit/remove refresh, moved-binary resolution, caller isolation and explicit installer/register invalidation
- **Cross-principle check:** PRINCIPLE-003: install records, binary resolution and listing fields are preserved; PRINCIPLE-010: repeated discovery and manifest parsing removed under explicit caps; PRINCIPLE-013: exact stamps plus installer/register invalidation prevent stale snapshots; PRINCIPLE-014: failing-first tests and exact listing hash, no assertion weakened; G-001/G-003: engine availability, versions and tuning inputs are unchanged.

### ADR-300: Opt into budgeted tune-answer restore
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: The default three-run restore left 3472 Qwen and 4159 Llama answers unused even though a fourth run fit comfortably under a bounded read budget
- **Decision**: Add restoreBudget to cachedAnswers and runTune plus --restore-budget to the tune CLI. The opt-in selector walks matching runs newest-first, includes the row-crossing run, and enforces 20000 accepted rows, 32MiB of answer files and four files; the existing limitRuns=3 path remains the default
- **Consequences**: The real restore reader replayed Qwen 16528 -> 20000 rows (279 -> 354 groups) and Llama 1078 -> 5237 rows (27 -> 121 groups) within four files and 32MiB; SmolLM2 was unchanged. With runTune's itemOutcomes-prefilled history cache, all selected files were cache hits and the same gains held; restore parsing cost Qwen 53.124ms -> 63.791ms and Llama 4.491ms -> 19.052ms, while SmolLM2 was 54.986ms -> 54.539ms. The opt-in therefore trades bounded parse work for more replayed answers. Failing-first tests pin precedence, crossing-run inclusion, file/byte/row caps, zero-row behavior and fingerprint/tuner/width filtering
- **Cross-principle check:** PRINCIPLE-003: default-three selection and all fingerprint/width/timed-row filters remain intact; PRINCIPLE-010: extra replay is bounded by explicit row/byte/file caps; PRINCIPLE-014: failing-first tests, no existing assertion weakened; G-001/G-003: no prompt, check, setting or suite-version change, and live restore verification still gates reused answers.

### ADR-301: Prove restore budget end-to-end with an injected engine
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: The restore-budget fixture proved more replayable rows but not lower tune wall time; runTune constructs its engine internally, so a deterministic hardware-free end-to-end comparison was impossible
- **Decision**: Add an optional engineFactory to runTune/withEngine while leaving production routing and cleanup unchanged, and benchmark a split four-run fixture through the full itemOutcomes, restore verification, tune, profile-save and run-recording path
- **Consequences**: Seven interleaved default/budget/control tune trios reduced fresh answers 23 -> 18 and median wall time 415.578ms -> 339.645ms (75.933ms saved) with outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab unchanged; the default/default A/A control was 416.211ms (0.2% drift). Parse instrumentation then identified the next hotspot: itemOutcomes and cachedAnswers separately JSON-parse answer rows (Qwen default 4863 + 17068 calls; budget 4863 + 20835), so selected-row parse reuse is the next bounded optimization
- **Cross-principle check:** PRINCIPLE-003: production engine routing is unchanged without the factory; PRINCIPLE-010: the benchmark isolates real restore/tune work from hardware; PRINCIPLE-014: failing-first factory cleanup test and deterministic outcome hash; G-001/G-003: no generation, prompt, settings or suite-version behavior changed.

### ADR-302: Reuse parsed answer rows only for budgeted restore
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: itemOutcomes and cachedAnswers parsed overlapping answer files twice; naive parsed-row caching with structuredClone was rejected after direct A/B showed it slower than reparsing
- **Decision**: Retain parsed rows only for the opt-in restore-budget path, for the newest four files with at least 1000 rows, under four-file and 50000-row cache caps and exact mtime+size stamps. Public cachedAnswers callers still receive cloned cached rows; runTune uses a documented read-only fast path and clears the cache before generation. Default-three performs no parsed-row retention
- **Consequences**: Direct real-store A/B left default unchanged, improved Qwen budget restore 1522.802ms -> 1264.551ms (1.20x) and Llama budget 465.634ms -> 280.185ms (1.66x), and kept SmolLM2 neutral (0.99x), with identical output hashes and 6.0% control drift. Restore JSON.parse calls fell Qwen 20835 -> 16725 and Llama 5237 -> 1078. The deterministic full tune still reduced fresh answers 23 -> 18 and median time 3550.975ms -> 3367.272ms under heavy load, with 4.6% control drift and an unchanged outcome hash
- **Cross-principle check:** PRINCIPLE-003: default-three, fingerprints, widths, timed-row rules and restore caps are unchanged; PRINCIPLE-010: duplicate parsing is removed only where measured faster, under explicit file/row/minimum bounds; PRINCIPLE-013: exact stamps and pre-generation clear prevent stale or long-lived row retention; PRINCIPLE-014: failing-first reuse/clone/invalidation/bounds/filter/early-break tests; G-001/G-003: restored rows and tune outcomes are byte-identical.

### ADR-303: Batch per-model benchmark progress queries
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: benchmark reports called modelProgress once per selected model key; the real history issued 11 queries for 135 progress rows and took about 17ms
- **Decision**: Add modelsProgress with one parameterized ROW_NUMBER window query partitioned by model key, retain the standard/shard and non-batch-1 filters, order each key newest-first, and make single-key modelProgress delegate to it
- **Consequences**: A qualified 30-pair real-history A/B measured 12.457ms -> 10.945ms (1.14x), reduced prepared queries 11 -> 1, and kept the exact 11-key/135-row output hash; an unchanged COUNT control drifted 2.3%. Failing-first tests prove one query, per-key limits, newest-row selection and repro exclusion
- **Cross-principle check:** PRINCIPLE-003: row fields, scope filters and per-key ordering are preserved; PRINCIPLE-010: N report queries replaced by one bounded window query; PRINCIPLE-014: failing-first query-count/equivalence test and exact output hash; G-002/G-003: benchmark history contents and report semantics are unchanged.

### ADR-304: Stop restore verification at the first decisive mismatch
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Profiling the deterministic tune found live restore verification generated 18-20 of 24-26 answers; after one mismatch rejects a family or the whole restore, remaining probes cannot change the reuse decision
- **Decision**: End verifyRestore after its first mismatch and end each verifyRestoreByFamily family after its first mismatch; keep candidate selection, thread alternation, scope filters and retained-row construction unchanged, and report checked as the number actually executed
- **Consequences**: A 50-pair direct old/new A/B with a 5ms CPU stand-in reduced one-stale-family probes 18 -> 16 and 286.126ms -> 230.899ms (1.24x), all-stale probes 18 -> 6 and 509.819ms -> 168.656ms (3.02x), and all-or-nothing probes 8 -> 1 and 177.651ms -> 22.909ms (7.75x), with identical retained-row hashes; all-match stayed at 18 probes and its 0.93x timing was inside 7.5% A/A control drift. Five-pair full-tune A/B kept the exact outcome hash and run counts, while fresh answers fell 26 -> 25 default and 24 -> 22 budget; noisy budget wall time is not claimed. Failing-first tests prove early exit, actual checked counts and unchanged kept groups
- **Cross-principle check:** PRINCIPLE-003: candidate selection, thread alternation, filters and retained rows are unchanged; PRINCIPLE-010: stop work once the rejection decision is known; PRINCIPLE-014: failing-first call-count/equivalence tests and exact retained-row/outcome hashes; G-001/G-003: no generation, prompt, settings or tune decision rule changed.

### ADR-305: Reuse rejected-family live verification rows with measured accounting
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: After early-stop verification, a stale family's exact live answer could still be generated again by the tune; naive restore prefetch would wrongly reduce run counts, skip answer recording or bypass budgets
- **Decision**: Expose successful verification rows through an optional onAnswer callback; keep only serial-width rows from rejected families; hold them in a process-local Measurements pending cache keyed by exact settings/seed/item. Consume them through the original measure chunk, increment runs, invoke onAnswers once with the original batch shape, preserve memory and cap-sibling semantics, and retain the original no-prefetch fast path
- **Consequences**: A 50-pair direct A/B on 18 rows reduced asked items 18 -> 17 for one pending row and 36.020ms -> 34.032ms (1.06x), reduced 18 -> 0 when all rows were pending, and kept the no-prefetch path neutral at 36.130ms -> 36.066ms; output/accounting hashes matched with runs=18 and reusedRows=0, under 0.4% A/A control drift. Five-pair full-tune A/B reduced fresh answers 25 -> 24 default and 22 -> 21 budget, kept outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab and run counts 12/6; noisy full-tune wall time is not claimed. Failing-first tests cover callbacks, mixed batches, caps, deadlines, chunking, memory, restore/cap precedence and tune wiring
- **Cross-principle check:** PRINCIPLE-003: exact settings/seed/item identity, serial width, successful rows and rejected families only; PRINCIPLE-010: no-prefetch fast path preserves the original hot loop; PRINCIPLE-013: process-local pending state is consumed or discarded with the tune; PRINCIPLE-014: failing-first accounting/budget/chunk/precedence/wiring tests and exact hashes; G-001/G-003: prompts, generation, restore decisions and tune decision rules are unchanged.

### ADR-306: Skip redundant judging for exact-text restore matches
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: CPU profiling after live-row prefetch showed JavaScript child-process judging was the largest avoidable startup cost; matching restore families re-judged identical text even though the suite verdict is pure for the same prompt/check/text
- **Decision**: Add createEvaluator.raw generation plus judge(id, row); family verification generates raw answers, infers the saved numeric verdict only for exact text matches, and fully judges every mismatch before stale-family prefetch. Keep model probes, ordering, early stop, width, callbacks for judged stale rows and normal evaluated rows unchanged
- **Consequences**: A 20-pair cold-cache direct A/B kept six model calls, six checked rows and the same retained-row hash while judge misses fell 4 -> 0 and median verification time fell 249.436ms -> 0.103ms; the first-mismatch path stayed equivalent and A/A control drift was 0.7%. Five-pair cold-cache full-tune A/B reduced default judge misses 16 -> 5 and 543.739ms -> 351.271ms, and budget misses 15 -> 1 and 511.086ms -> 123.480ms, with identical fresh answers (24/21), verification probes (16/17), run counts (12/6), reuse notes and outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab. Sixty-one targeted evaluator/timing/parallel/reuse/failure tests pass; ordinary and deferred judging produce identical answer rows
- **Cross-principle check:** PRINCIPLE-003: exact text plus a numeric saved verdict is required before inference, and malformed verdicts or changed text are judged; PRINCIPLE-010: remove only redundant judge work proven by cold-cache A/B; PRINCIPLE-014: failing-first raw/judge equivalence and decision tests plus exact full-tune hashes; G-001/G-003: engine inputs, prompts, checks, settings and normal judged rows are unchanged.

### ADR-307: Overlap a bounded pool of isolated JavaScript judges
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Post-raw-verification profiling showed 431ms judging versus 324ms generating; independent code checks still spawned one permission-isolated Node child at a time
- **Decision**: For multi-item width-one evaluation, generate answers serially, judge up to four at a time in separate unchanged sandbox children, then emit results and onItem callbacks in original order. Add exact-text and extracted-code in-flight maps so concurrent duplicates preserve sequential cache hit/miss accounting
- **Consequences**: A 10-pair real-child A/B over eight checks improved 1084.167ms -> 451.179ms (2.40x) with identical nine model calls including warm-up, six judge misses, zero hits and row hash f56b8d5c4185b5a5776976c1bfdb7c51fb1376fde361e57837e7e398a1f941a6; A/A control drift was 5.2%, and a width sweep favored four workers (2.10x) over two (1.54x). A five-pair cold full-tune A/B kept fresh answers 24/21, probes 16/17, runs 12/6, reuse notes and outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab; default judge median improved 281ms -> 253ms while wall time 495.270ms -> 515.402ms was noisy and no full-wall gain is claimed, and the one-miss budget case stayed neutral. Eighty-six targeted evaluator/timing/parallel/cache/shortcut/sandbox tests pass
- **Cross-principle check:** PRINCIPLE-003: each answer still uses the same permission flag, neutral environment, cwd, heap cap, timeout and output limit; PRINCIPLE-010: concurrency is capped at four and only independent judging overlaps; PRINCIPLE-013: in-flight entries are removed in finally and remain process-local; PRINCIPLE-014: failing-first concurrency/order/dedup tests, sandbox suite and exact row/tune hashes; G-001/G-003: generation inputs and verdict semantics are unchanged.

### ADR-308: Select restore probes by exact stable ranks
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Restore verification sorted every family fully to choose three evenly spaced probes from its cheapest half; at the 20000-row cap this preparation is avoidable O(n log n) work
- **Decision**: Keep the original stable sort for families under 64 rows. For larger families, decorate rows with original indexes, use bounded quickselect at only the required cheapest-half ranks, and fall back to full stable sort if partitioning exceeds a logarithmic bound
- **Consequences**: A 20000-row single-family benchmark improved 2.656ms -> 0.849ms (3.13x). A 50-pair full verification A/B over 20010 rows and 21 probes improved 5.621ms -> 3.937ms (1.43x) with identical asked-ID and retained-group hashes under 0.5% A/A control drift. Five-pair full-tune A/B kept fresh answers 24/21, probes 16/17, runs 12/6, judge misses 5/1, reuse notes and outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab; noisy full-tune wall time is not claimed. Equivalence tests cover empty/small/threshold/large lists, ties, missing timings, multiple probe counts and input immutability; 35 targeted tests pass
- **Cross-principle check:** PRINCIPLE-003: original row order is an explicit tie-breaker and selected ranks are equivalence-tested against stable sort; PRINCIPLE-010: only required ranks are selected, with a logarithmic partition budget and sort fallback; PRINCIPLE-014: failing-first helper export plus size/tie/immutability tests and exact asked/retained hashes; G-001/G-003: probe identities, restore decisions and tune outcomes are unchanged.

### ADR-309: Bound cold model metadata reads at four
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Cold model scans awaited each uncached GGUF metadata parser sequentially; the project notes 8.1 seconds for a 16-model library, and a controlled 25ms parser benchmark measured 498.966ms with peak concurrency one
- **Decision**: Parse uncached valid GGUF metadata through four workers, keep cached summaries on the existing path, then assemble entries, fallbacks and warnings in original discovery order
- **Consequences**: A same-files 10-pair A/B over 16 models improved 1016.453ms -> 344.454ms (2.95x), raised peak metadata reads 1 -> 4, and produced deeply identical model rows with output hash 1e1449f2428a52aab5ee7199e8feb6a6aee73de67e3654d6c3fbb553e3dc0e45 under 5.9% A/A control drift. Eighty-one registry/profile/server/startup tests pass, including bounded concurrency, out-of-order completion, warning order, unreadable fallbacks, cache reuse and narrowed scans
- **Cross-principle check:** PRINCIPLE-003: discovery, stat/magic filtering, cache keys, ordered assembly and warning order are preserved; PRINCIPLE-010: only independent uncached metadata reads overlap, capped at four; PRINCIPLE-013: the existing atomic per-file summary cache and scan stamps are unchanged; PRINCIPLE-014: failing-first concurrency/order test plus deep row equality and registry/server suites; G-001/G-003: model metadata and API output are unchanged.

### ADR-310: Seek past bounded GGUF metadata spans in the native guard
- **Date**: 2026-11-25
- **Status**: Accepted
- **Context**: Real-app startup profiling showed the native GGUF header validator was the largest non-idle CPU cost; its skip loop copied every metadata string, tokenizer array and tensor span through an 8KiB scratch buffer just to advance
- **Decision**: Keep every count/length bound and rejection path, but advance with BufReader::seek_relative: buffered spans move without a syscall and large spans seek once instead of copying all bytes
- **Consequences**: The real 16-model native walk improved 223.202ms -> 59.330ms (3.76x) with identical version/tensor/KV facts. Six alternating real-app startup pairs improved 534.740ms -> 361.463ms (1.48x) while all 16 /api/models rows kept hash d912db661ad2caa181d430e570e60056576150b6355ae9265fbfcea04d10cf24. The addon rebuild passes, and 20 guard/registry/startup tests pass including a 20000-byte metadata span, hostile counts, native/JS equivalence and unreadable fallbacks
- **Cross-principle check:** PRINCIPLE-003: version, tensor and KV facts plus every structural bound and rejection remain equivalent; PRINCIPLE-010: skipped bytes are no longer copied, while buffered skips stay syscall-free; PRINCIPLE-014: large-span equivalence, hostile-header and real-app API-hash tests; G-001/G-003: model discovery output and validation semantics are unchanged.
### ADR-311: Speed pass over shutdown, scan, boot warm-ups and the speed stage
- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: Profiling found five avoidable costs. LlamaServerBackend.stop() raced a 5 s sleep it never cleared, so the process stayed alive up to 5 s after llama-server exited, and two test files each waited 5 s on such timers. A cold scan of 16 models spent 1.7 s inside node-llama-cpp decoding every vocabulary string (about 110 ms per model, ignoreKeys does not avoid it). The first engine list took 3.2 s and the first Load paid a 1 s import of node-llama-cpp. The speed stage timed every candidate three times even when the first timing was far behind.
- **Decision**: stop() clears its timer; the scan reads headers with src/gguf-summary.js, which decodes scalars, the chat template and tensor shapes and skips large arrays by length prefix, and falls back to node-llama-cpp on any file it does not understand (GGUF v1, big-endian, unknown types, truncation); main.js warms the engine probe at 1.5 s and the runtime import at 3.5 s after listening, so neither delays boot or the first page; the speed stage times a non-incumbent candidate once when it is at least 1.5x slower than the fastest after round one (never on the threads axis, which feeds Light and Quiet).
- **Consequences**: npm test 10.5 s -> 7.9 s; external-engines.test.js 6.4 s -> 1.7 s; settings-sse-links.test.js 5.1 s -> 0.09 s; cold 16-model scan 2014 ms -> 528 ms; the summary reader matched node-llama-cpp on all 16 local files (architecture, name, size label, chat template, architecture metadata, every tensor dimension); first /api/engines call 3188 ms -> 79 ms. gpu-info takes an injectable runtime loader so its missing-runtime test no longer depends on whether node-llama-cpp is installed.
- **Cross-principle check:** PRINCIPLE-003: the new reader is checked against the library on real files and refuses what it does not parse; PRINCIPLE-010: warm-ups are deferred timers and the elimination only removes repeats of candidates that cannot win; PRINCIPLE-014: each behaviour change has a failing-first test (stop timer, summary reader, warm-up, elimination, threads exempt) and no assertion was weakened.
### ADR-312: A quick tune pass can be the whole tune
- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: A full default tune asks up to 10,000 answers (sampling 5,736, prompt 1,848, confirmation 2,544) and 92 to 93 percent of its wall time is generation. On the 1.5B coder model no answer reached the token cap, and decode ran at 20 to 30 tok/s on a loaded machine, so no wasted generation could be removed without changing results. The UI's Quick pass always continued into the full tune.
- **Decision**: Add a quickOnly option (API body field, scheduler job field, and a "Quick pass only" box in the Tune panel). With quick and quickOnly set, the scheduler saves the provisional preset, logs that the full tune was not asked for, and does not start the continue run. quickOnly without quick is ignored.
- **Consequences**: A quick-only tune estimates 148 minutes against 523 for one full pass (default grid, 16 threads, 3 s per answer). The preset stays provisional until a full tune, as for a budget-limited quick pass. Default behaviour is unchanged.
- **Cross-principle check:** PRINCIPLE-003: the new field is validated as a boolean and cannot reach a shell; PRINCIPLE-014: two scheduler tests, one failing without the change, and the existing quick-then-full test still passes.

### ADR-313: Cache exact-stamped engine-listing profile sidecars
- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: Every engine-list request reread and reparsed the model's full profile and engine measurements; thirty real requests caused sixty reads of a 1.27MB profile plus its sidecar
- **Decision**: Add a 32-entry process-local mtime+size cache in createEngineListing, share one in-flight read per file, refresh on stamp changes, delete on missing files and leave parse failures uncached for retry
- **Consequences**: A 30-request interleaved real-profile A/B reduced warm median listing time 4.261ms -> 0.282ms (15.09x); the baseline read both sidecars sixty times while the candidate read them twice before measured warm requests and zero times during them, with identical output hash d5e7d4034ce6fad10bee9aaef2c932438f111423efbd2cbcf247f406db269fba and 10.8% A/A control drift. Sixty-four engine/catalog/server tests pass, including concurrent read sharing, unchanged stamps, changed-size refresh, deletion without a failing read, probe caching and API routes
- **Cross-principle check:** PRINCIPLE-003: exact mtime+size stamps preserve change detection and parse failures still retry; PRINCIPLE-010: unchanged sidecars avoid repeat I/O/JSON parsing; PRINCIPLE-013: cache is bounded, process-local and in-flight entries are removed in finally; PRINCIPLE-014: failing-first read-count/invalidation/deletion tests plus exact output hash; G-001/G-003: engine measurements, rankings and API output are unchanged.

### ADR-314: Prune thread repeats by fastest and capped-preset eligibility
- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: The speed stage repeated every thread candidate three times because Light/Quiet may need slower values, even when a value cannot win fastest or either capped preset
- **Decision**: After the first thread timing round, apply the existing 1.5x clear-loser rule independently to fastest, Light and Quiet; compare quality-preserving candidates against the reference so a faster flipped value never prunes the slower fallback
- **Consequences**: A 10-pair speed-stage A/B reduced timed calls 18 -> 14 and 38.617ms -> 30.085ms (1.28x) with identical Fastest=16, Light=8, Quiet=4 presets and output hash a3bd116dcb1ee8074bc36df21cf6d910993c24530beaa5260618de685bafa0ea under 0.2% A/A control drift. Failing-first tests cover standard pruning and a faster quality-flip fallback; 116 tune/statistics/timing/budget tests pass. The real three-model tune gate passed all nine task rates with zero delta (84 fresh answers plus paraphrase probes).
- **Cross-principle check:** PRINCIPLE-003: fastest/Light/Quiet winners and quality-flip exclusions are preserved; PRINCIPLE-010: only candidates unable to win any preset skip repeats; PRINCIPLE-014: failing-first standard/quality-fallback tests and exact preset-hash A/B; G-001/G-003: generation and quality checks are unchanged, while the real tune gate verifies core-model task rates.

### ADR-315: Short-circuit provable unbound-identifier runtime failures
- **Date**: 2026-11-26
- **Status**: Accepted
- **Context**: Irrelevant generated code such as answer or answer-0 still spawned a sandbox only to throw on an unbound identifier before the requested entry could be called
- **Decision**: Recognize only bare identifiers and arithmetic/bitwise expressions whose identifiers are absent from setup, harness and the child-global allowlist; return the existing syntax/runtime-error verdict in process, while setup-defined names, globals, the entry itself and every other construct keep the child path
- **Consequences**: A 10-pair real repo-check A/B reduced child spawns 6 -> 0 and 360.424ms -> 0.131ms with identical verdict hash f18624b43c4cd3590067380da094cd5c44c144008d5e7347be43f85cb845b891 under 2.5% A/A control drift. Five-pair full-tune A/B kept fresh answers, probes, run counts, reuse notes and outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab; default median improved 801.339ms -> 442.696ms while the one-miss budget case stayed neutral within noise. One hundred thirty-eight judge/sandbox/tune tests pass, including setup/global/entry exclusions. The real three-model tune gate passed all nine task rates with zero delta (84 fresh answers plus paraphrase probes).
- **Cross-principle check:** PRINCIPLE-003: only a narrow expression with no setup/harness/global/entry binding qualifies, and exact runtime-error details are preserved; PRINCIPLE-010: avoid child startup for a provable failure; PRINCIPLE-014: failing-first positive/negative tests, real-check verdict hash and full-tune outcome hash; G-001/G-003: checks and prompts are unchanged, and the real tune gate verifies core-model task rates.

### ADR-316: Judge provably pure single-return functions in process
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: Across 30 real tune files, 7.68 percent of 13,965 code answers were a single safe return expression; 98 unique such answers spent 8.29 seconds starting sandbox children for verdicts reproducible without any host access
- **Decision**: Recognize only a single required function with simple parameters whose return expression uses nothing but those parameters and numeric/boolean literals; calls, properties, strings, collections, globals, assignments, updates, setup, harness, sandbox bindings and oversized output keep the sandbox path, and the existing syntax/no-entry/runtime shortcuts still precede this one
- **Consequences**: A five-pair interleaved A/B over the 98 stored functions changed 98 child spawns to zero and 8,290.841ms to 2.732ms with identical verdict hash fb0e43d5d4dc5701f446992fb630cbc777629133107f3c74bdb8211c6148d36e under 22.8 percent A/A timing drift from child-startup noise; a broader 4,470-entry timing run was discarded after machine saturation caused sandbox timeouts, while an isolated classification check confirmed all 98 shortcuts matched the sandbox verdict exactly. A five-pair full speed-only tune kept 36 fresh answers, six code items, 36 runs, the same Fastest=6, Light=4, Quiet=null, decision hash 8e3a71b60f078a4f00411d37b8b59cb9207455d35ae9455f45fe12d20c518078 and rows hash e0595f360bb9fdb8be168e6fd30c95f5774d1cbf7abfb1f44d3943132f0e9aaa while the judged phase fell 68ms to 5ms under 0.2 percent control drift. Five-pair default and budget restores kept fresh answers 24/21, probes 16/17, runs 12/6, identical reuse notes and outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab. One hundred sixty-six targeted tests and the real three-model tune gate passed with all nine task rates unchanged and 84 fresh answers plus paraphrase probes.
- **Cross-principle check:** PRINCIPLE-003: only a statically proven parameter/literal expression is evaluated in process and every verdict detail, error message and output-limit case is preserved; PRINCIPLE-009: two small pure helpers sit beside the existing judge shortcuts; PRINCIPLE-010: child startup is removed only for a provable class; PRINCIPLE-014: failing-first positive/negative/output tests, exact 98-answer verdict hash, full tune rows/decision hashes and real gate; G-001/G-003: prompts, checks, generation, settings and suite versions are untouched, and the real gate verifies all core-model task rates.

### ADR-317: Extend the pure judge to whitelisted built-ins
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: The first in-process judge covered 104 of 460 unique single-return functions; most remaining answers used only deterministic literals, Math, or whitelisted string and array methods
- **Decision**: Move expression validation into benchmarks/pure-expression.mjs, tokenize single-return bodies and allow only parameters, simple literals, a fixed Math and global-call whitelist, and a fixed set of pure instance methods and length; everything else, including callbacks, constructors, arrays, assignments, updates and oversized output, stays with the sandbox
- **Consequences**: A five-pair interleaved A/B over the 180 accepted real stored functions changed 180 child spawns to zero and 20,144.036ms to 9.403ms with identical verdict hash eccbbcd9a973464273c8aa3fc583ffd0a2a8d0cfdb424bee544536dcc9240e51 under 20.6 percent A/A child-startup drift. Against the committed prior judge, a five-pair full speed-only tune kept 36 fresh answers, six code items, 36 runs, the same Fastest=6, Light=4, Quiet=null, decision hash 8e3a71b60f078a4f00411d37b8b59cb9207455d35ae9455f45fe12d20c518078 and rows hash e0595f360bb9fdb8be168e6fd30c95f5774d1cbf7abfb1f44d3943132f0e9aaa under 0.0 percent control drift; default and budget restores kept identical answers, probes, runs, reuse notes and outcome hash 2d00cf7739667e3995f7095e4a18c3dfbdd3e84bba325c4250c69410f10feaab. The real three-model tune gate passed all nine task rates with zero delta and 84 fresh answers plus paraphrase probes. The full npm suite passed 1317 tests with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: the tokenizer rejects unknown identifiers, escapes, arrays, assignment, updates, callbacks and constructors, and every accepted answer was compared byte-for-byte with the sandbox; PRINCIPLE-009: validation and verdicts live in a single-purpose module with two exports; PRINCIPLE-010: child startup is removed only for a proven pure class and the caller's output cap forces a sandbox fallback; PRINCIPLE-014: failing-first whitelist/rejection tests, 180 real verdicts, full tune hashes and the real gate; G-001/G-003: prompts, checks, generation and suite versions are unchanged.

### ADR-318: Cache the check portion of judge keys
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: Judge key construction serialized the whole check object for every answer even though suite check objects are frozen for the process and reused across many texts
- **Decision**: Cache the serialized entry/setup/harness/cases/timeout suffix per check object in a process-local WeakMap keyed by timeout, keeping the text as the only per-call serialization and resetting the cache with the judge caches
- **Consequences**: A 20,000-call interleaved microbenchmark improved key construction 9.881ms to 2.542ms (3.89x). Against the committed prior judge, 180 real stored answers kept verdict hash eccbbcd9a973464273c8aa3fc583ffd0a2a8d0cfdb424bee544536dcc9240e51 with zero child spawns; the small end-to-end path improved 5.334ms to 4.938ms under 13.3 percent A/A drift. The real three-model tune gate passed all nine task rates with zero delta, 78 fresh answers and six reused answers plus paraphrase probes. The full npm suite passed 1318 tests with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: the text and suffix parts remain separate and the new key form was compared on 180 real answers with an identical verdict hash; PRINCIPLE-010: repeated check serialization is removed on the hot path; PRINCIPLE-013: the WeakMap is process-local and reset with the judge caches; PRINCIPLE-014: a failing-first serialization-counter test and the full judge suite pass; G-001/G-003: no prompt, check, setting or suite version changes.

### ADR-319: Memoize model-independent tune estimates
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: The tune estimate route asked `expectedAnswers` and `estimateTune` six times per installed model although the steps and all non-pace options are identical for every model in a request
- **Decision**: Add `createTuneEstimator(steps, options)`, memoize each distinct `(quick, secondsPerAnswer)` result for that helper, and use one helper for the whole `/api/tune/estimate` request including its empty-model fallbacks
- **Consequences**: A ten-pair interleaved 60-model request A/B improved 6.587ms to 0.147ms (44.8x) with identical output under 3.6 percent A/A control drift. Twenty-four direct option combinations were compared against the original pure functions with identical results, server and tune-grid tests pass, and the full npm suite passed with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: the cache key includes every non-pace option plus quick and pace, and the memoized result was compared with the original functions on 24 combinations; PRINCIPLE-010: model-independent work is computed once per request instead of once per model; PRINCIPLE-009: the small helper lives beside the two pure estimate functions; PRINCIPLE-014: failing-first memoization test plus `node --test tests/server.test.js tests/benchmark-tune.test.js`; G-001/G-003: generation, prompts, checks, settings and suite version are untouched.

### ADR-320: Cache the OpenAI model lookup index
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: Every /v1/models/{id} request scanned the public model list once by id and again by file name, repeating the .gguf strip for every model
- **Decision**: Build one WeakMap-cached id and file-name index per registry and public-list version, with separate maps so id matches keep precedence and the first model in list order wins duplicate keys
- **Consequences**: A 200-model 8,000-lookup interleaved A/B improved 57.222ms to 0.526ms (108.7x) with identical results for every id, exact file name, stripped file name and miss under 0.5 percent A/A drift. A failing-first test pins one index build plus id/file precedence; 98 OpenAI, server and external-engine tests pass, and the full npm suite passed 1320 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: the index compares id matches before file matches and preserves first-list-order duplicates, with every accepted key checked against the old lookup; PRINCIPLE-009: a small cache and lookup pair sits beside the OpenAI route; PRINCIPLE-010: repeated scans and `.gguf` stripping are removed; PRINCIPLE-013: the WeakMap is process-local and versioned by public-list rebuilds; PRINCIPLE-014: failing-first precedence test, benchmark and full suite.

### ADR-321: Cache shipped-preset model lookups
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: The preset routes scanned the public model list once per recipe; with 30 presets and 60 models a synthetic A/B improved 2.871ms to 0.392ms, while a three-preset request could be neutral or slightly slower if the map were rebuilt each time
- **Decision**: Keep one WeakMap profile-ID model map per registry and public-list version, preserve first-list-order matches, and use it for both /api/presets and /api/presets/apply
- **Consequences**: Production repeated-request A/Bs over 200 requests measured 0.068ms to 0.056ms (1.2x) for 3 presets and 16 models, 0.063ms to 0.062ms (neutral) for 3 by 60, and 1.329ms to 0.207ms (6.4x) for 30 by 60, with identical lookup results. A failing-first test pins one map build and first-match behavior, 48 server/preset tests pass, and the full npm suite passed 1321 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: duplicate profile ids keep the first public-list match and all route responses stay unchanged; PRINCIPLE-010: repeated linear scans are replaced by one versioned map; PRINCIPLE-013: the WeakMap is process-local and versioned by public-list rebuilds; PRINCIPLE-014: failing-first test, three synthetic A/B shapes and full suite; G-001/G-003: no generation, prompts, checks, settings or suite versions changed.

### ADR-322: Stop discarded settings serialization in itemOutcomes
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: countRow serialized every answer's settings object even after an item had reached its 16 distinct-setting cap, so the key was computed only to be discarded on thousands of rows per tune start
- **Decision**: Check the distinct-setting cap before JSON.stringify and increment a process-local test counter only when a key is actually serialized
- **Consequences**: A 20,000-row interleaved A/B over the real itemOutcomes function improved 37.635ms to 31.634ms (1.19x) with identical counts and saturation under 0.4 percent A/A drift; the isolated counting loop improved 8.162ms to 1.406ms with 20,000 to 1,600 stringifies. A failing-first test pins the 16-serialization cap, 22 outcome/restore tests pass, and the full npm suite passed 1322 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: the guard moves before the discarded serialization without changing counts, saturation or error handling; PRINCIPLE-010: 18,400 stringifies per 20,000 rows are avoided; PRINCIPLE-014: failing-first counter test, exact old/new outcome hash and full suite; G-001/G-003: generation, prompts, checks, settings and suite versions are untouched.

### ADR-323: Give listProfiles stats a short TTL
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: The parsed profile summaries were cached but every UI poll still stat'ed each profile file to rebuild the directory stamp; 60 profiles meant 60 repeated stats per poll
- **Decision**: Reuse the stat pass and per-file stamps for one second when the sorted .json name list is unchanged, keep readdir on every call so additions and removals invalidate immediately, and clear the cache on saveProfile
- **Consequences**: A 60-profile 200-call A/B improved 215.053ms to 23.065ms (9.32x) with identical summaries and one stat pass per run instead of 60. A failing-first stat-count test plus add/remove, stamp-reuse and server tests pass, and the full npm suite passed 1323 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: readdir still detects added/removed files on every call, saveProfile invalidates immediately, and loadProfile's stale known stamp still forces a fresh read; PRINCIPLE-010: unchanged polls skip 59 of 60 stats per run; PRINCIPLE-013: the cache is process-local and bounded by directory entries; PRINCIPLE-014: failing-first counter test plus exact old/new summary comparison.

### ADR-324: Persist the history run-scope migration
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: openDatabase executed a full-table JSON backfill on every report, record and link call, even after every row already had a scope
- **Decision**: Create a migrations table and run the run_scope backfill only when its marker is absent, recording the marker in the same transaction; legacy databases still backfill when the marker is removed or missing
- **Consequences**: A 20-open A/B on a 15 MB populated database improved 598.327ms to 424.068ms (1.41x); bench:report improved 715.390ms to 653.177ms (1.10x) under 14.5 percent A/A drift. A failing-first persistence test and 28 history/report tests pass, and the full npm suite passed 1324 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: scope derivation SQL is unchanged and a missing marker still backfills legacy databases; PRINCIPLE-010: repeated full-table scans are removed after the first open; PRINCIPLE-013: the marker is written in the same transaction as the backfill and survives later opens; PRINCIPLE-014: failing-first persistence test, legacy test update, report/open benchmarks and full suite.

### ADR-325: Cache reused cachedAnswers settings keys
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: cachedAnswers kept parsed row objects across restore preflight passes but still serialized each row's settings for the grouping key on every call
- **Decision**: Keep a bounded WeakMap keyed by reused row object inside createTuneHistoryCache, with FIFO eviction, stats and reset; fresh text-scanned rows still serialize directly
- **Consequences**: A 20,000-row 40-call A/B improved 7,020.800ms to 6,280.008ms (1.12x) under 15 percent A/A drift, with identical groups and 15,000 key hits. A first settings-keyed prototype regressed because JSONL parsing gives every row fresh settings objects; row keying fixed it. Failing-first hit and bound tests plus 56 restore tests pass, and the full npm suite passed 1326 with one pre-existing skip after one unrelated timing-sensitive streaming test failed under load on the first run and passed cleanly on rerun.
- **Cross-principle check:** PRINCIPLE-003: fresh text-scanned rows still serialize normally and only reused history-cache rows take the memo path, so group keys and output are unchanged; PRINCIPLE-010: 15,000 repeated serializations become hits in the benchmark working set; PRINCIPLE-013: the WeakMap is process-local, bounded and reset with the history cache; PRINCIPLE-014: failing-first hit/bound tests and exact old/new group comparison.

### ADR-326: Resume history imports from a persisted byte offset
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: Every report and link re-read and re-parsed the entire 6.8MB append-only history.jsonl and rechecked every already-imported uid
- **Decision**: Store an import byte offset, file size, mtime and database row count in SQLite; parse only bytes after that offset, reset on truncation, rewrite, inode/row mismatch or rebuild, and keep the partial trailing line for the next import
- **Consequences**: A five-round bench:report A/B on the populated history improved 101.506ms to 68.976ms (1.47x) under 0.1 percent control drift. A failing-first test proves only appended bytes are parsed, and rebuild plus all history/report tests pass. The full npm suite passed 1327 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: damaged, partial and rebuilt histories still reparse correctly and run/link rows are unchanged; PRINCIPLE-010: unchanged prefixes skip the whole parse; PRINCIPLE-013: the offset, file stamp and row count are stored in SQLite and reset on rebuild or invalidation; PRINCIPLE-014: failing-first appended-bytes test plus history/report suites.

### ADR-327: Give positive receipt validation a short TTL
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: Present receipts were parsed once but every API poll still stat'ed each sidecar to validate the cached object, about 5ms per poll for a 200-model library
- **Decision**: Reuse a positive receipt's stat validation for one second, while keeping writer invalidation, stamp validation on expiry and the separate short negative TTL
- **Consequences**: A 200-receipt 50-poll A/B improved 81.319ms to 5.803ms (14.01x) with identical receipt digests and 2.2 percent control drift. A failing-first stat-counter test, invalidation tests and 54 targeted tests pass, and the full npm suite passed 1328 with one pre-existing skip.
- **Cross-principle check:** PRINCIPLE-003: stamp validation still runs on expiry and writer invalidation clears positive entries, so edited receipts are detected; PRINCIPLE-010: 9,950 repeat stats are skipped per benchmark run; PRINCIPLE-013: the TTL is process-local and resettable; PRINCIPLE-014: failing-first TTL/counter test plus receipt, server and registry suites.

### ADR-328: Share paired diffs across guard views
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: balancedChoice recomputed the same ordered per-item differences for every coding view and every candidate, once per view even though the comparison pair was fixed
- **Decision**: Compute pairedDiffs once per candidate comparison and filter that shared result for each view; keep public groupEvidence behavior unchanged when no shared diff is supplied
- **Consequences**: An eight-view counter check dropped pairedDiff builds from eight to one with identical b/c/p evidence. Full clustered and plain sweep A/Bs were neutral within noise (0.9x to 1.02x) because Monte Carlo signature draws dominate; no wall-time gain is claimed. All tune tests pass.
- **Cross-principle check:** PRINCIPLE-003: shared diffs are derived from the same ordered before/after comparison and filtered per view, so b/c/p and guard outcomes are unchanged; PRINCIPLE-010: repeated per-view diff construction is removed; PRINCIPLE-014: failing-first counter test plus group-guard tests and full tune suite.

### ADR-329: Cache evaluator load signatures per settings object
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: ensureLoaded rebuilt three pick maps and two JSON.stringify signatures on every evaluate call although a tune candidate reuses one settings object across seeds, looks and chunks
- **Decision**: Keep a WeakMap per evaluator from settings object and width to the derived load object and model/context signatures, so repeated measures of one candidate reuse the same signatures and load decisions
- **Consequences**: A 1,000-call interleaved A/B improved 10.662ms to 9.013ms (1.18x) with identical result rows, one load and no reconfigure; the nine candidate measurements performed nine signature builds. One hundred eight evaluator/tune tests pass, and the real three-model tune gate passed all nine task rates with zero delta and 84 fresh answers plus paraphrase probes.
- **Cross-principle check:** PRINCIPLE-003: the cached load object and signature strings are computed from the same LOAD_KEYS and width, so load/reconfigure decisions and answers are unchanged; PRINCIPLE-010: repeated pick and JSON.stringify work is removed on the hot measure path; PRINCIPLE-013: the WeakMap is process-local and scoped to one evaluator; PRINCIPLE-014: failing-first counter test, exact row hash and evaluator/tune suites.

### ADR-330: Share one generation-path scan between gate digests
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: tune-gate computed answer and evidence digests independently, rebuilding and re-reading the same engine import closure twice
- **Decision**: Scan the generation import path once, then pass the shared file list with each digest's answer/judge driver list to generationDigest and answerDigest
- **Consequences**: A twelve-pair direct A/B improved 4.616ms to 3.459ms (1.33x) with identical answer and evidence digests. A failing-first scan counter and 35 gate/report tests pass. The real three-model tune gate passed all nine rows with both code deltas inside their tolerance.
- **Cross-principle check:** PRINCIPLE-003: the shared file list is the same sorted import closure each digest built on its own, so answer and evidence digests stay byte-identical; PRINCIPLE-010: one import-closure scan replaces two; PRINCIPLE-014: failing-first scan counter plus gate-cache and report suites and a direct digest A/B; PRINCIPLE-016: the gate's answer fingerprint is unchanged, so cached answers stay valid.

### ADR-331: Cache seeded sign patterns for Monte Carlo sign flips
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: monteCarloSignedSums rebuilt the same deterministic 10,000-by-count LCG sign matrix on every p-value although the seeded sequence depends only on count and permutations
- **Decision**: Build the Int8Array sign table once per (count, permutations) and reuse it in the sum loop, counting logical draws exactly as before
- **Consequences**: Six p-values stayed bit-identical in a twelve-pair interleaved A/B at 7.33x (23.029ms to 3.143ms); twelve clustered sweep comparisons stayed identical at 5.58x (46.657ms to 8.356ms). A failing-first counter and 38 stats tests pass, as does the real three-model tune gate with 9/9 rates unchanged.
- **Cross-principle check:** PRINCIPLE-003: ±1 multiplication reproduces the original high-bit sign choice bit-for-bit, verified against the seeded reference and full sweep evidence; PRINCIPLE-010: the LCG state generation leaves the hot permutation loop; PRINCIPLE-013: the table is process-local and keyed by count and permutation width; PRINCIPLE-014: failing-first counter plus exact reference p-values and interleaved A/Bs.

### ADR-332: Select score medians in place
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: score copied and fully sorted six fresh arrays per rung although only the middle rank determines the summary
- **Decision**: Use an in-place O(n) rank selection for the six score medians while keeping the exported non-mutating median for other callers
- **Consequences**: A twelve-pair interleaved A/B over 20 scores per run improved 3.460ms to 1.783ms (1.94x) with an identical stats hash; 20,000 randomized median cases matched the sorted reference. A failing-first counter and 125 tune tests pass, as does the real three-model tune gate.

### ADR-333: Derive score outcome maps in one pass
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: score built majority, outcomes, fractions and credit through four Object.fromEntries calls that allocated eight intermediate pair arrays per rung
- **Decision**: Fill the internal majority map and the three plain result objects in one loop over the fraction map
- **Consequences**: A twelve-pair interleaved A/B over 20 scores improved 1.434ms to 1.181ms (1.21x) with an identical stats hash; a failing-first counter and 126 tune tests pass, as does the real three-model tune gate.

### ADR-334: Compute score's latency spread with plain loops
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: stdev invoked a reduce closure twice per score although the two passes only need a sum and a sum of squared deviations
- **Decision**: Replace both reduces with plain loops that keep the same two-pass arithmetic order and therefore the same rounded result
- **Consequences**: A twelve-pair interleaved A/B over 20 scores improved 1.368ms to 1.148ms (1.19x) with an identical stats hash; 20,000 randomized cases were bit-identical. A failing-first counter and 127 tune tests pass, as does the real three-model tune gate.

### ADR-335: Build paired differences in one scan
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: pairedDiffs chained filter, map and filter over Object.entries, allocating three intermediate arrays for every comparison
- **Decision**: Accumulate nonzero ordered differences directly into one array, keeping the same credit/fractions/majority precedence and order
- **Consequences**: A twelve-pair interleaved A/B over 16 comparisons improved 0.1352ms to 0.0945ms (1.43x) with an identical diff hash; a failing-first counter and 121 tune tests pass, as does the real three-model tune gate.

### ADR-336: Count grouped guard before-rates once
- **Date**: 2026-11-27
- **Status**: Accepted
- **Context**: balancedChoice recomputed the incumbent's per-view pass rate for every survivor and groupRate filtered an array per view
- **Decision**: Precompute the incumbent's view rates once per guard and count candidate view passes with a plain loop while keeping the same grouped stats
- **Consequences**: A twelve-pair interleaved A/B over real grouped code tunes improved 0.9039ms to 0.8155ms (1.11x) with an identical guard hash; 52 cached before-rates and 78 loop counts were observed. A failing-first counter and 119 tune tests pass, as does the real three-model tune gate.
