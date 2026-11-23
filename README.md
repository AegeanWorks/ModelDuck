# ModelDuck

<!-- aegean:media:start -->
<p align="center"><img src="assets/social-preview.svg" alt="Modelduck social preview" width="100%"></p>
<p align="center"><a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f9e44" alt="License"></a> <a href="https://github.com/AegeanWorks/AIKit"><img src="https://img.shields.io/badge/AIKit-integrated-6f42c1" alt="AIKit Integrated"></a></p>
<!-- aegean:media:end -->


**Finds the best inference engine for your model, on your machine, and serves with it.** A local GGUF model
server and coding-model tuner with an OpenAI-compatible API. Runs on the CPU or a GPU; no cloud account, no telemetry. Weights and prompts stay on your
computer; the only network requests are model downloads you start and the one-time,
checksum-verified llama.cpp engine download. The tuner measures quality per
second and per GB on your machine, so a preset is evidence, not a guess.

Each model is timed on every engine (node-llama-cpp, llama-server, Ollama, vLLM...); the winner is saved in that model's profile, used to tune and to serve (2.6x the in-process default here).

ModelDuck has no chat UI: its page is a control panel for Models, Bench & Tune,
Settings and Server. Chat or code with any OpenAI-compatible client pointed at
`http://127.0.0.1:4141/v1` (ChatDuck, the former companion client, is archived).

## 30-Second Cold-Start Quick Reference

- **Runtime Prerequisites**: Node.js 20 or newer, 8 GB RAM, and a modern browser.
  `POST /api/code/verify` needs Node 25+, the first release whose sandbox denies network access.
  Windows 10/11 is tested; macOS and Linux share the commands.
- **Model folder override**: `MODELDUCK_MODELS=D:\Models` or `--models D:\Models`.
- **Data folder override**: `MODELDUCK_HOME=D:\ModelDuckData` or `--home D:\ModelDuckData`.
- **Canonical Regression Shield Gate**:
  ```bash
  npm test
  ```
- **AI Tune Shield Gate** (G-001):
  ```bash
  npm run tune:gate
  ```
  Re-measures the three core models' baselines per task and fails when a
  task loses more than one item; `--update-baseline` re-tunes deliberately.
  Cross-model `bench`/`bench:all`/`bench:full` is optional and never gates.

### First run

