# Measured presets

Each `*.modelduck-profile.json` file is a shareable profile recipe exported from
`profileRecipe()`. It carries settings, the fingerprint they were measured under
and the receipt (rate, items, latency, tokens, tokens/s, host RAM and GPU VRAM).
It carries no weights and is never applied automatically. **Bench & Tune →
Shipped presets** lists each one with how it fits this computer, and **Apply**
(`POST /api/presets/apply`) applies it when you click it. The model file must
match by name and size. On the computer it was measured on, the whole recipe
applies. Anywhere else only the sampling and prompt presets apply: the load
settings (device, GPU layers, threads) stay at the defaults until the Device and
Speed stages measure them there. A profile tuned on this computer is never
replaced unless you confirm it. You can also import a file from **Import
profile** or `POST /api/profiles/import`.

Memory is reported as host RAM plus GPU VRAM. The tuner records both; the
earlier host-only figure understated a Vulkan load by about 1.3 GB.

## qwen2.5-coder-1.5b-instruct-q4

Measured 2026-11-08 on an Intel i5-14400F with an AMD Radeon RX 9060 XT
(Vulkan, `gpuLayers=max`), suite v17, tuner v9. The current suite is v18 and the
tuner v10, so these recipes predate both: a profile imported from one loads with a
"suite changed" and "tuner changed" warning until it is re-measured, and the
figures below are history, not a current claim.

Full code task, 136 items × 3 seeds, same load and context (4096):

| Config | Code rate | Latency | Output tokens | Host RAM | VRAM |
|---|---:|---:|---:|---:|---:|
| App defaults | 55.9% | 1,760 ms | 108.5 | 148.1 MB | 1.425 GB |
| Preset | **58.8%** | **1,090 ms** | **51** | **148.1 MB** | **1.425 GB** |

The full-task paired comparison is b=4, c=13, exact McNemar p=0.049: the preset
gains 3.9 items while answers are 53% shorter. Quality per second rises 70% at
the same memory, so the per-GB figure rises with it.

On the 48-item tuning rung the same comparison is 55.6% → 59.0% (+1.6 items,
p=0.2165) at 52 vs 111.5 output tokens. The context check used that rung:

| Context | Code rate | Latency | Host RAM | VRAM | Total |
|---|---:|---:|---:|---:|---:|
| 4096 | **59.0%** | 596 ms | 148.1 MB | 1.425 GB | 1.573 GB |
| 8192 | 59.0% | 504.5 ms | 152.3 MB | 1.547 GB | 1.699 GB |
| 16384 | 59.0% | 469 ms | 160.7 MB | 1.790 GB | 1.951 GB |

The quality is identical. The memory difference is the stable signal: 4,096
uses 378 MB (19.4%) less total memory than 16,384, so quality per GB is 24%
higher. The latency order flipped between runs, so it is not claimed as a
context win. The preset therefore pins `contextSize=4096`, the app default.

### Context is a workload choice, not a quality knob

The suite's largest code prompt is 687 tokens plus a 1,024-token answer budget,
so 4,096 holds every one of the 136 code items, including the largest
`bugfix-repo` item. A large real repository can exceed that; the benchmark does
not measure one. Context grows the KV cache, not the model or a database:
about **30 MB of VRAM per 1,000 tokens** on this 1.5B model at f16. Moving from
4,096 to 8,192 costs about 126 MB; 16,384 costs about 378 MB. For repo-scale
coding, raise the context and accept that memory; for the measured code suite,
4,096 keeps the quality and the smaller denominator.

Reproduce:

```bash
npm run tune -- --model qwen2.5-coder-1.5b-instruct-q4 --tasks code \
  --stages device,quality,speed,sampling,prompt
npm run tune:gate
```

The preset was found by the existing search; it is not hardcoded. The recipe is
the artifact, and the gate baseline (`benchmarks/baseline-profiles.json`) is the
deliberate tuned-profile regression shield.
