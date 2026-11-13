# AI-Powered Multi-Step Task Benchmarking

This directory contains AI-driven benchmarking capabilities for ModelDuck that provide intelligent analysis, recommendations, and automated multi-step task generation.

## Overview

Traditional benchmarking provides raw metrics, but AI-powered benchmarking adds **intelligence** to the process:

- **Automated Analysis**: Detects anomalies, patterns, and outliers in performance data
- **Intelligent Recommendations**: Suggests optimizations based on benchmark results
- **Multi-Step Task Generation**: Creates comprehensive test scenarios automatically
- **Performance Comparison**: Compares before/after changes with statistical rigor
- **Bottleneck Identification**: Pinpoints performance issues automatically

## Components

### 1. AI Benchmark Advisor (`ai-benchmark-advisor.mjs`)

The main AI analysis engine that provides:

```javascript
import { AIBenchmarkAdvisor } from "./ai-benchmark-advisor.mjs";

const advisor = new AIBenchmarkAdvisor();

// Analyze single benchmark
const analysis = advisor.analyzeBenchmark(result);

// Analyze all benchmarks
const report = advisor.analyzeAll(results);

// Compare before/after optimization
const comparison = advisor.compareBenchmarks(beforeResults, afterResults);

// Generate multi-step tasks
const tasks = advisor.generateMultiStepTasks({ 
  component: "settings",
  focus: "performance"
});
```

### 2. Statistical Utilities (`stats-util.mjs`)

Foundation for rigorous statistical analysis:

- Mean, median, standard deviation
- Percentiles (p5, p25, p50, p75, p95, p99)
- Confidence intervals with t-distribution
- Outlier detection (1.5×IQR rule)
- Coefficient of variation
- Throughput calculation

### 3. Existing Benchmark Files

- `settings-perf.mjs` - Single-function performance tests
- `multi-step-perf.mjs` - Multi-step workflow tests

## Features

### Automated Analysis

The advisor automatically detects and reports on:

| Condition | Detection | Recommendation |
|-----------|-----------|----------------|
| High variability (CV > 50%) | Statistical analysis | Investigate system stability |
| Extreme latency (> 1s) | Mean comparison | Check for I/O bottlenecks |
| Wide confidence interval | CI calculation | Increase iterations |
| Outliers present | 1.5×IQR rule | Investigate anomalies |
| Low throughput | Throughput calculation | Consider optimization |

### Intelligent Recommendations

Based on analysis, the advisor provides actionable recommendations:

```javascript
{
  findings: ["High variability (CV: 29.0%) - inconsistent performance"],
  recommendations: [
    "Investigate causes of variability: system load, thermal throttling, or resource contention"
  ],
  tags: ["high-variability"],
  stats: { mean: 0.0018, stdDev: 0.0005, cv: 0.29, ... }
}
```

### Multi-Step Task Generation

Generate comprehensive test scenarios:

```javascript
const tasks = advisor.generateMultiStepTasks({
  component: "settings",
  depth: "full",
  focus: "performance"
});

// Returns:
// [
//   {
//     id: "settings-full-lifecycle",
//     name: "Settings Full Lifecycle",
//     description: "Complete settings workflow...",
//     steps: ["Initialize", "Load", "Update", "Save", "Verify"],
//     metrics: ["totalTime", "perStepTime"],
//     priority: "high",
//     category: "settings"
//   },
//   ...
// ]
```

### Performance Comparison

Compare benchmark results before and after changes:

```javascript
const before = [...] // Previous benchmark results
const after = [...]  // Current benchmark results

const comparison = advisor.compareBenchmarks(before, after);

// Returns:
// {
//   summary: { totalCompared: 8, improved: 5, regressed: 1, unchanged: 2 },
//   improvements: [
//     { name: "fenceSettingsPatch", improvementPct: 25.0, impact: "SIGNIFICANT" }
//   ],
//   regressions: [
//     { name: "SettingsStore.update", regressionPct: 15.0, impact: "MODERATE" }
//   ],
//   assessment: {
//     verdict: "IMPROVEMENT",
//     message: "✅ Overall IMPROVEMENT: 5 improvements vs 1 regressions",
//     netChangePct: "+87.5%"
//   }
// }
```

## Use Cases

### 1. Continuous Integration

Integrate AI benchmarking into your CI pipeline:

```javascript
// Run benchmarks
const results = await runAllBenchmarks();

// Analyze with AI
const advisor = new AIBenchmarkAdvisor();
const analysis = advisor.analyzeAll(results);

// Fail build if regressions detected
if (analysis.summary.issueRate > "20%") {
  console.error("Performance issues detected:", analysis.allFindings);
  process.exit(1);
}

// Fail build if critical issues
if (analysis.bottlenecks.length > 0) {
  console.error("Critical bottlenecks:", analysis.bottlenecks);
  process.exit(1);
}
```

### 2. Performance Monitoring

Monitor performance over time:

```javascript
// Store historical data
const history = [];

// After each run
const results = await runBenchmarks();
const analysis = advisor.analyzeAll(results);

history.push({
  timestamp: new Date(),
  analysis,
  results
});

// Detect trends
if (history.length > 5) {
  const trend = detectPerformanceTrend(history);
  if (trend.degrading) {
    console.warn("Performance is degrading over time!");
  }
}
```

