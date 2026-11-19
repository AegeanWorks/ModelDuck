# Inference engines

ModelDuck can run a model on several inference engines, and **tunes and serves on the fastest one**.
At the start of the device (CPU/GPU) stage of every tune it times each engine on the model
being tuned (about 256 prompt tokens, 64 generated) and shows prompt and answer tokens per
second with each engine's version, in the Bench panel and in `<home>/profiles/<model>.engines.json`.
The device stage then judges every engine on the tune's own items, by the time it takes to
answer them end to end, and picks the fastest one that is as accurate as the CPU. Every later
stage (quality, speed, sampling, prompt) runs on that engine, the profile names it
(`engine` in its load settings), and loading the model serves through it. Run the speed test
alone with `npm run engines -- --model <file.gguf>`; skip it in a tune with `--no-engines`.

| Engine | How ModelDuck gets it | Timed | Answers the tuner's items |
|---|---|---|---|
| node-llama-cpp: CPU, Vulkan, CUDA, Metal | in the app (a backend that is missing is reported, never faked) | yes | yes, the default |
| llama.cpp `llama-server`: each installed variant (cpu, vulkan, cuda) | `npm run engines:install` (official builds, MIT, pinned and SHA-256 checked) | yes | yes, and the app serves through it |
| llama.cpp `llama-bench` | the same install | yes | no (it times, it does not generate) |
| Ollama | a running server | yes | yes, and the app can serve through it |
| vLLM, SGLang, TGI, mistral.rs, koboldcpp, llamafile, LM Studio, LocalAI | `--openai-engine name=http://host:port/v1[#model]` on a running server | yes | yes, measured only: someone else's process, so a saved profile cannot start it |
| A llama.cpp-family build you keep elsewhere (ik_llama.cpp, BitNet, a custom llama.cpp) | `npm run engines:add -- --name ik-llama --binary <llama-server>` | yes | yes, and the app serves through it (the record names the file; nothing is copied) |
| The same, for one run only | `--llama-server <file>` | yes | yes, in a tune, measured only: a saved profile cannot start a binary passed on one command line |
| An engine of your own | `--engine-plugin <file>` (see below) | as the plugin says | as the plugin says |

`npm run engines:install -- --variants cpu,vulkan,cuda` chooses what to download (CUDA is
about 650 MB and needs an NVIDIA driver). Engines land in `engines/bin` and are never
installed system-wide. Not bundled on purpose: koboldcpp (AGPL-3.0), and the servers that
bring their own GPU stack (vLLM, SGLang, TGI), which need Linux and an NVIDIA GPU. Attach
them when they are already running. A key, if one is needed, is read from `MODELDUCK_ENGINE_KEY`.

An external engine must be at least 10% faster than the best in-process device to be
chosen, since it is a second process to keep running; below that the in-process engine stays
and the reason says by how much it fell short. If the chosen engine cannot start when the
model is loaded (its files were removed, its GPU is gone), the in-process engine serves and
the status bar says so: a saved profile never leaves you without a model. A profile also records the build of the engine it was measured on (for llama-server, the installed release); when you later install a different build, loading the model warns that the profile should be tuned again, and still applies it. An external engine
refuses, with a Why and a Fix, the settings it cannot honour (`responsePrefix`, and
`penalizeNewLine` off on llama-server) instead of quietly changing them; such a candidate
simply fails during a tune. On this machine, with SmolLM2-135M, the same 5 x 100-token
workload through `/v1/chat/completions` served 386 tok/s end to end on llama-server (Vulkan)
against 149 on the in-process engine (Vulkan), and four concurrent clients were all answered in 364 ms.

**Candidates found on GitHub** (searched 2026-11-19) and where each fits. Anything that serves an
OpenAI-style API attaches with `--openai-engine`. Anything built from llama.cpp registers with `engines:add`.

