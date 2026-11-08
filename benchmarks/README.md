# ModelDuck benchmark

ModelDuck has two benchmark phases. They answer two different questions, and the
second is optional:

1. **Model reload phase** (required) — which model file and loading configuration
   should we use? It varies model family, quantization, KV cache type, context
   length, batch size, CPU threads, thread pool, sequences, flash attention, mmap,
   GPU layers and context checkpoints.
2. **Model usage phase** (optional) — once a model configuration is fixed, which
   sampling and prompting setup gives the best answers? It varies temperature,
   top-k, top-p, min-p, repeat penalty, repeated user prompts, reasoning
   directives and system prompts. Run it when those settings change.

```bash
npm run bench -- --download   # required model phase; first run fetches models
npm run bench:all             # optional model-usage phase after it
npm run bench:full            # optional Llama 3B / Phi 3.8B additions
npm run bench -- --model <id> # settings sweep for one model; never touches a baseline
npm run bench:update          # deliberately replace both baselines
npm run bench:update:model    # deliberately replace only the model baseline
npm run bench:update:full     # replace the model baseline with six models
npm run bench:report
npm run bench:link            # after commit: run once per pending phase
```

The required gate runs SmolLM2 135M, Qwen2.5 0.5B and Qwen2.5 Coder 1.5B.
`--full-matrix` adds Qwen2.5 1.5B, Llama 3.2 3B and Phi-3.5 Mini plus their KV
variants; on a CPU that deeper review takes hours, so it is opt-in.
The committed cross-model baselines predate suite v14. Run `npm run bench:update`
once on the target machine before using the cross-model gate as a regression
check. The tuned-profile gate has no committed `baseline-profiles.json` yet, so
`npm run tune:gate` exits with `tune_baseline_missing` rather than comparing; run
`npm run tune:gate -- --update-baseline` once to create it. To re-measure an
already tuned profile rather than retune from scratch, add
`--from-profile <home>`: it reads `profiles/<model>.json` from that home, checks
the suite/runtime/tuner identity, re-measures its task presets on the fixed
harness, and fills models without a profile from their measured defaults.
Every measurement records host RAM and GPU VRAM; a memory tie-break uses their
sum, so a Vulkan preset is not ranked by its small host slice alone.
`npm run tune -- ... --full-final` scores each final preset on every task item
(136 for code) instead of the 48-item search rung. It is slower and gives a
higher-power final rate; without it the search rung is the reported score.
Suite v17 has 265 items in ten categories (262 searched; 3 long-context needles are KV-confirmation only):

| Category | Items | What is measured |
|---|---:|---|
| code | 30 | Write a function against 2–5 test cases: strings, arrays, Roman numerals, intervals, binary search, primes, Pascal's row and more, including the original add/repair checks |
| code-long | 12 | Long functions with a 1024-token budget: an arithmetic evaluator, a CSV parser, greedy word wrap, checkout rules, matrix multiplication, an INI parser, an LRU cache, a query-string parser, a dependency sort, a text table, the next calendar day and a Sudoku check |
| code-repo | 24 | Multi-file codebases: write a function on top of the existing helpers, fix a reported bug, name the function holding a bug, or make six changes that span several functions or files. The codebase is loaded before the answer |
| bugfix | 26 | One realistic bug each: off-by-one, wrong initial value or divisor, inverted condition, missing join, wrong side, ignored quantity and more; the repair must pass the tests |
| bugfix-long | 12 | Multi-line functions with two or three interacting bugs, checked by several cases |
| bugfix-repo | 12 | A user's bug report against a multi-file codebase; the corrected function must pass the tests with the rest loaded |
| public-code | 20 | HumanEval (12) and MBPP (8) tasks translated from Python to JavaScript, checked by their original cases |
| code-comprehension | 64 | Read a small JavaScript function and report what it returns; 32 functions with two inputs each, so clustered inputs of one function no longer pose as independent items; the expected value is computed from the exact code shown |
| context | 14 | Long-context documents: needle lookups, code in a long document, two-step lookups, event order, absence and cross-references |
| recall | 48 | Locker registers, PIN lookups at four depths, reverse lookups, latest status, two balances and colour counts |

Chat, math, factual history and the old prose-comprehension items are not part of
the coding suite. Every public item records its dataset, original id and licence
in `source`, and [NOTICE-benchmarks.md](NOTICE-benchmarks.md) carries the
attribution and the changes made.