1. Double-click **`start.bat`** (Windows) or run:
   ```bash
   npm install
   npm start
   ```
   The first run installs `node-llama-cpp` and its prebuilt CPU runtime, and `start.bat`
   also downloads the llama.cpp inference engines (CPU and Vulkan builds, about 65 MB,
   checksum-verified). Elsewhere run `npm run engines:install` once. See
   [Inference engines](#inference-engines).
2. ModelDuck opens at **http://127.0.0.1:4141**. On Windows it uses an installed
   Edge or Chrome to open a standalone app window; otherwise your default
   browser. Closing the window leaves the server running; **Ctrl+C** quits, letting
   a running reply finish first (press it twice to quit at once).
3. Click **Models → Discover**, download a starter model, then **Install → Load**.
4. Open **Bench & Tune → Tune** to optimize the model, or **Models → Load** to serve it.
   To chat, point any OpenAI-compatible client at `http://127.0.0.1:4141/v1`.

Bundled: none. For code start with **Qwen2.5 Coder 1.5B Instruct** (1.1 GB, the
best shipped preset: 54.2% on code), or **Qwen2.5 0.5B Instruct** (469 MB) to start small.

### Inference engines

ModelDuck tunes and serves on the fastest inference engine it can find. The device (CPU/GPU) stage of every tune first times each engine on your model (speed and version, shown in the Bench panel), then judges them on the tune's own items. The fastest one that answers as well as the CPU is used for every later stage, named in the profile, and used when the model is loaded; if it cannot start, the in-process engine serves and the status says so.

| Engine | Where it comes from |
|---|---|
| node-llama-cpp: CPU, Vulkan, CUDA, Metal | built in, the default |
| llama.cpp `llama-server`: cpu, vulkan, cuda | `npm run engines:install` (official builds, checksum-verified; `start.bat` runs it on first launch) |
| Ollama | a running server |
| vLLM, SGLang, TGI, mistral.rs, koboldcpp, llamafile, LM Studio | `--openai-engine name=url`, measured only |
| Your own | `engines:add` (llama.cpp forks), `--engine-plugin <file>` |

`npm run engines -- --model <file.gguf>` times them without tuning. The decision rules, what each engine can and cannot do, measurements, and how to add an engine: [docs/ENGINES.md](docs/ENGINES.md).

### AIKit Commands (run from the AIKit folder)

| Role | Command |
|---|---|
| Status, task and gates | `python aikit.py status modelduck` |
| Phase 4: every gate | `python aikit.py check modelduck` |
| Repair memory and map, then check | `python aikit.py fix modelduck` |
| Resume an interrupted task | `python aikit.py resume modelduck` |

### Useful commands

```bash
npm start -- --port 4141 --no-open
npm start -- --home D:\ModelDuckData --models D:\Models
npm run dev                  # restart on source changes
npm test                     # hermetic unit + integration tests
npm run test:parallel        # same suite, split into parallel segments (fastest full run)
npm run test:parallel -- --shard 1/3   # one segment only (CI matrix: 1/3, 2/3, 3/3)
npm run ui:smoke             # headless control-panel and dialog check
npm run tune -- --model qwen2.5-0.5b-instruct-q4   # tune one model (reuses a saved profile)
npm run tune -- --model <id> --tasks code,comprehension --force   # re-tune chosen tasks
npm run tune -- --model <id> --interactive   # choose every setting's steps first
npm run tune -- --model <id> --stages quality,speed   # run some stages; the rest stay default
npm run tune -- --model <id> --stages device   # about a minute: does it run faster on the GPU?
npm run tune -- --model <id> --quick --budget 5   # stop after 5 minutes, keep the best so far
npm run tune -- --model <id> --tasks code --escalate   # retest unproven leaders on fresh items
npm run bench:multistep -- --model <id>   # multistep chains: one conversation, scored per step
npm run bench:repair -- --model <id> --mode retry --repair-temperature 0.7   # tests pick among retries
npm run tune -- --model <id> --settings threads,batchSize   # re-tune only these settings
npm run tune -- --model <id> --engines   # time every inference engine first, then tune on the backends that work
npm run engines -- --model <file.gguf>   # token speed and version of every inference engine, nothing tuned
npm run tune:gate            # re-measure the core models' baseline settings (G-001)
npm run mcp                  # MCP server: the verified_code tool for coding agents
```

`MODELDUCK_GPU=auto npm start` lets `node-llama-cpp` use a detected CUDA/Vulkan/Metal
device. It is off by default so a missing driver never prevents local inference from working.

## What you get

- **Model library** — scan a folder, import a GGUF by path, or download a curated
  Hugging Face model, checked against a pinned SHA-256, with resumable `.part` downloads.
  **Discover → Add from Hugging Face** takes one `hf:owner/repo/file.gguf` reference or
  resolve link (optional pin); a name already used by another source is refused, never
  overwritten.
- **Model controls** - context size (16K floor or higher, capped by the model's trained
  length; the status bar and Settings name the cap when it applies), CPU threads and thread pool, batch size,
  context sequences, GPU backend/layers, KV cache, checkpoint interval (a pre-load
  fallback), max and memory budget,
  flash attention, mmap, temperature, top-p/top-k/min-p, repeat penalty, max reply tokens, system
  prompt, reasoning, context overflow, structured output and prompt repetition,
  saved in `settings.json`.
- **OpenAI-compatible API** — `GET /v1/models`, `GET /v1/models/:id`,
  `POST /v1/chat/completions` and `POST /v1/completions`, including SSE
  streaming, so local tools can use ModelDuck as a drop-in backend. A reasoning
  model's `<think>` block is returned as `reasoning_content` (and as streamed
  `reasoning_content` deltas), so `content` holds only the answer. This includes models whose chat template opens the block itself. The raw `/v1/completions` endpoint is left untouched.
- **Verified code** — `POST /api/code/verify` retries until your tests pass, and
  `npm run mcp` offers it to coding agents such as Kiro as the `verified_code` tool.
- **Benchmark** — its own tab and gate: run either phase and read per-test rates;
  older-suite reports appear only when asked.
- **Settings tuner** — **Bench & Tune → Tune** finds each model's best settings in order: device (CPU/GPU, partial offload when full won't fit), context + KV cache, speed (threads, batch, flash, mmap), then sampling per task; the prompt stage is opt-in, and its system prompt again (it never beat the default). A setting changes only on a clear paired gain (Holm-corrected); laggards stop early, presets are checked on unseen items, and every step is saved so tunes resume anywhere. **Run all** tunes CPU and GPU lanes; **Runs** keeps every run; the Tune panel shows quick/full estimates, a pausable queue, and **Quick pass**. **Recommended for this PC** ranks by measured quality/speed, and models not installed by the shipped presets' rates. A sampling re-tune re-measures its prompt.
- **Small surface area** — Node's HTTP server and a vanilla UI; no build or CDN.
- **Explicit state** — subsystem states (model phase, downloads, benchmark jobs)
  live in `src/state-machine.js` and are readable as JSON at `GET /api/health`;
  [docs/state-machines.md](docs/state-machines.md) maps every implicit machine
  and [docs/state-machine-proposals.md](docs/state-machine-proposals.md) records
  the verified fixes.
- **AI benchmark gate** - two phases: model reload/quantization/KV-cache settings,
  then sampling/prompting settings, with test hashes so test edits show.

## AI benchmark gate

The required gate is `npm run tune:gate` (ADR-027). This seeded, batch-1
cross-model benchmark on the real `LlamaEngine` is optional: the **model reload**
phase (`npm run bench`) changes one load setting at a time across models, and the
**model usage** phase (`npm run bench:chat`) compares sampling and prompting on a
chosen configuration.

The default set is SmolLM2 135M, Qwen2.5 0.5B and Qwen2.5 Coder 1.5B;
`--full-matrix` adds three more.
[benchmarks/README.md](benchmarks/README.md) lists every task in suite v18, and
[NOTICE](benchmarks/NOTICE-benchmarks.md) records the licences. Public items
may sit in training data; own and public questions are reported apart.

