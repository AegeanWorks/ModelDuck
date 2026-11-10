# Devpost Submission Content — ModelDuck / Kiroween 2026

> Paste-ready fields for the Devpost submission form.
> Replace `[YOUR_YOUTUBE_URL]` with the actual video URL before submitting.

---

## Project name

**ModelDuck**

---

## Tagline (≤ 150 chars)

A local GGUF model server and coding-model tuner. No cloud. No telemetry. Runs on CPU or Vulkan GPU. Built with Kiro.

---

## Description / "What it does"

ModelDuck is a local AI inference server that lets you download, load and tune
small GGUF language models entirely on your own computer. It serves an
OpenAI-compatible API so any tool that speaks `/v1/chat/completions` works
against your local model out of the box.

The core features:

- **Model library** — scan a folder, import by path, or download a curated
  model from Hugging Face with SHA-256 receipt verification and resumable
  downloads.
- **OpenAI-compatible API** — `/v1/models`, `/v1/chat/completions`,
  `/v1/completions` with SSE streaming; drop-in replacement for cloud APIs.
- **Bench & Tune** — a staged, resumable settings tuner that finds each
  model's best load settings (device, context, KV cache, threads, batch,
  flash attention) and then sampling settings (temperature, top-p, top-k,
  repeat penalty) using a seeded benchmark suite. Each step is compared with
  Holm-corrected statistics; laggards stop early; presets are tested on
  unseen items.
- **GPU support** — CUDA, Vulkan, Metal or CPU; the backend is selectable;
  CPU is the default so a missing driver never blocks inference.
- **Security** — loopback-only by default; Host/Origin checks prevent
  DNS-rebind attacks; LAN mode requires API key authentication.

ModelDuck was built from scratch in this hackathon period using Kiro's Vibe
and Spec sessions to accelerate the development of its benchmark pipeline,
state-machine architecture and security hardening.

---

## How we built it

The core stack is Node.js 20 + node-llama-cpp 3.22.2. No UI framework — the
control panel is vanilla JS + CSS served from the same HTTP process that runs
inference. No build step; no CDN.

**Where Kiro made the difference:**

Kiro's Vibe and Spec sessions were used heavily for the benchmark and tuner
subsystems — the most statistically complex part of the project. The staged
tuner (`benchmarks/tune.mjs`) alone spans 15 source files and coordinates
device probing, Holm-corrected pairwise comparisons, resume/checkpoint logic,
CPU/GPU lane scheduling and profile serialisation. Kiro helped design the
state transitions, write the statistical tests, and work through edge cases in
the manifest-fingerprinting system (ADR-008).

Kiro was also used to harden the security surface:
- Cross-site and DNS-rebind protections (ADR-018)
- GGUF header pre-validation guard (ADR-019)
- Generation manifest fingerprinting (ADR-008)

The `.kiro/` workspace (steering documents and spec) formalised the patterns
so each session started from a shared mental model.

---

## Challenges

- **Statistical correctness in the tuner.** A simple "is this setting faster?"
  comparison is noisy. Getting Holm-corrected p-values, stopping rules and
  reproducibility right required careful iteration with Kiro.
- **Manifest fingerprinting.** Every generation is fingerprinted over the
  model identity, chat-template hash, runtime version, bounded history digest
  and sampling settings — so a benchmark score change is always attributable
  to a specific parameter. Designing this without breaking existing baselines
  required a phased approach.
- **GGUF header safety.** A malformed GGUF can claim billions of tensors and
  exhaust Node's heap before any parser runs. The bounded guard runs at O(1)
  memory before handing off to node-llama-cpp.

---

## Accomplishments

- A fully local, OpenAI-compatible inference server with no mandatory compile step.
- A principled two-phase benchmark gate (model reload settings, then sampling settings) backed by statistical tests and versioned baselines.
- A resumable, multi-model parallel tuner that works on consumer CPUs.
- 80+ hermetic tests; zero external test dependencies.

---

## What we learned

Small GGUF models are surprisingly capable for coding tasks when the sampling
settings match the task. Qwen2.5 0.5B at tuned settings beats the same model
at defaults on code-completion tasks by a consistent margin. The tuner makes
that delta reproducible.

---

## What's next

- MCP adapter (the server-settings toggle is already there; no tool is exposed yet).
- Context-window auto-fit instead of a fixed 16K floor.
- Streaming download progress in the API.

---

## Built with

node-llama-cpp, Node.js, vanilla JavaScript, CSS, SQLite (node:sqlite, benchmark history only), node:test

---

## Links

- **GitHub repository**: https://github.com/AegeanWorks/ModelDuck
- **Demo video**: https://www.youtube.com/watch?v=3MX8_ULrQ_s
- **Devpost submission**: https://devpost.com/software/necro-software-resurrection-engine
- **Test build**: `ModelDuck-Windows-x64.zip` — SHA-256: `5766974A458D949DD8324D137AB7C16474C21F14B297307CA90A49BEC39CB254`
  See `docs/kiroween/build-manifest.md` for full contents listing and verification steps.

---

## Category

Frankenstein

---

## Country

Turkey

---

## Team type

Individual
