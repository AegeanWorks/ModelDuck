# Measured presets

Each `*.modelduck-profile.json` file is a shareable profile recipe exported from
`profileRecipe()`. It carries settings, the fingerprint they were measured under
and the receipt (rate, items, latency, tokens, tokens/s, host RAM and GPU VRAM).
It carries no weights and is never applied automatically: import it from
**Models → Profiles** or `POST /api/profiles/import`, inspect the settings, then
load it.

Memory is reported as host RAM plus GPU VRAM. The tuner records both; the
earlier host-only figure understated a Vulkan load by about 1.3 GB.

## qwen2.5-coder-1.5b-instruct-q4

Measured 2026-11-08 on an Intel i5-14400F with an AMD Radeon RX 9060 XT
(Vulkan, `gpuLayers=max`), suite v17, tuner v9.

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

Reproduce:

```bash
npm run tune -- --model qwen2.5-coder-1.5b-instruct-q4 --tasks code \
  --stages device,quality,speed,sampling,prompt
npm run tune:gate
```

The preset was found by the existing search; it is not hardcoded. The recipe is
the artifact, and the gate baseline (`benchmarks/baseline-profiles.json`) is the
deliberate tuned-profile regression shield.