```bash
npm run bench -- --download        # first run: fetch missing models, core phase
npm run bench -- --shard 1/3        # segment 1 of 3 (run 2/3 and 3/3 alongside it)
npm run bench:merge -- --phase model --total 3   # combine the 3 shard outputs into one report
npm run bench -- --deterministic      # repro mode: batch 1, each variant 3x with a noise-floor report
                                      # (writes results/latest-repro-<phase>.json; never touches the baseline)
npm run bench:flash                 # base variants on the 16-item smoke set, minutes not hours (informational)
npm run bench:all                  # optional: add the model-usage phase
npm run bench:full                 # optional: add Llama 3B and Phi 3.8B
npm run bench -- --model <id>      # settings sweep for one model; never touches a baseline
npm run bench:update               # deliberately replace both baselines
npm run bench:update:model         # deliberately replace only the model baseline
npm run bench:update:full          # replace the model baseline with six models
npm run bench:report
npm run bench:link                 # after commit: attach the run to HEAD
```

Run the model-usage phase when sampling or prompting changes; a model-only update
leaves it on its previous suite, so use `npm run bench:all` to keep both on one suite.

A model-phase recommendation can become the chat base without rerunning the model
phase. **Use for chat** in the Bench panel, or `npm run bench -- --select-base
<variantId>`, writes `benchmarks/chat-base.json`; the next model-usage phase loads that
measured model, quantization, KV cache, context and reload settings. `--base-variant
<variantId>` uses one for a single run without saving it. With no selection, the
model-usage phase uses Qwen2.5 0.5B Q4 at its default settings.

`npm run bench -- --model <catalogId>` sweeps 17 reload settings on the 16-item
smoke set, writes `results/latest-single-model.json` and recommends per goal; it
never reads or replaces a baseline (`--update-baseline` is refused).

Shards (`--shard i/n`) are deterministic slices; `bench:merge` combines them (same
`--tag` when scopes share a folder) and refuses mismatched suites, hashes,
runtimes or settings. Shards never touch a baseline.

Every run records `suiteVersion`, a SHA-256 `testHash`, `runtimeMs`, model
settings and sampling settings. A result delta is only attributed to a parameter
when the test hash matches the baseline; a prompt/check/matrix edit must bump the
version, update [benchmarks/CHANGELOG.md](benchmarks/CHANGELOG.md) and update the
baseline deliberately. Form presets only fill the settings form; trust them after
both phases pass. Shipped tune presets (`benchmarks/presets`) apply only when you
click **Apply** under Bench & Tune → Shipped presets; on another computer only
their sampling and prompt settings apply.

The test hash covers the global and per-variant system prompts, `promptIds`, and
the sampling fields used by the matrix. Each run also records the node-llama-cpp
and Node versions plus every model's GGUF chat-template hash; a baseline with a
different runtime, model file size or chat template is refused unless
`--update-baseline` is passed deliberately. Each generation returns a manifest
fingerprint over the effective system prompt, the exact truncated history, the
repeated prompt, sampling settings and model/runtime identity; the same manifest
is stored on chat messages, exposed as the OpenAI `system_fingerprint`, and
written to the benchmark history.

Baseline files are `benchmarks/baseline-model.json` and
`benchmarks/baseline-chat.json`; the committed files predate suite v14, so
regenerate both before treating a delta as a regression. The local SQLite and JSONL history live in
`benchmarks/history.sqlite` and `benchmarks/history.jsonl`. The **Bench** button
in ModelDuck starts either phase with live progress and shows every test
percentage, runtime, suite/test hash and the linked commit; four recommendation
cards (best quality, overall, coding, fastest within 5 points) only fill the
settings form. Run both phases for every generation change. A quality
drop exits 1; a speed drop over 20% only warns. Generated code runs in a
Node permission-model sandbox (5-second timeout, empty environment, results compared
by the parent so an answer cannot forge a pass): no file, child-process or worker
access, and no network from Node 25 on. It is not OS-level containment; see
`docs/THREAT-MODEL.md`.


## Screenshots

[Gallery and video storyboard](assets/screenshots/README.md) · [social preview](assets/social-preview.png). Pre-redesign shot; fresh captures via `npm run ui:shots` (ADR-081).

## Where things live

| Item | Default | Override |
|---|---|---|
| Models | `~/.modelduck/models` | `--models <folder>` |
| Settings | `~/.modelduck/settings.json` | `--home <folder>` |
| Server settings + key hashes | `~/.modelduck/server-settings.json` | `--home <folder>` |
| Tuned model profiles | `~/.modelduck/profiles/<model>.json` (load settings and per-task presets) | `--home <folder>` |
| Tune runs | `~/.modelduck/tune-runs/` (every run and answer) | `--home <folder>` |
| Tune steps | `~/.modelduck/tune-grid.json` (values per setting) | `--home <folder>` |
| Downloads | `~/.modelduck/models/*.part` | `--models <folder>` |

The models folder is ordinary storage. Copy a `.gguf` file into it and press
**Refresh**; ModelDuck reads only the GGUF header, not the weights, to list it.
Before parsing, it checks every count and length in that header against the file
size. A file that fails is listed as **Blocked** or **Unreadable** with the
reason, cannot be loaded, and is refused on import.

