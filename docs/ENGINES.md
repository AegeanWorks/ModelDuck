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
