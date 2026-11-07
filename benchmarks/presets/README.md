# Measured presets

Each `*.modelduck-profile.json` file is a shareable profile recipe exported from
`profileRecipe()`. It carries settings, the fingerprint they were measured under
and the receipt (rate, items, latency, tokens, tokens/s, memory). It carries no
weights and is never applied automatically: import it from **Models → Profiles**
or `POST /api/profiles/import`, inspect the settings, then load it.

## qwen2.5-coder-1.5b-instruct-q4

Measured 2026-11-08 on an Intel i5-14400F with an AMD Radeon RX 9060 XT
(Vulkan, `gpuLayers=max`), suite v17, tuner v9, 48 code items × 3 seeds:

| Config | Code rate | Latency | Output tokens | Memory |
|---|---:|---:|---:|---:|
| App defaults (context 4096) | 55.6% | 794 ms | 111.5 | 141 MB |
| Preset (context 4096) | **59.0%** | 707.5 ms | 52 | 141 MB |
| Same preset, context 16384 | 59.0% | 1,248 ms | 52 | 160.7 MB |

The context comparison is a single controlled run: identical load (Vulkan),
sampling, prompt and items; only `contextSize` differs. It shows the tuner's
largest-that-fits context choice costs 43% latency and 12% memory on the code
task with no quality gain. The preset therefore pins `contextSize=4096`, the
app default.

The rate delta against the defaults is +3.4 points (1.6 items on 48); the paired
p-value is 0.2165, so this is a point estimate, not a significant win. The
throughput and memory numbers are the evidence for "code per second and per GB".

Reproduce:

```bash
npm run tune -- --model qwen2.5-coder-1.5b-instruct-q4 --tasks code \
  --stages device,quality,speed,sampling,prompt
npm run tune:gate
```

The preset was found by the existing search; it is not hardcoded. The recipe is
the artifact, and the gate baseline (`benchmarks/baseline-profiles.json`) is the
default-settings regression shield.