The suite has three tasks. Each is tuned on its own rung sizes and holds back a
quarter of its items for the unseen check (ADR-054, ADR-072):

| Task id | Label | Question types | Items | Rungs | Held back |
|---|---|---|---:|---|---:|
| `code` | Code | write, fix, codebase and public code | 136 | 12, 24, 48 | 35 |
| `comprehension` | Code comprehension | read a function and report its result | 64 | 12, 24, 48 | 16 |
| `recall` | Long context | needle, lookup and cross-reference | 65 (62 searched; 3 long needles confirm the KV choice only) | 12, 24, 46 | 16 |

`x-modelduck-task` and the tune verbs accept these three ids; the default is
`code`. The API's `GET /api/benchmarks/suite` returns the same task, type and
hold-out description the Bench page renders.

Executable checks run the generated JavaScript in a child process started with
`node --permission` and no allow flags, so file, child-process, worker and network
access are denied, and a 5-second timeout kills runaway loops. Each test case is one
check, so a partly correct function earns partial credit.

Speed-only variants (threads, batch, pool, sequences, context size, mmap,
checkpoint interval/max, GPU layers) run a 16-item cross-family smoke subset
(`SMOKE_PROMPT_IDS`); it uses short prompts, so its tok/s is not comparable with
the full-suite median. Model, quantization, KV cache, flash attention and presets
run the full suite.

Context checkpoints default to one every 8192 tokens, keeping up to 32 states per
sequence. The v7 matrix adds `ckpt-512`, `ckpt-2048` and `ckpt-max4` on Qwen2.5
0.5B so a 2048-token context actually exercises checkpoint reuse; `no-checkpoints`
remains the off baseline.

Speed is the median generated tokens per second; `runtimeMs` is the variant's
wall-clock time. The model phase runs one factor at a time on representative
models at temperature 0; the model-usage phase runs generation-only variants on the
configuration chosen by the first phase with 42-seed sampling.

## Statistics and the gate

Check percentages stay in the report, but the gate works on **items**: an item
passes when all of its checks pass. Every run reports the item pass rate with a
Wilson 95% interval, overall, per model and per category (`items` in the result).

Against the baseline, items are paired by variant and prompt. For each variant
the runner counts items that regressed and improved and runs an exact McNemar
test; p-values are Holm-corrected across variants (`benchmarks/stats.mjs`). The
run **fails** when the paired item pass rate drops by 5 points or more, or when a
variant's decline is significant at 0.05 after correction. Any smaller decline is
a **warning** that names the regressed items. This replaces the old rule that
failed on any 0.01-point drop in the check score.

## Live run and recommendations

Each phase card also shows host RAM + GPU VRAM, quality per second, and quality
per second per GB, so a throughput claim carries its memory denominator.
`--events` turns stdout into one JSON object per line (`benchmark`,
`prompt-start`, `prompt`, `variant`, `complete`) and moves the human log to
stderr. The app's **Bench** panel starts one child process through
`POST /api/benchmarks/run`, polls `GET /api/benchmarks/status`, and can stop it
with `POST /api/benchmarks/cancel`. Those routes accept loopback requests only and
refuse while a chat reply is generating, so CPU contention cannot silently skew a
measured run. The child is killed when the app shuts down.

Each finished phase also writes `results/latest-<phase>.json`. From the latest
model run, `benchmarks/recommend.mjs` derives four cards:

- **Best quality** — highest item pass rate (speed breaks a tie).
- **Best overall** — 70 % quality + 30 % speed, within 15 points of the best.
- **Best coding** — highest pass rate over the coding categories: write, fix,
  codebase, public code and code comprehension.
- **Fastest within budget** — fastest variant within 5 points of the best.

A separate speed-tuning card compares each smoke variant with its family's base
and only suggests it when no smoke item that the base passed was lost. Cards contain
apply-ready settings (KV cache, context, batch, threads, pool, sequences, flash
attention, mmap, GPU layers, checkpoints). **Fill settings** fills the form; it
never saves, reloads or applies anything. **Use for chat** saves that measured
configuration to `benchmarks/chat-base.json`; a later chat-phase run loads it, so
the model phase can be completed once and the sampling phase run when convenient.
`--select-base <variantId>` does the same from the terminal and `--base-variant
<variantId>` uses one for a single run without saving. Replacing a baseline is
likewise opt-in (`--update-baseline` or the checkbox) and never automatic.