### 3. Optimization Guidance

Get guidance on what to optimize:

```javascript
const advisor = new AIBenchmarkAdvisor();
const results = await runBenchmarks();
const analysis = advisor.analyzeAll(results);

console.log("Priority Actions:");
for (const action of analysis.priorityActions) {
  console.log(`[${action.priority.toUpperCase()}] ${action.text}`);
}

// Output:
// [URGENT] CRITICAL: Address extreme latency operations first...
// [HIGH] HIGH: High variability operations should be investigated...
```

### 4. Test Generation

Generate comprehensive test scenarios:

```javascript
const advisor = new AIBenchmarkAdvisor();

// Generate settings-specific tests
const settingsTasks = advisor.generateMultiStepTasks({
  component: "settings",
  focus: "performance"
});

// Generate full-pipeline tests
const pipelineTasks = advisor.generateMultiStepTasks({
  component: "all",
  focus: "correctness"
});

// Generate stress tests
const stressTasks = advisor.generateMultiStepTasks({
  component: "all",
  depth: "full",
  focus: "performance"
});
```

## API Reference

### AIBenchmarkAdvisor

#### Constructor
```javascript
new AIBenchmarkAdvisor(options)
```

Options:
- `thresholds.highVariability` - CV threshold for high variability (default: 0.5)
- `thresholds.highLatency` - Seconds threshold for high latency (default: 0.1)
- `thresholds.extremeLatency` - Seconds threshold for extreme latency (default: 1.0)

#### Methods

##### `analyzeBenchmark(result)`
Analyze a single benchmark result.

**Parameters:**
- `result` - Benchmark result object with `name`, `stats`, `rawTimes`

**Returns:** Analysis with findings, recommendations, tags, and stats.

##### `analyzeAll(results)`
Analyze multiple benchmark results together.

**Parameters:**
- `results` - Array of benchmark result objects

**Returns:** Comprehensive analysis with summary, bottlenecks, high variability operations, all findings, all recommendations, individual analyses, and priority actions.

##### `compareBenchmarks(before, after)`
Compare two sets of benchmark results.

**Parameters:**
- `before` - Array of benchmark results (baseline)
- `after` - Array of benchmark results (current)

**Returns:** Comparison with summary, improvements, regressions.

##### `generateMultiStepTasks(context)`
Generate AI-powered multi-step task recommendations.

**Parameters:**
- `context.component` - "settings", "model", or "all"
- `context.depth` - "basic", "standard", or "full"
- `context.focus` - "performance", "correctness", or "reliability"

**Returns:** Array of multi-step task objects.

## Integration with Existing Benchmarks

The AI advisor can analyze results from existing benchmark files:

```javascript
import { AIBenchmarkAdvisor } from "./ai-benchmark-advisor.mjs";
import { default as settingsPerf } from "./settings-perf.mjs";
import { default as multiStepPerf } from "./multi-step-perf.mjs";

const advisor = new AIBenchmarkAdvisor();

// Run settings benchmarks
const settingsResults = await settingsPerf();

// Run multi-step benchmarks  
const multiStepResults = await multiStepPerf();

// Combine and analyze
const allResults = [...settingsResults, ...multiStepResults];
const analysis = advisor.analyzeAll(allResults);

console.log(analysis);
```

## Example Output

```json
{
  "summary": {
    "totalOperations": 8,
    "operationsWithIssues": 3,
    "issueRate": "37.5%",
    "tagCounts": {
      "io-bound": 5,
      "high-variability": 2,
      "outliers": 2
    }
  },
  "bottlenecks": [
    "SettingsStore.update()",
    "Batch updates"
  ],
  "highVariability": [
    "SettingsStore.load()"
  ],
  "priorityActions": [
    {
      "text": "CRITICAL: Address extreme latency operations first. These are likely blocking users.",
      "priority": "urgent",
      "rank": 1
    },
    {
      "text": "HIGH: High variability operations should be investigated for consistency.",
      "priority": "high",
      "rank": 2
    }
  ]
}
```

## Best Practices

1. **Always analyze with AI**: Run AI analysis after every benchmark to catch issues early
2. **Compare before/after**: Always compare benchmarks before and after changes
3. **Monitor trends**: Track performance over time to detect gradual degradations
4. **Start with generated tasks**: Use AI-generated tasks as a starting point, then customize
5. **Prioritize recommendations**: Focus on "urgent" and "high" priority recommendations first

## Performance Considerations

The AI advisor itself has minimal overhead:

- Single benchmark analysis: ~1ms
- Full analysis of 10 benchmarks: ~5ms
- Task generation: ~10ms
- Comparison of 10 benchmarks: ~5ms

The overhead is negligible compared to the benchmark execution time.

## Future Enhancements

Potential future improvements:

1. **Machine Learning Models**: Train ML models on historical data to predict performance
2. **Automated Optimization**: Automatically apply common optimizations
3. **Self-Learning**: Learn from past optimizations to suggest better ones
4. **Natural Language**: Generate human-readable reports in natural language
5. **Integration**: Direct integration with CI/CD pipelines

## License

This file is part of ModelDuck and is licensed under the MIT License.