Only loopback bindings are accepted. The server also checks the `Host` and
`Origin` headers, so a random website cannot talk to your local model through
your browser.

Threat model: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) names the seven
local-inference parties (user, model publisher, host OS, LAN clients,
skill/tool publisher, benchmark publisher, runtime supplier).

## Model guide for CPU machines

| Model | Size | RAM while loaded | Feel |
|---|---:|---:|---|
| Qwen2.5 0.5B Q4 | 469 MB | ~0.9 GB | Fast; short answers and drafting |
| Qwen2.5 0.5B Q5 | 498 MB | ~1.0 GB | Slightly better fidelity |
| Qwen2.5 0.5B Q8 | 644 MB | ~1.2 GB | Near-lossless ceiling for the family |
| Qwen2.5 1.5B Q4 | 1.1 GB | ~1.8 GB | Best everyday balance |
| Qwen2.5 Coder 1.5B Q4 | 1.1 GB | ~1.8 GB | Code snippets and explanations |
| Llama 3.2 3B Q4 | 2.0 GB | ~3.2 GB | Different family; CPU-friendly |
| Phi-3.5 Mini Q4 | 2.4 GB | ~3.8 GB | Reasoning near the 4 GB mark |
| Mistral 7B Q4 | 4.4 GB | ~6.5 GB | Heavy; 16 GB RAM and patience |

Rough numbers; the app reports real context and memory.

**For code, spend memory on model size, not precision.** Measured greedy on all
142 code items (i5-14400F, Radeon RX 9060 XT; one machine):

| Model file | Code | vs Coder 1.5B Q4 |
|---|---:|---|
| Qwen2.5 Coder 1.5B Q4_K_M (1.0 GB) | 60.6% | — |
| Qwen2.5 Coder 1.5B F16 (2.9 GB) | 60.6% | 5 won, 5 lost |
| Llama 3.2 3B Q4_K_M (1.9 GB) | 60.6% | 17 won, 17 lost |
| Phi-3.5 Mini Q4_K_M (2.2 GB) | 50.0% | 9 won, 24 lost (p=0.007) |
| Qwen2.5 Coder 0.5B F16 / Q8_0 | 41.5% / 40.8% | — |

Untuned, generation uses half the logical cores on CPUs with SMT: on that CPU,
Coder 1.5B ran 3.9 tok/s on 15 threads and 28.8 on 8. ARM chips (Apple Silicon
too, also when Node runs x64 under Rosetta, which is not yet verified on a Mac) and
Linux CPUs without SMT keep all logical cores but one. A saved `threads` value still wins.
Q4_K_M lost nothing measurable against F16 for code. The 1.5B coder matched a 3B
general model at about half the memory and time.

Q4_K_M is lossy in principle: expect small quality drift versus the Q8_0 ceiling
in the same family. No catalog entry uses imatrix calibration. Memory math is fixed
bytes (weights + KV + runtime reserve); the Q5 entry costs ~30 MB more
weights than its Q4 sibling.

## OpenAI-compatible API

ModelDuck serves a loopback-only, unauthenticated API; Server settings can
require keys, enable CORS or LAN binding after a restart. With a key, settings
and model/download changes stay local; a LAN client may read and chat.

```bash
curl http://127.0.0.1:4141/v1/models

curl http://127.0.0.1:4141/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "modelduck",
    "messages": [{"role": "user", "content": "Say quack in one sentence."}],
    "stream": false
  }'

curl http://127.0.0.1:4141/v1/completions \
  -H "content-type: application/json" \
  -d '{
    "model": "modelduck",
    "prompt": "The capital of France is",
    "max_tokens": 16,
    "stream": false
  }'
```

The `model` field is accepted for compatibility; the loaded model answers.
`GET /v1/models[/:id]` lists installed models (unknown ids 404); text completions
take one string prompt. A tuned model's task preset (`x-modelduck-task`: code,
comprehension or recall; or a `modelduck_task` body field, with the header
winning; default code) sets the chat defaults; values you send win.
`response_format` applies to that request only: `text`, `json_object`, or
`json_schema` with a client schema up to 12,000 characters; other types are a 400.
Parameters this server cannot honour (`n>1`, `best_of`, non-zero penalties,
`logprobs`, `echo`, `suffix`, tools, audio) are also a 400 `unsupported_parameter`,
never silently ignored.

In an OpenAI SDK, set `baseURL: "http://127.0.0.1:4141/v1"` and any API key
(ModelDuck ignores it). `stream: true` returns standard `data:` chunks ending
with `data: [DONE]`.

## MCP: verified code for coding agents

`npm run mcp` is a stdio MCP server with one tool, `verified_code`: give a
prompt and tests (`{ entry, cases }`), get code that passed them. It calls
`/api/code/verify` on 127.0.0.1, so start ModelDuck and load a model first.
In Kiro, add to `.kiro/settings/mcp.json` (`--port` if not 4141):

```json
{ "mcpServers": { "modelduck": { "command": "node",
  "args": ["<ModelDuck folder>/src/mcp-server.js"] } } }
```

## API server settings

