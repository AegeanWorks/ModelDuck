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
- **Status**: Accepted
- **Context**: The app defaulted to a 4096-token context, and the tuner passed only the smallest size that covered the selected tasks to the memory budget (ADR-043's memory-first reading), so every installed profile and fresh tune landed at 4K. That is too small for the suite's comprehension and recall prompts (up to ~16.5K including answers), and 4K long-context items fail with "context is full". The user asked for more context: a 16K default, no 4K.
- **Decision**: `DEFAULT_SETTINGS.contextSize` is 16384; the Balanced and Quality-first presets use 16K (Token-saver and Cheap stay at 2K by design); the tuner's load defaults and the engine fallbacks use 16K. The quality stage now passes every size that covers the task need to `budgetContext`, so the largest that fits is chosen (memory permitting) rather than the smallest. The frozen `baseline-profiles.json` load stays at 4096 so the gate's regression reference keeps comparing like with like. `TUNER_VERSION` stays 9: task settings and the measurement method are unchanged; only the default and the load preference moved.
- **Consequences**: Fresh tunes on this machine select 16K (Qwen 0.5B measured 117,730,336 B at 16K); a tight machine still falls back to the largest size that fits, and the load fit check remains the backstop. The three installed profiles and their recipes moved to 16K, with `.before-16k-context-20261109` backups. Tests that asserted the old default were updated; the tune gate stays green because it measures the frozen 4K baselines.

### ADR-089: Context is a fixed 16K floor, not a tuning axis or a preset
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: ADR-088 raised the default to 16K but left the context in the tuner's quality stage and in the presets. The short test questions cannot tell context sizes apart, so the only effect of searching it is memory; passing the memory budget the smallest covering size reintroduced 4K profiles. The project is coding-focused and needs context, so a tuner or preset must not be able to lower it below 16K. Supersedes the preset and quality-stage parts of ADR-088.
- **Decision**: Context is no longer tunable: `DEFAULT_STEPS.load` and the step validator drop `contextSize`, `qualityAxes` tunes only `kvCache`, and the tune job no longer budgets context. `normalizeSettings` clamps it to 16384–32768, so every settings save and load is at least 16K; no setting preset overrides it. The engine no longer retries a load at 3K/2K/1K, so an out-of-memory load fails with its actionable error instead of silently shrinking the request. The frozen baseline profiles' load moves to 16384 with their settings and rates untouched, and the gate re-measures at that floor. `TUNER_VERSION` stays 9 because the measured settings and method are unchanged.
- **Consequences**: Profiles and presets always serve at least 16K (a model trained for less is clamped to its trained size by the engine). A memory-tight machine may refuse a 16K load; **Load anyway** and a smaller model remain the levers. Tests pin the floor, the absence of a context step or setting name, and the KV-only quality stage; the tune gate stays green.