Own questions and public benchmark items are also separated as **origins** in the
result (`items.byOrigin`) and on the Bench panel. The overall rate still includes
both; the split makes it visible when a score is driven by material a model may have
seen during training.

A single-model run (`--model <catalogId>`; in the app, the settings tuner does
this job) builds a 17-variant reload sweep for that model, runs it on the 16-item
smoke set, writes `results/latest-single-model.json`, and recommends its best
settings. It is deliberately not baseline-eligible: `--update-baseline` is refused,
so a quick optimisation can never shrink the shared gate.

## Context curve (long-context variant evaluation)

`npm run bench:curve -- --model <id> --variant <name:key=value,...> [--variant ...]`
reports quality-vs-prompt-length plus a prefill/decode breakdown on the locked
recall task (short lookups, context items, M6 4k/8k/16k needles) — the paper
methodology (accuracy at several lengths) at ModelDuck scale. Variants differ in
load settings only (`contextSize`, `kvCache`, `threads`, `batchSize`,
`flashAttention`, `useMmap`; CPU lane, greedy seed); the comparison is refused
when suite, items, runtime or model file drift. Reports land in
`benchmarks/curves/` and never touch baselines, profiles, tune runs or history.
`--items` restricts to a subset for smoke runs; `--json` prints the report.

## Test identity

`benchmarks/suite.mjs` exports `SUITE_VERSION`. Every result also carries a
SHA-256 `testHash` over the prompts, checks, global and per-variant system
prompts, `promptIds` and effective matrix defaults. A baseline with a different
hash is not comparable: the runner refuses to claim a quality change until the
test changelog is reviewed and the baseline is deliberately updated. A different
node-llama-cpp version or manifest version is refused the same way.
See [CHANGELOG.md](CHANGELOG.md).

Every model result records host RAM and GPU VRAM separately, so a Vulkan
variant is not reported as its small host slice alone. Every model result also
records its GGUF chat-template hash, and every prompt result
stores the generation manifest digest, prompt digest and truncated-history
digest. That makes a result traceable to the exact system prompt, history,
template and sampling settings the model saw, independently from the test hash.
A baseline with a different model file size or chat-template hash is refused
before the run starts; `--update-baseline` is the deliberate override.

## Unsupported by node-llama-cpp 3.22.2

These are recorded in every result's `capabilities.unsupported` field:

- physical batch size (`n_ubatch` is not exposed separately from `batchSize`)
- unified KV cache (`kv_unified` is not exposed)
- RoPE frequency base and scale

ROCm is not a node-llama-cpp backend. AMD GPUs use Vulkan; NVIDIA uses CUDA;
Apple uses Metal. A backend build may require the vendor toolchain.

## History database

Every run writes:

- `benchmarks/history.jsonl` — tracked, append-only run/link events and the
  durable record that can rebuild the database.
- `benchmarks/history.sqlite` — ignored local DB with `runs`, `model_results`,
  `prompt_results` and `commits` tables; `phase`, `test_hash` and every variant
  setting are queryable.

A run made before its commit is pending. `npm run bench:link` attaches it to the
new HEAD; `npm run bench:report` shows quality, speed, runtime and the
`v<suite>:<hash>` identity per commit. Node 22+ is required for `node:sqlite`;
the app itself remains Node 20+. The app's **Bench** button reads the two
baseline files and this JSONL history to show the same per-test percentages,
runtime and linked commit without a terminal.

Results are also written to `benchmarks/results/latest.json` (ignored).
Generated code is executed only inside the `node --permission` sandbox (no file,
child-process, worker or network access, 5-second timeout); syntax-only checks
use a temp file with `node --check`.

## Manifest verification

`npm run verify:manifest -- --models-dir <folder>` loads the default Qwen2.5
0.5B Q4 model (or the first available model) and checks the live generation
manifest. It verifies that a second turn reuses the chat session, a 45-pair
conversation truncates to 40 messages with the matching digest, prompt repetition
uses the duplicated text, a text completion works after a chat session has
occupied the only sequence, and the manifest carries the GGUF chat-template hash
and node-llama-cpp version. It does not write benchmark history or change a
baseline; it is a diagnostic command, not a scoring gate.