The **Server** panel controls the local API surface:

| Setting | Behaviour |
|---|---|
| Server port | Saved for restarts; CLI `--port` overrides it for one run |
| Require authentication | Requires `Authorization: Bearer <key>` or `X-API-Key` on `/v1/*`; also protects `/api/*` for clients from other machines |
| Active API keys | Generate then revoke; only a SHA-256 hash is stored |
| Serve on local network | Binds `0.0.0.0` on restart; needs Require authentication, else startup turns it off with a warning |
| Enable CORS | Adds `Access-Control-Allow-Origin: *` and answers preflight on `/v1/*` only; needs Require authentication |
| Just-in-time loading | `/v1/chat/completions` loads a named installed model on demand |
| Auto unload unused JIT | Unloads a JIT model after the idle TTL |
| Max idle TTL | 1–1440 minutes |
| Only keep last JIT model | On: a new JIT request replaces the previous JIT model. Off: a second JIT request is refused while a model is loaded |
| Per-request MCPs / mcp.json | Persisted switches for a future MCP adapter (no tools yet) |

Web pages from another site are refused (`403 cross_site_refused`) on every route except `/v1/*` with CORS on; a loopback-bound request must also name a loopback host, so a DNS-rebound page cannot pass as the UI.

Endpoints (selected; `src/server.js` has the complete route list):

```text
GET|PUT /api/server-settings
POST    /api/server-settings/api-keys
DELETE  /api/server-settings/api-keys/:id
GET     /api/benchmarks  /suite  /status
POST    /api/benchmarks/run  /cancel  /base
GET     /api/recommendations
GET     /api/profiles  /:id  /:id/export
POST    /api/profiles/import
GET     /api/presets          shipped presets and how each fits here
POST    /api/presets/apply    apply one on request; never over a tune made here
POST    /api/code/verify      retry until code passes your tests (local only)
GET     /api/tune/overview  /status  /estimate  /stream
POST    /api/tune/start  /pause  /resume  /priority  /cancel
GET|PUT /api/tune/steps
```

`GET /api/benchmarks` returns the two baseline phases, recent linked runs, own
versus public item rates and recommendations from the latest model run. The run
endpoints are loopback-only, start one child benchmark at a time and refuse
while a reply generates so measurements stay comparable. Settings,
model and download changes stay local.
`POST /api/benchmarks/base` saves one model-phase variant as the base the next
chat-phase run loads. `POST /api/benchmarks/run` with `{"phase":"tune","model":"<id>"}`
tunes one installed model (optional `tasks`, `force`, and `stages` from device, quality,
speed, sampling, prompt); a saved profile is reused unless `force` is true, and chosen
`stages` or `settings` are measured again on top of the saved rest, even when out of date.
The profile is saved after every setting, so a stopped tune applies and later resumes.
`POST /api/tune/start` with `{"models":"all"}` (one id, a list, or `"all"`) tunes several models
side by side: device probes first, then 1 CPU lane and 2 GPU lanes by default (`lanes` in
`tune-grid.json`, set per PC); speed measurements pause the other tunes. `GET /api/profiles/:id` returns the profile with `stale`,
`staleParts` and `warnings` when the suite, items, runtime, CPU or model file changed
since a part was measured; a stale profile is still used until re-tuned.

The host's loopback UI stays key-free. Authentication covers the OpenAI-compatible
API and, for requests from another machine, the UI/API routes too.
When enabled, send `Authorization: Bearer <key>` or `X-API-Key: <key>`; keys are
shown once and only their SHA-256 hashes are stored. A LAN browser asks for the
key once and keeps it in session storage.

## GPU backends

CPU is the default, so a missing driver never blocks local inference. In **Settings → GPU
backend** choose:

- **CUDA** for NVIDIA cards with a working CUDA runtime.
- **Vulkan** for AMD/Intel GPUs (node-llama-cpp has no ROCm build).
- **Metal** on Apple Silicon.
- **Auto** lets node-llama-cpp pick, falling back to CPU if it cannot start.

Set **GPU layers** above 0 to offload layers; `0` keeps everything on the CPU.
The **Detected GPU backends** line in Settings reports what the installed runtime
can actually see, including CPU when no acceleration is available. A backend
build can require the vendor toolchain; if it fails, ModelDuck reports the reason
and the CPU path stays available.

## Troubleshooting

**The port is already in use.**
Another app (or another ModelDuck) owns 4141. Run `npm start -- --port 4142`, or
close the other process.

**“ModelDuck is already running.”**
Two processes are using the same `~/.modelduck`. A lock left by a killed process is
taken over on the next start; otherwise close the other process, or use `--home`
to give each instance its own state folder.

**A download stalls.**
After 60 seconds without data the download stops as **stalled** and frees its
slot. The `.part` file is kept. Click **Download** again to resume; ModelDuck sends a
HTTP Range request. If the server ignores ranges, it restarts safely.

**“This model will not fit in memory.”**
Before loading, ModelDuck estimates weights + KV cache at the 16K context plus
a runtime reserve against free RAM, and refuses above 75 %. **Load anyway**
overrides it. Context is not reduced silently: a load that cannot allocate 16K
fails with an error instead of shrinking.

