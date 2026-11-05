# ModelDuck — 3-Minute Hackathon Demo Video — Script & Shot List

Total: 180s. Voiceover ~390 words, ~130 wpm. 1280x720, 30fps.
Video output: `assets/modelduck-demo-3min.mp4`
Player: `assets/demo-video-3min-PLAYER.html`
Subtitles: `assets/modelduck-demo-3min.srt`

## Narration (read verbatim)

**[0:00-0:12] HOOK — 01-overview.png**
"Meet ModelDuck. A local GGUF model server and coding-model tuner that runs entirely on your machine. No cloud account. No telemetry. Just serve the model — and tune it for code."

**[0:12-0:26] PROBLEM — 02-models-installed.png**
"Cloud coding assistants send your code away, cost money per token, and change answers when the vendor changes the model. ModelDuck keeps weights, prompts, and settings on your computer. What you measure is what you ship."

**[0:26-0:40] MODELS — 03-models-discover.png**
"Drop a GGUF file in a folder, import by path, or download a curated model from Hugging Face with pinned SHA-256 and resumable downloads. This PC runs half-gig Qwen starters up to 7B Mistral — ModelDuck shows real memory fit before you load."

**[0:40-0:58] LIVE API — 15-server.png**
"It serves a drop-in OpenAI-compatible API — models, chat completions, completions, with streaming — on loopback only, with optional keys, LAN mode, and CORS. Point ChatDuck, our static client, or any OpenAI SDK at localhost 4141, and chat. One model at a time, so RAM stays predictable."

**[0:58-1:14] SUITE — 11-bench-suite.png + 11b-bench-suite-long-context.png**
"Here is the unfair advantage: a 262-item coding suite — our own code, multi-file, bug-fix, comprehension and long-context recall questions, plus 20 public HumanEval and MBPP tasks, shown separately so contamination never hides."

**[1:14-1:32] TUNE WORKSPACE — 04-bench-tune-idle.png + 04b-bench-tune-controls.png**
"Bench and Tune finds the best settings for each installed model, on your hardware. Pick tasks, see quick and full time estimates from measured pace, hit Quick pass, pause, reorder a durable queue, or run it in the background while you work."

**[1:32-1:48] HOW IT WORKS — 05-bench-tune-help.png**
"Five stages, in order: device — CPU or GPU, measured; quality — largest context and KV cache that fits; speed — threads, batch, flash; then sampling and prompt per task. A setting changes only on a clear paired gain. Held-back items verify every preset."

**[1:48-2:04] LIVE TUNE — 16-bench-tune-running.png + 17b-bench-live.png**
"Watch it live: the setting being tried, candidate table, provisional preset, and every decision logged. A value that falls far behind stops early. A model that cannot load stops the tune. Stop anywhere — each step is saved and applied."

**[2:04-2:18] PROFILES — 06-bench-models.png + 07-bench-model-details.png**
"The result is a profile per model: device, stage progress, right answers per task. Open one to see the measured load shape, speed presets, and per-task sampling and prompt — exportable as a checked recipe."

**[2:18-2:30] PROOF — 08-bench-runs.png + 09-bench-run-detail.png**
"Every run is kept — request, outcome, answers, pace. Open any run for full stats and decisions. Recommended for this PC ranks installed models by measured answers and speed, not guesses."

**[2:30-2:40] GATE — 12-bench-gate.png + 13-settings.png**
"Quality is gated. Tune-gate fails if a task loses more than one item. Settings — context, threads, GPU layers, temperature, system prompt — fill from presets but never apply themselves until both phases pass."

**[2:40-2:52] LOCAL-FIRST — 14-light-overview.png**
"Vanilla UI, no build, no CDN. Light and dark, mobile-friendly. Loopback-only, Host and Origin checks, GGUF header guard, atomic writes — a damaged file is Blocked, never loaded."

**[2:52-3:00] OUTRO — 23-social-preview.png**
"ModelDuck: serve the model, tune the code, keep it yours. Free for personal use. Try Qwen 0.5B in under a minute — and quack on."

---

## Shot timings (for editor / ffmpeg concat)

| # | Time | Dur | Image | Caption overlay |
|---|------|-----|-------|-----------------|
| 0 | 0:00 | 4s | TITLE CARD | ModelDuck — Serve the model. Tune the code. |
| 1 | 0:04 | 8s | 01-overview.png | The workbench: models, tuned profiles, local API |
| 2 | 0:12 | 14s | 02-models-installed.png | Two local GGUF models. No cloud account. |
| 3 | 0:26 | 14s | 03-models-discover.png | Catalog sized for this PC, SHA-256 pinned |
| 4 | 0:40 | 18s | 15-server.png | OpenAI-compatible API on localhost:4141 |
| 5 | 0:58 | 16s | 11-bench-suite.png | 262-item coding suite: code, comprehension, recall |
| 6 | 1:14 | 18s | 04-bench-tune-idle.png | Tune workspace: scope, estimates, Quick pass |
| 7 | 1:32 | 16s | 05-bench-tune-help.png | 5 stages: Device → Quality → Speed → Sampling → Prompt |
| 8 | 1:48 | 16s | 16-bench-tune-running.png | Live guarded tune with provisional preset |
| 9 | 2:04 | 14s | 06-bench-models.png | Per-model profile table: device, stages, scores |
| 10 | 2:18 | 12s | 08-bench-runs.png | Every run kept: answers, pace, decisions |
| 11 | 2:30 | 10s | 12-bench-gate.png | Tune-gate: quality must not regress |
| 12 | 2:40 | 12s | 14-light-overview.png | Local-first: loopback-only, no telemetry |
| 13 | 2:52 | 8s | 23-social-preview.png | Outro: ModelDuck — keep it yours |

Total 180s. Trim 04b/07/09/11b/17b/mobile shots held as B-roll if editor wants 1:1 coverage — they are in gallery.
B-roll pool: 04b-bench-tune-controls, 07-bench-model-details, 09-bench-run-detail, 11b-bench-suite-long-context, 17-bench-tune-queue, 17b-bench-live, 10-bench-tune-settings, 13-settings, 18..22-mobile-*, 23-social-preview.

## Recording notes (if re-recording live)
- `npm install; npm start` → http://127.0.0.1:4141
- Models → Discover → Download Qwen2.5 0.5B → Install → Load
- `curl http://127.0.0.1:4141/v1/models`
- Bench & Tune → Tune → Quick pass (show live candidates)
- Show 06 profiles, 08 runs, 12 gate
- End on 23-social-preview
