# Settings performance scripts

Two scripts time the settings code (`src/settings.js`, `src/config.js`), and a
rule-based advisor reads their results. They measure plain JavaScript and file
I/O, not models. They are not part of the tuned suite or the gate.

```powershell
npm run perf:settings    # single functions: fenceSettingsPatch, mergeSettingsDeep, normalizeSettings, SettingsStore.load/update
npm run perf:multistep   # workflows: load → update → reload, version checks, batch updates, parallel loads, deep merges
```

Each benchmark runs a few untimed warmup calls, then times every call with
`performance.now()`. `benchmarks/stats-util.mjs` stores the times in **seconds**
and reports mean, median, standard deviation, a 95% confidence interval,
percentiles and throughput (1 / mean time). Measured on an i5-14400F under Windows:

| Benchmark | Mean |
|---|---:|
| `fenceSettingsPatch`, 10 keys | 1.0 µs |
| `mergeSettingsDeep`, 5 levels | 2.4 µs |
| Settings lifecycle (load → update → update → reload) | 11.7 ms |
| Batch updates (5 updates + reload) | 23.1 ms |

The I/O workflows are dominated by the atomic write's `fsync`.

## Advisor

`benchmarks/benchmark-advisor.mjs` exports `BenchmarkAdvisor`. It compares each
result against fixed thresholds (variability above 50%, mean above 100 ms or 1 s,
confidence interval wider than half the mean, outliers by the 1.5 × IQR rule,
throughput under 10 ops/s) and attaches a canned explanation to each flag.
`compareBenchmarks(before, after)` classifies a change by its percentage. No model
is involved.

```js
import { BenchmarkAdvisor } from "./benchmark-advisor.mjs";
import { benchmarkSettingsLifecycle } from "./multi-step-perf.mjs";

const result = await benchmarkSettingsLifecycle(tmpDir);
console.log(new BenchmarkAdvisor().analyzeAll([result]));
```

Importing either script runs nothing; each runs its `main()` only when started
directly. `tests/perf-scripts.test.js` checks the units, throughput, imports and
advisor thresholds.
