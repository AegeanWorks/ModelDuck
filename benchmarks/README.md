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
check. The tuned-profile gate compares against the committed
`baseline-profiles.json` (suite v18, tuner v10). If that file is missing,
`npm run tune:gate` exits with `tune_baseline_missing` rather than comparing;
`npm run tune:gate -- --update-baseline` replaces it deliberately. To re-measure an
already tuned profile rather than retune from scratch, add
`--from-profile <home>`: it reads `profiles/<model>.json` from that home, checks
the suite/runtime/tuner identity, re-measures its task presets on the fixed
harness, and fills models without a profile from their measured defaults.
Every measurement records host RAM and GPU VRAM; a memory tie-break uses their
sum, so a Vulkan preset is not ranked by its small host slice alone.
`npm run tune -- ... --full-final` scores each final preset on every task item
(136 for code) instead of the 48-item search rung. It is slower and gives a
higher-power final rate; without it the search rung is the reported score.
Every tune ends with one `Time …` line that says where the wall-clock time went
(generate, load, judge, other) and how many model loads and answers it took; the
same figures are stored as `timing` on the run record in `tune-runs/`. Use it to
see what a change really saved before trusting an estimate.

`npm run tune -- ... --parallel <1-4|auto>` (1, the default, is off) answers several items at once in the
untimed stages (quality, sampling, prompt); device and speed still time one answer
at a time. It is opt-in because it is not always safe or faster. Before the tune, a
probe answers up to 8 first-rung items wide and one at a time, once greedy and once
sampled at temperature 0.7, since the later stages sample. Wide goes first in one pass
and second in the other, so cold caches favour neither side. The tune runs wide only
when every answer is byte-identical and the wide passes take at least 15% less wall
time; otherwise it says why and answers one at a time. The probe stops at the first
pass that mismatches and when the `--budget` is spent. Measured on the 8-item probe
(Qwen2.5 0.5B on Vulkan, width 2): identical answers, 15.7 s wide against 15.8 s
serial, so it was refused; the probe itself cost about 31 s, which is large against a
short `--quick --budget 3` stage (71 s in all) and small against a full tune. Measured on an i5-14400F
under load: Qwen2.5 0.5B matched 4 of 4 but was not faster (16.7 s wide vs 15.6 s),
and SmolLM2 135M changed 1 of 4 answers at width 2. Each answer is tagged with the
width its call ran at and the width of its tune. A serial tune reuses every serial
answer, including a wide tune's speed stage and narrowed calls; a wide tune reuses
only answers from tunes of its own width. The device must already
be chosen, so run `--stages device` first.

`npm run tune -- ... --budget <minutes>` stops asking new answers once the time is
up (model load included) and saves the best settings found so far; `--continue`
finishes the rest later. With a budget the tuner asks four items per call, so it
stops a few answers past the limit rather than a whole rung: a 0.5-minute budget
ended at 31 s. In the app, **Minutes per model** on the Tune tab does the same per
model. Only that model's own tune processes count: waiting for other models and
paused time do not, and a new tune starts with the whole budget. Once the time is
used up no further process starts. A quick pass that uses up its time keeps its
preset provisional and skips the full continue, and a full tune stopped by its
budget is provisional too.