**The model fails to load with an out-of-memory error.**
Free memory, use a smaller model or quantization, or the q8_0 KV cache. Context
is fixed at a 16K floor, so it is not a knob to shrink.

**Replies are very slow.**
CPU inference is limited by memory bandwidth. Try a smaller quantization or
model, set **CPU threads** to physical cores (not every logical thread), and keep
the 16K context unless memory is tight.

**A model is listed but marked “Unreadable.”**
The GGUF header is damaged or incomplete. Re-download it; the loader will also
refuse a file that does not start with the `GGUF` signature.

## Development

```bash
npm test
npm run test:parallel       # same gate, sharded across CPU cores
```

What the tests and `npm run ui:smoke` check: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

The benchmark needs the installed benchmark models. Use
`npm run bench -- --download` once, then run both phases for every
generation-affecting change.

## What's Inside

```text
modelduck/
├── src/
│   ├── main.js
│   ├── drain.js
│   ├── hf-reference.js
│   ├── server.js
│   ├── engine.js
│   ├── engine-catalog.js <- engine descriptors
│   ├── engine-listing.js <- engines the API lists and a load may name
│   ├── engine-env.js
│   ├── engine-install.js <- engine installer
│   ├── external-engines.js <- backends for engines outside the process
│   ├── server-engine.js <- the engine interface over one backend
│   ├── engine-router.js <- in-process or external, by load
│   ├── inference-engine-adapters.js <- engine detection and timing
│   ├── inference-engines.js <- engine speed assessment
│   ├── thinking.js <- <think> block splitter
│   ├── memory-fit.js
│   ├── model-profiles.js
│   ├── preset-match.js
│   ├── verified-code.js
│   ├── mcp-server.js
│   ├── tuned-settings.js
│   ├── tune-steps.js
│   ├── tune-scheduler.js
│   ├── tune-lock.js
│   ├── tune-runs.js
│   ├── engine-errors.js
│   ├── model-registry.js
│   ├── gguf-guard.js
│   ├── gguf-native.js <- optional in-process Rust header guard
│   ├── gpu-info.js
│   ├── downloader.js
│   ├── settings.js
│   ├── generation-manifest.js
│   ├── benchmark-report.js
│   ├── benchmark-runner.js
│   ├── benchmark-base.js
│   ├── checkpoint-merge.js
│   ├── checkpoint-policy.js
│   ├── settings-reload.js
│   ├── openai.js
│   ├── http.js
│   ├── jit.js
│   ├── server-settings.js
│   ├── config.js
│   ├── errors.js
│   ├── fs-atomic.js
│   ├── model-catalog.js
│   ├── sampler-chain.js
│   ├── state-machine.js
│   ├── recommend.js
│   └── system.js
├── engines/ <- pinned engine manifest
├── docs/
│   ├── THREAT-MODEL.md <- local-inference threat model
│   ├── ENGINES.md <- inference engines
│   ├── DEVELOPMENT.md <- what the tests check
│   ├── state-machines.md <- the 25-machine inventory and verified gaps
│   ├── state-machines.json <- machine inventory checked by tests
│   ├── state-machine-proposals.md <- judged proposals
│   ├── state-machine-proposals.json <- proposal evidence links
│   ├── tuning-improvement-report.md <- tuner review (snapshot of 6ece836)
│   ├── tuning-repro/ <- scripts that reproduce the report's numbers
│   └── kiroween/ <- Kiroween submission docs
├── public/
│   ├── index.html <- the control panel
│   ├── app.js <- state and interactions, no framework
│   ├── styles.css <- dark/light responsive theme
│   ├── redesign.css
│   └── brand/
│       └── duck.svg <- the ModelDuck mascot and favicon
├── scripts/
│   ├── capture-screenshots.mjs <- screenshot gallery
│   ├── install-engines.mjs <- npm run engines:install
│   ├── add-engine.mjs <- npm run engines:add
│   ├── test-parallel.mjs <- sharded parallel `npm test` runner
│   ├── build-native.mjs <- npm run build:native (optional Rust GGUF guard)
│   └── ui-smoke.mjs <- control-panel check
├── benchmarks/ <- seeded quality, speed and history gate
│   ├── README.md
│   ├── run.mjs
│   ├── engine-speed.mjs <- npm run engines
│   ├── merge-shards.mjs
│   ├── suite.mjs
│   ├── matrix.mjs
│   ├── public-items.mjs
│   ├── own-items-v9.mjs
│   ├── own-items-v10.mjs
│   ├── repo-items-v10.mjs
│   ├── repo-items-v11.mjs
│   ├── repo-items-v13.mjs
│   ├── own-items-v12.mjs
│   ├── own-items-v13.mjs
│   ├── comprehension-items.mjs
│   ├── paraphrase-items.mjs
│   ├── recommend.mjs
│   ├── stats.mjs
│   ├── task-ids.mjs      <- static task vocabulary, safe for server startup
│   ├── tasks.mjs
│   ├── tune.mjs
│   ├── tune-measure.mjs
│   ├── tune-speed.mjs
│   ├── tune-device.mjs
│   ├── tune-grid.mjs
│   ├── tune-evaluate.mjs
│   ├── tune-timing.mjs
│   ├── tune-parallel.mjs
│   ├── tune-adaptive.mjs
│   ├── tune-budget.mjs
│   ├── tune-failures.mjs
│   ├── sandbox.mjs
│   ├── tune-run.mjs
│   ├── tune-job.mjs
│   ├── baseline-work.mjs
│   ├── tune-gate.mjs
│   ├── model-pool.mjs
│   ├── gate-cache.mjs
│   ├── tune-baseline.mjs
│   ├── tune-prompt.mjs
│   ├── presets/         <- measured, shareable profile recipes
│   ├── NOTICE-benchmarks.md
│   ├── test-hash.mjs
│   ├── verify-manifest.mjs
│   ├── history.mjs
│   ├── report.mjs
│   ├── link.mjs
│   ├── context-curve.mjs
│   ├── stats-util.mjs
│   ├── settings-perf.mjs     <- settings code timings (npm run perf:settings; PERF.md)
│   ├── gguf-guard-perf.mjs   <- JS vs Rust header timings (npm run bench:gguf)
│   ├── multi-step-perf.mjs
│   ├── multistep-items.mjs   <- opt-in multistep chains (not tuned or gated)
│   ├── multistep-evaluate.mjs
│   ├── multistep-run.mjs
│   ├── repair-evaluate.mjs   <- opt-in repair with test feedback (not tuned or gated)
│   ├── repair-run.mjs
│   ├── benchmark-advisor.mjs
│   ├── PERF.md
│   ├── CHANGELOG.md
│   ├── history.jsonl
│   ├── curves/
│   ├── baseline-model.json
│   ├── baseline-chat.json
│   └── baseline-profiles.json
├── tests/
│   ├── helpers.js
│   ├── drain.test.js
│   ├── hf-reference.test.js
│   ├── ui-shell.test.js
│   ├── local-actions.test.js
│   ├── state-machine.test.js
│   ├── state-machine-coverage.test.js
│   ├── state-machine-proposals.test.js
│   ├── config.test.js
│   ├── checkpoint-policy.test.js
│   ├── settings-reload.test.js
│   ├── checkpoint-merge.test.js
│   ├── fs-atomic.test.js
│   ├── model-registry.test.js
│   ├── model-pool.test.js
│   ├── model-profiles.test.js
│   ├── downloader.test.js
│   ├── benchmark-suite.test.js
│   ├── benchmark-suite-v6.test.js
│   ├── benchmark-suite-v9.test.js
│   ├── benchmark-suite-v10.test.js
│   ├── benchmark-suite-v11.test.js
│   ├── benchmark-suite-v12.test.js
│   ├── benchmark-suite-v14.test.js
│   ├── benchmark-suite-v13-repo.test.js
│   ├── reference-solutions-v9.js
│   ├── reference-solutions-v13.js
│   ├── benchmark-test-hash.test.js
│   ├── benchmark-tasks.test.js
│   ├── benchmark-tune.test.js
│   ├── benchmark-tune-evaluate.test.js
│   ├── benchmark-tune-timing.test.js
│   ├── benchmark-tune-parallel.test.js
│   ├── tune-adaptive.test.js
│   ├── tune-budget.test.js
│   ├── tune-escalate.test.js
│   ├── tune-failures.test.js
│   ├── sandbox-hardening.test.js
│   ├── perf-scripts.test.js
│   ├── benchmark-multistep.test.js
│   ├── benchmark-repair.test.js
│   ├── benchmark-tune-baseline.test.js
│   ├── benchmark-suite-paraphrase.test.js
│   ├── benchmark-link.test.js
│   ├── cli-entry-guards.test.js
│   ├── benchmark-tune-stats.test.js
│   ├── tuned-settings.test.js
│   ├── jit-tuned.test.js
│   ├── engine-catalog.test.js
│   ├── engine-listing.test.js
│   ├── engine-env.test.js
│   ├── engine-contract.js <- engine backend check
│   ├── engine-install.test.js
│   ├── external-engines.test.js
│   ├── inference-engines.test.js
│   ├── openai-engines.test.js
│   ├── thinking.test.js
│   ├── engine-parallel.test.js
│   ├── engine-reconfigure.test.js
│   ├── engine-system-prompt.test.js
│   ├── engine-memory.test.js
│   ├── answer-reading.test.js
│   ├── tune-lock.test.js
│   ├── tune-runs.test.js
│   ├── gate-cache.test.js
│   ├── answer-reuse.test.js
│   ├── baseline-work.test.js
│   ├── tune-scheduler.test.js
│   ├── tune-steps.test.js
│   ├── tune-steps-store.test.js
│   ├── tune-prompt.test.js
│   ├── fifteen-push-fixes.test.js
│   ├── preset-recipes.test.js
│   ├── preset-match.test.js
│   ├── verified-code.test.js
│   ├── mcp-server.test.js
│   ├── benchmark-history.test.js
│   ├── benchmark-report.test.js
│   ├── benchmark-runner.test.js
│   ├── benchmark-base.test.js
│   ├── benchmark-recommend.test.js
│   ├── benchmark-stats.test.js
│   ├── benchmark-flash.test.js
│   ├── benchmark-context-curve.test.js
│   ├── benchmark-bench-honesty.test.js
│   ├── gguf-preflight.test.js
│   ├── matrix-determinism.test.js
│   ├── sampler-chain.test.js
│   ├── tune-quota.test.js
│   ├── wave3-settings-docs.test.js
│   ├── generation-manifest.test.js
│   ├── engine-errors.test.js
│   ├── engine-runtime.test.js
│   ├── gguf-guard.test.js
│   ├── gpu-info.test.js
│   ├── js-syntax-speed.test.js
│   ├── memory-fit.test.js
│   ├── server-settings.test.js
│   ├── engine-correctness.test.js
│   ├── openai-contract.test.js
│   ├── downloader-receipts.test.js
│   ├── memory-load.test.js
│   ├── settings-sse-links.test.js
│   ├── profile-ux.test.js
│   ├── runtime-gates.test.js
│   ├── gated-downloads.test.js
│   ├── manifest-bench.test.js
│   ├── sampler-health.test.js
│   ├── matrix-sharding.test.js
│   ├── merge-shards.test.js
│   ├── test-parallel-shards.test.js
│   ├── cache-truncate.test.js
│   ├── recommend.test.js
│   ├── server.test.js
│   ├── system-info-speed.test.js
│   ├── server-startup-speed.test.js
│   ├── task-subset-hash-speed.test.js
│   ├── engine-start-speed.test.js
│   ├── preset-cache-speed.test.js
│   ├── profile-list-cache.test.js
│   ├── loop-lag-speed.test.js
│   ├── fingerprint-runtime-cache.test.js
│   ├── missing-profile-read.test.js
│   ├── receipt-stat-first.test.js
│   ├── run-liveness-cache.test.js
│   ├── judge-cache-size.test.js
│   ├── main-lazy-import.test.js
│   ├── report-summary-cache.test.js
│   ├── machine-catalog-cache.test.js
│   ├── static-summaries-cache.test.js
│   ├── stale-override-prune.test.js
│   ├── recommendation-profile-probe.test.js
│   ├── buffered-answer-summary.test.js
│   ├── cached-public-list.test.js
│   ├── overview-profile-probe.test.js
│   ├── buffered-item-outcomes.test.js
│   ├── judge-key-memo.test.js
│   ├── single-pass-chain-summary.test.js
│   ├── receipt-clock-seam.test.js
│   ├── judge-hit-reuse.test.js
│   └── sandbox-env-memo.test.js
├── rust/ <- optional native GGUF header guard (no crates, built by npm run build:native)
│   └── gguf-guard/
│       ├── Cargo.toml
│       ├── Cargo.lock
│       ├── node.def
│       └── src/
│           ├── lib.rs
│           └── main.rs
├── assets/
│   ├── screenshots/
│   ├── logo.svg
│   ├── social-preview.svg
│   ├── social-preview.png
│   ├── screenshot-control.png
│   ├── screenshot-models.png
│   ├── demo-video-3min-SCRIPT.md
│   ├── demo-video-3min-PLAYER.html
│   └── modelduck-demo-3min.srt
├── .aikit/ <- project memory and ledger
├── .kiro/ <- Kiro agent-mode workspace
├── .gitignore
├── .gitattributes
├── start.bat
├── package.json
├── package-lock.json <- pinned dependencies
├── README.md
├── LICENSE
├── JUDGES.md <- judges' demo walkthrough
├── LICENSES/
├── docs/ <- threat model and design notes
│   └── THREAT-MODEL.md
├── MODELDUCK_IDEA_ANALYSIS.md <- idea audit
├── MODELDUCK_IMPLEMENT_LIST.md <- implementation waves
└── REUSE.toml
```