| Project | Fit |
|---|---|
| [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) (MIT) | a llama.cpp fork with extra quantizations and faster CPU paths; `engines:add` |
| [BitNet](https://github.com/microsoft/BitNet) (MIT) | llama.cpp fork for 1-bit models; `engines:add` (only BitNet-format GGUFs run on it) |
| [shimmy](https://github.com/Michael-A-Kuykendall/shimmy) (Apache-2.0) | Rust, WebGPU, GGUF, OpenAI API; `--openai-engine` |
| [Lemonade](https://github.com/lemonade-sdk/lemonade) (Apache-2.0) | AMD and Ryzen AI oriented server, OpenAI API; `--openai-engine` |
| [mlx-lm](https://github.com/ml-explore/mlx-lm) and [mlx-serve](https://github.com/ddalcu/mlx-serve) | Apple Silicon, MLX models rather than GGUF; `--openai-engine` |
| [mistral.rs](https://github.com/EricLBuehler/mistral.rs) (MIT) | Rust, OpenAI API; `--openai-engine` |
| [llama-swap](https://github.com/mostlygeek/llama-swap) (MIT) | a proxy that starts other servers on demand, so it fronts any of the above; `--openai-engine` |
| [LMDeploy](https://github.com/InternLM/lmdeploy), [Xinference](https://github.com/xorbitsai/inference) | NVIDIA-oriented servers; `--openai-engine` |

Not added: libraries with no server of their own (LLamaSharp, nobodywho) and Cortex.cpp
(no commit since 2025-07). None of these projects was run for this list. The attached path itself was run against
a real server (a hand-started llama-server, 284 tok/s next to the same build run by the
app at 289), so it works with a real OpenAI-style API, not only the test fakes.

**Engines that call themselves fast** (second GitHub search, 2026-11-19: 10 phrase queries, 12 topic queries and 8
targeted ones, 800 repositories, filtered to active since May 2026 with a speed claim in the description). The claims
below are the projects' own README claims, on their own hardware; none of these was run here, and the checksum below
shows the download is intact, not that its publisher is trusted. This PC is Windows with an AMD Radeon RX 9060 XT
(Vulkan) and a 16-thread Intel CPU, which rules out most of the list.

| Project | What it claims | Fit for this PC |
|---|---|---|
| [kinetic](https://github.com/Veloresearch/kinetic) (Apache-2.0, Rust, Beta 1, 2026-11-10) | GGUF, a drop-in for `llama-server` (copy the binary to that name), OpenAI API, Windows x64 builds, Vulkan on any GPU. Against llama.cpp b12001 on a Ryzen 5 6600H + RTX 3060 laptop: up to 1.4x on plain generation, 4.5x on repeated file rewrites (its edit mode) | **Tried here 2026-11-20, not faster for ModelDuck:** it starts as `llama-server` and answers like it, but takes 1.8x as long on the code items, 3.5x on comprehension and 8x on recall (details below). Re-test its Beta 2 |
| [magnitude](https://github.com/magnitudedev/magnitude) (Apache-2.0, Rust, 7.9k stars) | tunes its kernels on your hardware per model; "over 2x faster than Ollama" (average of 11 models, measured on Mac and NVIDIA); AMD, Intel and CPU "supported"; Windows x64; OpenAI API | `--openai-engine`, measured only. The comparison is against Ollama, not llama.cpp, and part of the gain is bundled speculative-decoding drafters; it serves its own model list |
| [ghost-infer](https://github.com/affifuddin-hazam/ghost-infer) (Rust, GGUF, OpenAI API) | 2x llama.cpp on models bigger than the GPU, on an RTX 2060 SUPER | No: it runs on NVIDIA through CUDA graphs |
| [xinfer](https://github.com/guoqingbao/xinfer) (MIT, Rust) | "blazing-fast LLM inference in pure Rust", GGUF | No: CUDA and Metal only |
| [Tessera](https://github.com/Quackster/tessera) (Apache-2.0, C++, 3 stars) | AMD ROCm and Vulkan, speculative decoding on 27B models | Not yet: "heavy development, not production", tested on Linux (RADV) with large models |
| [PowerInfer](https://github.com/Tiiny-AI/PowerInfer), [eLLM](https://github.com/lucienhuangfu/eLLM) (Rust, CPU), [krasis](https://github.com/brontoguana/krasis) | sparse-activation serving; CPU-only; CUDA hybrid for big models | No release builds for Windows (PowerInfer, eLLM) or CUDA only (krasis) |

Left out because they cannot run on this PC: Apple Silicon engines (Rapid-MLX, baseRT, kapitsa, MTPLX, vllm-mlx, pmetal),
data-centre and accelerator stacks (xllm, rtp-llm, chitu, FastDeploy, gpustack, LMDeploy), cluster engines
(distributed-llama) and mobile runtimes (LiteRT-LM, react-native-executorch).

**Kinetic, tried on this PC (2026-11-20).** kinetic 0.1.0 (the Windows `cuda` archive, SHA-256 `3fb128a3...ba43e4`, matched its release's
`SHA256SUMS`) was extracted into its own folder, copied to `llama-server.exe` and registered with `engines:add`, then removed again.
It was timed with the baseline regeneration still running, so every number is interleaved A, B, A, B on the same
model (Qwen2.5 Coder 1.5B Q4_K_M, Vulkan, RX 9060 XT) and read as a ratio.

| Check | Result |
|---|---|
| Starts with ModelDuck's own `llama-server` arguments | yes, healthy in 4 s, `/health` and streamed `/v1/chat/completions` with usage as ModelDuck reads them |
| Models it can run on the GPU | the Coder 1.5B file; SmolLM2 135M and Qwen2.5 0.5B Q4_K_M stop with "no Vulkan GEMV kernel for Q5_0" |
| Same answers as `llama-server` (greedy, 8 suite prompts) | 7 of 8 identical; the 8th diverges at character 176 with the same token count |
| Raw speed, the engines workload (256-token prompt, 64 out) | generation 332 against 134 tok/s (2.5x), prompt 211 against 1,769 tok/s (0.12x) |
| End to end, 128 tokens out after a short prompt | 547 against 930 ms: kinetic 1.7x faster |
| End to end, 256-token prompt, 64 out | 655 against 560 ms: kinetic 1.2x slower |
| End to end, 2,000-token prompt, 16 out | 1,080 against 608 ms: kinetic 1.8x slower |
| The tuner's own items (20 per task, greedy, judged by the suite) | code 32.0 against 17.4 s (1.84x as long), comprehension 3.9 against 1.1 s (3.5x), recall 42.1 against 5.2 s (8.0x) |
| Pass counts on those items | code 14 against 13 (one item differs), comprehension 17 against 17, recall 15 against 15; 56 of 60 answers identical text |

So it decodes faster and reads prompts much more slowly, and the suite's items are prompt-heavy (repository code,
long-context recall), which is why a generation-only ranking would have called it the winner. The tuner's device stage
judges engines end to end (ADR-159), so it would not have adopted it. `npm run engines` now says so too (ADR-187).
Its Beta 1 notes list prompt-processing and AMD work as coming; worth timing again with a newer release.

**Adding an engine.** Every engine is one descriptor in `src/engine-catalog.js`: a `kind`,
whether the app can start it itself (`servable`), the adapters that time it, and (if it can
generate) how to resolve it into an engine and which device candidates it offers. Nothing else
in the code names an engine. A descriptor can live in your own file and be added with
`--engine-plugin <file>` (on `npm run tune`, `npm run engines` and `node src/main.js`). Its backend
must pass the conformance check in `tests/engine-contract.js`; `tests/engine-catalog.test.js` adds a
made-up engine end to end (assessment, tuner adoption, serving, fallback) without touching any
other source file.

**Choosing an engine over the API (ADR-170).** `GET /api/engines[?model=<id>]` lists every engine the
catalog offers: `id`, `label`, `servable` (the app can start it here), `version`, and `measured` (the
generation and prompt speed saved beside that model's profile by `npm run tune` or `npm run engines`,
else `null`). `fastest` is the quickest measured engine that can be served. `POST /api/models/<id>/load`
accepts `engine`: it wins over the engine a tuned profile names, and an id that is unknown, not
installed or measure-only is refused with `engine_unknown` (HTTP 400) and the list of ids that can be
chosen. Leave `engine` out for the profile's engine, or the in-process one when the model is untuned.

`GET /api/engines` also carries `notice`: one sentence when the installer has no prebuilt llama.cpp for this
machine (the manifest has no `<platform>-<arch>` entry), else `null`. Models > Installed shows it above the list.
`byTask` ranks the servable, measured engines for each task the model's profile recorded tokens for, by expected seconds
per answer (prompt tokens over measured prompt speed plus output tokens over generation speed), so a long-context task
can prefer an engine that reads prompts faster than the one with the best `fastest`. `npm run engines` adds "within the
measured spread of ..." to its verdict when another engine's measured range reaches the fastest one's.

Each servable engine is also probed (`detect`: a server that does not answer, a GPU build with no such GPU) and
listed with `servable: false` and a `reason` when it would not start; probes are cached for a minute.