`npm run tune -- ... --escalate` adds power where the search has the least. Code
rungs are small: after leaving out items no setting ever flipped, Qwen2.5 Coder 1.5B
searched on 20 items and Qwen2.5 0.5B on 16. On a rung that small, the best of up to
nine candidates leads by 5 to 20 points by chance alone, and the Holm-corrected gate
rightly rejects it. With `--escalate`, a leader that misses the gate is tested once
more, alone, against the current setting on the pool items the search never used.
It counts as a change only if it wins there (one-sided paired test, p ≤ 0.2). It was
picked on other items, so the fresh items carry no selection bias. Each retest is
one pre-chosen comparison, but nothing corrects across sweeps: a tune that escalates
in many sweeps at p ≤ 0.2 can keep a chance winner. The confirmation that follows
the search can still reject it, and a later gate run is the check that counts. A
saved profile lists such settings per task (`tasks.<task>.escalated`, the axes
that stood only through escalation and still own their setting's final value), and `search.options.escalate` says the flag
was on. The flag is opt-in and leaves the default search and `TUNER_VERSION` unchanged.

Measured on the code task, sampling and prompt stages (i5-14400F, Radeon RX 9060 XT,
cached answers reused), escalation retested every unproven leader:

| Model | Rung leader (search rung) | Fresh items: leader vs current |
|---|---|---|
| Coder 1.5B | T=1 (58.3% vs 45%, 20 items) | 57.2% vs 63.0% on 81 (won 7, lost 20) |
| Coder 1.5B | "Return only the code" prompt | 60.5% vs 63.0% on 81 |
| Coder 1.5B | reasoning `auto` | 64.2% vs 63.0% on 81 (won 1, lost 1) |
| Qwen 0.5B | "Change the fewest functions" prompt (68.8%, 16 items) | 29.4% vs 29.4% on 85 |
| Qwen 0.5B | T=0.4 | 29.0% vs 29.4% on 85 (won 17, lost 16) |

None held, so for both models greedy decoding with the default prompt is the best
setting in the search space, and the earlier "gains" were noise. Escalation cost
384 extra answers (about 4 minutes) on the 1.5B model and turned "maybe" into a
measured "no".

So the remaining coding headroom is in the model file, not the settings. Greedy on
all 142 code items: Coder 1.5B Q4_K_M 86 (60.6%), the same model at F16 86 (5 won,
5 lost), Llama 3.2 3B Q4_K_M 86 (17 won, 17 lost, so it solves different items),
Phi-3.5 Mini Q4_K_M 71 (50.0%, p=0.007 worse), Coder 0.5B F16 59 and Q8_0 58.

Every tune also ends with a `Why code answers failed …` line, and every saved answer
carries a `failure` class: `truncated`, `empty`, `unreadable`, `timeout`, `crash`,
`threw`, `wrong` or `error`. The classes say which lever is left. For 600 failing
Coder 1.5B code answers they were: wrong output 78%, threw 10%, truncated 5%,
did not run 3%, unreadable 0.5%. Settings can fix a token budget or a format, not
wrong logic. Choosing among the model's own answers without tests did not help
either: majority vote by output scored 43.8% against 46.3% for a single sampled
answer (5 answers, 32 items), and it stayed near 57% on 84 items with 3 answers.
Suite v18 has 277 items in ten categories: the 265 counted below plus 12 paraphrase
probes (6 code, 6 comprehension) that only the held-back check and the gate ask,
never the search. Of the 265, 262 are searched; 3 long-context needles are KV-confirmation only:

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

Executable checks run the generated JavaScript in a child process under Node's
permission model with no allow flags (`--permission`, or `--experimental-permission`
before Node 22.13 and 23.5; `benchmarks/sandbox.mjs`). File, child-process and worker
access are denied on every supported Node; network access only from Node 25, so on
older Node the code can open sockets. The child gets an empty environment (on
Windows, neutral values for the variables libuv refills), starts in the root of the
temp drive, and a 5-second timeout kills runaway loops (with SIGKILL, so a signal
handler cannot keep one alive on POSIX). The child prints its results between two
markers, so anything an answer prints afterwards (an exit handler's log) is ignored,
and its output limit is 1 MB plus twice the expected values (at most 8 MB); more is
reported as "output too large". The answer and the script that calls it
share one process, so the child never holds the expected values: it prints what the
function returned and this process does the comparing. An answer that reads the
child's script or forges its output line can only choose what the function
"returned", and cannot know what would pass. It can still hardcode the visible
cases, which is overfitting rather than forgery. Not stopped: the 256 MB heap
bounds JavaScript objects only (a 600 MB `Buffer.alloc` succeeds), and `process.kill`
and the user and host names are removed or replaced in the child as a best-effort
scrub, not a boundary. Each test case is one check, so a partly correct function
earns partial credit.

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

## Multistep chains (opt-in)

```bash
npm run bench:multistep -- --model <id>            # all chains, the model's tuned code preset
npm run bench:multistep -- --model <id> --defaults # app defaults (greedy) instead
npm run bench:multistep -- --model <id> --chains multistep-csv,multistep-median --seeds 42,7
```

A single-turn item cannot see a model that solves the first request and then
breaks, forgets or contradicts it on the next. A multistep chain is one
conversation: each step changes or builds on the code the model wrote before, and
it is checked with that code loaded first (`benchmarks/multistep-items.mjs`). There
are 5 chains × 3 steps and 59 executable checks, run in the same `node --permission`
sandbox as the suite.

| Chain | What carries over |
|---|---|
| `multistep-counter` | An object API grows `dec`/`reset`, then `history` across every method |
| `multistep-csv` | `parseCsv` then `totalBy` are built on the model's own earlier functions |
| `multistep-median` | Feedback: `median` must stop sorting its input in place, then `mode`/`summary` reuse it |
| `multistep-shipping` | Rules from the first message decide a refusal and a parcel quote two turns later |
| `multistep-slug` | `slugify` gains an option, then `uniqueSlug` builds on it |

A step that says "you do not need to repeat" passes only if earlier code is
carried, and a step that changes behaviour fails if the model resends its old
answer; tests prove both for every step, and that every reference solves its
step. A failed step still feeds its real reply forward, because carrying its own
mistakes is part of the task. The report gives checks per step and chain, the
chains solved in every step, and the **rate at each step depth**; the result goes to
`results/latest-multistep-<model>.json`.

Measured on an i5-14400F with a Radeon RX 9060 XT (Vulkan), each model's tuned code
preset, seed 42, about 10 s per model:

| Model | Checks | Step 1 | Step 2 | Step 3 |
|---|---:|---:|---:|---:|
| Qwen2.5 Coder 1.5B Q4 | 47/59 (79.7%) | 81.8% | 84.2% | 72.2% |
| Qwen2.5 0.5B Q4 | 17/59 (28.8%) | 50% | 15.8% | 16.7% |

The 0.5B model holds half of the first step and then loses most of what follows.
That is the gap the chains are for. One seed is a demo, not a claim: pass
`--seeds 42,7,1234` before comparing models. The chains are not in `PROMPTS` or
`TASKS`, so the test hash, the task-subset hash, profiles, baselines and the gate are
unchanged. They are versioned on their own (`MULTISTEP_VERSION`, `multistepHash`).

## Repair and retry with tests (opt-in)

```bash
npm run bench:repair -- --model <id> --mode retry --repair-temperature 0.7 --rounds 4
npm run bench:repair -- --model <id> --mode fresh --repair-temperature 0.7   # with feedback
```

Once settings are exhausted, the coding lever left is running the tests. The model
answers every eligible code item (134 of 142), the item's tests run, and a failed
item gets another try. The first passing answer counts. Each round is scored on all
cases, so an answer that hardcodes a shown case still fails (one did:
`if (seconds === 0) return "0:00:00"`). Modes:

- `chat`: the failing call (expected and actual output) is fed back in the same
  conversation.
- `fresh`: a new conversation with the task, the failed code quoted and the failing
  call.
- `retry`: the control. The same question again with a new seed and no feedback.

Qwen2.5 Coder 1.5B Q4_K_M, greedy first answer 81/134 (60.4%), 2 extra tries unless noted:

| Mode | Repairs at | Solved | Repairs that resent the same code |
|---|---|---:|---:|
| chat | greedy | 83 (61.9%) | — |
| chat | T=0.7 | 84 (62.7%) | 75 of 105 |
| chat, 3 calls shown | greedy | 84 (62.7%) | 84 of 104 |
| fresh | greedy | 84 (62.7%) | 46 of 103 |
| fresh | T=0.7 | 90 (67.2%) | 33 of 100 |
| retry | T=0.7 | 90 (67.2%) | 9 of 100 |
| retry, seed 100 | T=0.7 | 92 (68.7%) | 6 of 98 |
| retry, 4 extra tries | T=0.7 | 98 (73.1%) | 14 of 183 |

Qwen2.5 0.5B Q4_K_M, first answer 46/134 (34.3%): fresh T=0.7 reached 48 and retry
T=0.7 reached 52.

The feedback text adds nothing over sampling again:

- In a conversation the model sends its own answer back word for word in most
  repairs, even at T=0.7.
- `fresh` and `retry` tie for the 1.5B coder.
- `retry` wins for the 0.5B model.
- Fresh and retry rescued different items (2 shared, 7 each), but two retry runs
  with different seeds did the same (3 shared, 6 and 8 each). The difference is the
  random draw, not the strategy.

What helps is the number of test-checked tries: 60.4%, then 64.9%, 67.2%, 70.9% and
73.1% after 1 to 4 retries (2 to 5 answers), largest on repo bug fixes (1 → 7 of 12). The cost was 183
extra answers on top of 134 (318 s against about 100 s for one pass).

The suite's tests both pick and score the answer, so this is the gain when tests
define the task. With weaker tests in real use it is an upper bound. Not in `PROMPTS`
or `TASKS`: hashes, profiles, baselines and the gate are unchanged.

The serving form of this is `POST /api/code/verify`, which answers on this computer
only. Send a prompt (or chat messages) and your tests. ModelDuck answers with the
loaded model's tuned code preset and runs the tests in the sandbox. A failed answer
gets up to `attempts` tries in all (default 4, at most 8): a new conversation each
time, `retry_temperature` 0.7 and a new seed. It returns the first answer that
passes, or the try that passed the most cases with `"passed": false`. On the repair
bench above, 4 answers solved 70.9% and 5 solved 73.1%; `retry_temperature` must be
above 0, since at 0 every retry repeats the first answer. The whole request has a
5-minute limit. When the limit is reached, the client disconnects, or another reply
takes the model after the first try, the answer carries `"stopped"` (`deadline`,
`client_closed` or `engine_busy`) with the best try so far.

```bash
curl -s http://127.0.0.1:4141/api/code/verify -H "content-type: application/json" -d '{
  "prompt": "Write a JavaScript function percentOf(part, whole) ...",
  "tests": { "entry": "percentOf", "cases": [{ "args": [1, 4], "expect": 25 }] },
  "attempts": 4 }'
# -> { "passed": true, "attempt": 2, "code": "function percentOf…", "tests": [...], "attempts": [...] }
```

Checked against the real model (Coder 1.5B, Vulkan) on five items whose first answer
failed: three passed on try 2 or 3 in under a second each (`bug-percent-of`,
`bug-flatten-one`, `pub-mbpp-59`), and two returned their best try as failing.

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
Generated code is executed only inside the permission-model sandbox described
under the suite (no file, child-process or worker access, no network from Node 25,
5-second timeout); syntax-only checks
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