## Manual smoke test

After a model is installed:

```bash
npm start -- --no-open --port 4141
curl http://127.0.0.1:4141/health
```

Open `http://127.0.0.1:4141`, load the model in **Models**, open **Bench & Tune**
and **Settings**/**Server**, and confirm `curl /v1/models` lists it. Any
OpenAI-compatible client can use the same `/v1` URL for a conversation.

## Design notes

- **One model at a time.** A single llama.cpp context keeps RAM predictable. The
  engine disposes the old model before loading a new one and keeps the active
  session's KV cache; each OpenAI request rebuilds its history.
- **State is boring on purpose.** JSON files are written through a synced temp
  file and an atomic replace; a damaged file is moved to `*.corrupt-<timestamp>`
  instead of being overwritten. A lock file with a heartbeat stops two processes
  from sharing one home folder.
- **Failures are actionable.** API errors carry `message`, `why`, and `fix`, and
  the control panel shows all three. The process exits 0 on normal shutdown and 1 on a
  startup failure.
- **The control panel never executes model output.** Tune and benchmark text is
  escaped before it reaches the DOM; the CSP forbids inline script.

<!-- aegean:brand-assets:start -->
## 🎨 Brand Assets

> **AI-Generated Brand Artwork.** The banner and logo are **AI-generated brand assets**. They are illustrative and may not literally depict every feature or the full project scope.
<!-- aegean:brand-assets:end -->

## License

MIT; see [LICENSE](LICENSE). Personal and commercial use are both allowed under
its terms.
