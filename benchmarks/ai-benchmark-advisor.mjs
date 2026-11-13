/** AI-Powered Multi-Step Task Benchmarking Advisor for ModelDuck.
 *
 * This module provides AI-driven analysis and recommendations for benchmarking:
 * - Anomaly detection in performance data
 * - Optimization suggestions based on patterns
 * - Multi-step task generation for comprehensive coverage
 * - Statistical trend analysis
 * - Bottleneck identification
 *
 * Usage:
 *   import { AIBenchmarkAdvisor } from "./ai-benchmark-advisor.mjs";
 *   const advisor = new AIBenchmarkAdvisor();
 *   const report = advisor.analyze(results);
 */

import { mean, stdDev, median, coefficientOfVariation, percentiles, confidenceInterval } from "./stats-util.mjs";

/**
 * AI Benchmark Advisor - Analyzes benchmark results and provides intelligent recommendations
 */
export class AIBenchmarkAdvisor {
  constructor(options = {}) {
    this.thresholds = {
      highVariability: 0.5,      // CV > 50% = high variability
      highLatency: 0.1,         // > 100ms = high latency
      extremeLatency: 1.0,      // > 1s = extreme latency
      regression: 1.5,           // > 50% slower = regression
      improvement: 0.8,         // > 20% faster = improvement
      iobound: 0.05,            // > 50ms = likely I/O bound
    };
    Object.assign(this.thresholds, options.thresholds);
  }

  /**
   * Analyze a single benchmark result
   * @param {Object} result - Benchmark result from settings-perf.mjs or multi-step-perf.mjs
   * @returns {Object} Analysis with findings and recommendations
   */
  analyzeBenchmark(result) {
    const { name, stats, rawTimes } = result;
    const findings = [];
    const recommendations = [];
    const tags = [];

    // Analyze variability
    if (stats.rSD > this.thresholds.highVariability * 100) {
      findings.push(`High variability (CV: ${stats.rSD.toFixed(1)}%) - inconsistent performance`);
      recommendations.push(`Investigate causes of variability: system load, thermal throttling, or resource contention`);
      tags.push("high-variability");
    }

    // Analyze latency
    if (stats.mean > this.thresholds.extremeLatency) {
      findings.push(`Extreme latency (${this.formatTime(stats.mean)}) - likely I/O bound`);
      recommendations.push(`Consider async operations or batching to reduce I/O overhead`);
      tags.push("extreme-latency", "io-bound");
    } else if (stats.mean > this.thresholds.highLatency) {
      findings.push(`High latency (${this.formatTime(stats.mean)})`);
      recommendations.push(`Profile to identify hotspots`);
      tags.push("high-latency");
    }

    // Analyze I/O bound
    if (stats.mean > this.thresholds.iobound) {
      tags.push("io-bound");
    }

    // Check confidence interval
    const ciRange = stats.confidenceInterval.upper - stats.confidenceInterval.lower;
    if (ciRange / stats.mean > 0.5) {
      findings.push(`Wide confidence interval (${(ciRange/stats.mean*100).toFixed(1)}% of mean)`);
      recommendations.push(`Increase iterations for more precise measurement`);
      tags.push("low-precision");
    }

    // Check for outliers
    if (rawTimes && rawTimes.length > 0) {
      const { filtered, removed } = this.detectOutliers(rawTimes);
      if (removed.length > 0) {
        const pct = (removed.length / rawTimes.length * 100).toFixed(1);
        findings.push(`Detected ${removed.length} outliers (${pct}% of samples)`);
        recommendations.push(`Investigate outlier causes: GC pauses, disk flushes, or external interference`);
        tags.push("outliers");
      }
    }

    // Throughput analysis
    if (stats.throughput < 10) {
      findings.push(`Low throughput (${this.formatThroughput(stats.throughput)})`);
      recommendations.push(`Consider parallelization or optimization`);
      tags.push("low-throughput");
    }

    return {
      name,
      findings,
      recommendations,
      tags,
      stats: {
        mean: stats.mean,
        median: stats.median,
        stdDev: stats.stdDev,
        cv: stats.cv,
        rSD: stats.rSD,
        throughput: stats.throughput,
      }
    };
  }

  /**
   * Analyze multiple benchmark results together
   * @param {Array} results - Array of benchmark results
   * @returns {Object} Comprehensive analysis
   */
  analyzeAll(results) {
    const analyses = results.map(r => this.analyzeBenchmark(r));
    
    const allFindings = analyses.flatMap(a => a.findings);
    const allRecommendations = analyses.flatMap(a => a.recommendations);
    const allTags = analyses.flatMap(a => a.tags);
    
    // Count tag frequencies
    const tagCounts = {};
    for (const tag of allTags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
    
    // Identify bottlenecks
    const bottlenecks = analyses
      .filter(a => a.tags.includes("extreme-latency") || a.tags.includes("high-latency"))
      .map(a => a.name);
    
    // Identify high variability operations
    const highVariability = analyses
      .filter(a => a.tags.includes("high-variability"))
      .map(a => a.name);
    
    // Identify I/O bound operations
    const ioBound = analyses
      .filter(a => a.tags.includes("io-bound"))
      .map(a => a.name);
    
    // Summary statistics
    const totalOperations = analyses.length;
    const operationsWithIssues = analyses.filter(a => a.findings.length > 0).length;
    const issueRate = (operationsWithIssues / totalOperations * 100).toFixed(1);
    
    return {
      summary: {
        totalOperations,
        operationsWithIssues,
        issueRate: `${issueRate}%`,
        tagCounts,
      },
      bottlenecks,
      highVariability,
      ioBound,
      allFindings,
      allRecommendations,
      analyses,
      priorityActions: this.prioritizeRecommendations(allRecommendations, analyses),
    };
  }

  /**
   * Compare two sets of benchmark results (before/after optimization)
   * @param {Array} before - Benchmark results before change
   * @param {Array} after - Benchmark results after change
   * @returns {Object} Comparison analysis
   */
  compareBenchmarks(before, after) {
    const comparisons = [];
    const improvements = [];
    const regressions = [];
    
    // Match benchmarks by name
    const afterMap = new Map(after.map(r => [r.name, r]));
    
    for (const beforeResult of before) {
      const afterResult = afterMap.get(beforeResult.name);
      if (!afterResult) continue;
      
      const comparison = this.compareSingle(beforeResult, afterResult);
      comparisons.push(comparison);
      
      if (comparison.improvementPct > 10) {
        improvements.push(comparison);
      } else if (comparison.regressionPct > 10) {
        regressions.push(comparison);
      }
    }
    
    return {
      comparisons,
      improvements,
      regressions,
      summary: {
        totalCompared: comparisons.length,
        improved: improvements.length,
        regressed: regressions.length,
        unchanged: comparisons.length - improvements.length - regressions.length,
      }
    };
  }

  /**
   * Compare a single benchmark before/after
   */
  compareSingle(before, after) {
    const beforeMean = before.stats.mean;
    const afterMean = after.stats.mean;
    const changePct = ((afterMean - beforeMean) / beforeMean) * 100;
    
    return {
      name: before.name,
      before: {
        mean: beforeMean,
        stdDev: before.stats.stdDev,
        cv: before.stats.cv,
      },
      after: {
        mean: afterMean,
        stdDev: after.stats.stdDev,
        cv: after.stats.cv,
      },
      changePct,
      improvementPct: changePct < 0 ? Math.abs(changePct) : 0,
      regressionPct: changePct > 0 ? changePct : 0,
      significant: Math.abs(changePct) > 10,
    };
  }

  /**
   * Generate AI-powered multi-step task recommendations
   * @param {Object} context - Project context
   * @returns {Array} Recommended multi-step tasks
   */
  generateMultiStepTasks(context = {}) {
    const { component = "all", depth = "full", focus = "performance" } = context;
    
    const tasks = [];
    
    // SettingsStore multi-step tasks
    if (component === "settings" || component === "all") {
      tasks.push({
        id: "settings-full-lifecycle",
        name: "Settings Full Lifecycle",
        description: "Complete settings workflow from creation to persistence",
        steps: [
          "Initialize SettingsStore",
          "Load default settings",
          "Update 10 different settings",
          "Save to disk",
          "Load from disk",
          "Verify all settings preserved",
          "Update with new version",
          "Handle version mismatch",
        ],
        metrics: ["totalTime", "perStepTime", "memoryUsage", "diskIO"],
        priority: "high",
        category: "settings",
      });

      tasks.push({
        id: "settings-concurrent",
        name: "Concurrent Settings Management",
        description: "Multiple settings stores operating simultaneously",
        steps: [
          "Create 5 SettingsStore instances",
          "Load all stores in parallel",
          "Update each store with different settings",
          "Save all stores",
          "Reload all stores",
          "Verify consistency",
        ],
        metrics: ["totalTime", "parallelEfficiency", "conflicts"],
        priority: "medium",
        category: "settings",
      });

      tasks.push({
        id: "settings-migration",
        name: "Settings Migration Path",
        description: "Test version migration scenarios",
        steps: [
          "Load v0 settings",
          "Update to v1",
          "Save v1 settings",
          "Attempt to load v2 settings (should fail)",
          "Load v1 settings in older version",
          "Verify backward compatibility",
        ],
        metrics: ["migrationTime", "errorHandling", "dataIntegrity"],
        priority: "high",
        category: "settings",
      });
    }

    // General multi-step tasks
    if (component === "all") {
      tasks.push({
        id: "load-tune-serve",
        name: "Load-Tune-Serve Pipeline",
        description: "End-to-end model loading, tuning, and serving",
        steps: [
          "Download model",
          "Load model into engine",
          "Run tuning on 5 items",
          "Apply tuned settings",
          "Start serving API",
          "Process 10 requests",
          "Measure response times",
        ],
        metrics: ["totalTime", "loadTime", "tuneTime", "responseLatency"],
        priority: "high",
        category: "full-pipeline",
      });

      tasks.push({
        id: "parallel-model-test",
        name: "Parallel Model Testing",
        description: "Test multiple models simultaneously",
        steps: [
          "Load model A",
          "Load model B",
          "Run same prompt on both",
          "Compare responses",
          "Measure concurrent performance",
          "Unload both models",
        ],
        metrics: ["throughput", "memoryUsage", "latencyVariance"],
        priority: "medium",
        category: "model",
      });

      tasks.push({
        id: "stress-test",
        name: "Stress Test with Rapid Changes",
        description: "Rapid configuration changes under load",
        steps: [
          "Start with default settings",
          "Rapidly update 50 settings",
          "Run inference during updates",
          "Verify no race conditions",
          "Check memory stability",
        ],
        metrics: ["stability", "errorRate", "resourceUsage"],
        priority: depth === "full" ? "high" : "low",
        category: "stress",
      });

      tasks.push({
        id: "error-recovery",
        name: "Error Recovery Paths",
        description: "Test error handling and recovery",
        steps: [
          "Load invalid settings file",
          "Handle error gracefully",
          "Fall back to defaults",
          "Attempt recovery",
          "Verify system stability",
        ],
        metrics: ["recoveryTime", "errorClarity", "stability"],
        priority: "high",
        category: "reliability",
      });
    }

    // Focus-specific tasks
    if (focus === "performance") {
      tasks.push({
        id: "hotpath-analysis",
        name: "Hot Path Analysis",
        description: "Identify and measure critical performance paths",
        steps: [
          "Profile SettingsStore.load()",
          "Profile SettingsStore.update()",
          "Identify bottlenecks",
          "Measure function-level timing",
          "Generate optimization report",
        ],
        metrics: ["functionTimes", "callCounts", "bottlenecks"],
        priority: "high",
        category: "profiling",
      });
    }

    if (focus === "correctness") {
      tasks.push({
        id: "fuzz-testing",
        name: "Fuzz Testing Settings",
        description: "Test with random/invalid inputs",
        steps: [
          "Generate random settings objects",
          "Attempt to load each",
          "Verify graceful handling",
          "Check for crashes",
          "Validate error messages",
        ],
        metrics: ["crashRate", "errorQuality", "recoverySuccess"],
        priority: "high",
        category: "correctness",
      });
    }

    return tasks;
  }

  /**
   * Generate benchmark comparison report
   */
  generateComparisonReport(beforeResults, afterResults) {
    const comparison = this.compareBenchmarks(beforeResults, afterResults);
    
    const report = {
      metadata: {
        generated: new Date().toISOString(),
        beforeCount: beforeResults.length,
        afterCount: afterResults.length,
      },
      summary: comparison.summary,
      improvements: comparison.improvements.map(c => ({
        ...c,
        impact: this.classifyImpact(c.improvementPct),
        message: `✅ ${c.name}: ${c.improvementPct.toFixed(1)}% faster`,
      })),
      regressions: comparison.regressions.map(c => ({
        ...c,
        impact: this.classifyImpact(c.regressionPct),
        message: `⚠️  ${c.name}: ${c.regressionPct.toFixed(1)}% slower`,
      })),
      unchanged: comparison.comparisons
        .filter(c => !c.improvements && !c.regressions)
        .map(c => ({
          name: c.name,
          message: `➖ ${c.name}: No significant change`,
        })),
    };
    
    // Add overall assessment
    report.assessment = this.generateAssessment(report);
    
    return report;
  }

  /**
   * Generate human-readable assessment
   */
  generateAssessment(report) {
    const { improved, regressed, unchanged } = report.summary;
    const total = improved + regressed + unchanged;
    
    let verdict = "NEUTRAL";
    let message = "";
    
    if (regressed > improved) {
      verdict = "REGRESSION";
      message = `❌ Overall REGRESSION: ${regressed} regressions vs ${improved} improvements`;
    } else if (improved > regressed) {
      verdict = "IMPROVEMENT";
      message = `✅ Overall IMPROVEMENT: ${improved} improvements vs ${regressed} regressions`;
    } else if (improved === 0 && regressed === 0) {
      verdict = "STABLE";
      message = `➖ STABLE: No significant performance changes`;
    }
    
    // Calculate net improvement
    const netChange = report.improvements.reduce((sum, i) => sum + i.improvementPct, 0) -
                      report.regressions.reduce((sum, r) => sum + r.regressionPct, 0);
    
    return {
      verdict,
      message,
      netChangePct: netChange.toFixed(1),
      netChange: netChange > 0 ? "positive" : netChange < 0 ? "negative" : "neutral",
      recommendations: this.generateComparisonRecommendations(report),
    };
  }

  /**
   * Generate recommendations based on comparison
   */
  generateComparisonRecommendations(report) {
    const recommendations = [];
    
    if (report.regressions.length > 0) {
      recommendations.push(
        `INVESTIGATE: ${report.regressions.length} performance regressions detected. ` +
        `Review changes that may have caused: ${report.regressions.map(r => r.name).join(", ")}`
      );
    }
    
    if (report.improvements.length > 0) {
      recommendations.push(
        `CELEBRATE: ${report.improvements.length} performance improvements achieved. ` +
        `Consider documenting optimization techniques used.`
      );
    }
    
    if (report.summary.improved > report.summary.regressed * 2) {
      recommendations.push(
        `EXCELLENT: Net performance gain of ${report.assessment.netChangePct}%. ` +
        `These optimizations should be shared with the team.`
      );
    }
    
    if (report.summary.regressed > 0 && report.summary.improved === 0) {
      recommendations.push(
        `URGENT: All changes caused regressions. ` +
        `Rollback may be necessary if performance is critical.`
      );
    }
    
    return recommendations;
  }

  /**
   * Prioritize recommendations by impact and urgency
   */
  prioritizeRecommendations(recommendations, analyses) {
    const priorityMap = {
      "urgent": 4,
      "high": 3,
      "medium": 2,
      "low": 1,
    };
    
    // Categorize recommendations
    const categorized = {
      urgent: [],
      high: [],
      medium: [],
      low: [],
    };
    
    // Check for critical issues
    const hasExtremeLatency = analyses.some(a => a.tags.includes("extreme-latency"));
    const hasRegressions = analyses.some(a => 
      a.findings.some(f => f.includes("regression"))
    );
    const hasHighVariability = analyses.some(a => a.tags.includes("high-variability"));
    
    if (hasExtremeLatency) {
      categorized.urgent.push(
        "CRITICAL: Address extreme latency operations first. These are likely blocking users."
      );
    }
    
    if (hasRegressions) {
      categorized.urgent.push(
        "URGENT: Performance regressions detected. Investigate and fix before release."
      );
    }
    
    if (hasHighVariability) {
      categorized.high.push(
        "HIGH: High variability operations should be investigated for consistency."
      );
    }
    
    // Sort by priority
    return [
      ...categorized.urgent.map(r => ({ text: r, priority: "urgent", rank: 1 })),
      ...categorized.high.map(r => ({ text: r, priority: "high", rank: 2 })),
      ...categorized.medium.map(r => ({ text: r, priority: "medium", rank: 3 })),
      ...categorized.low.map(r => ({ text: r, priority: "low", rank: 4 })),
    ];
  }

  /**
   * Detect outliers using 1.5 * IQR rule
   */
  detectOutliers(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = this.percentile(sorted, 25);
    const q3 = this.percentile(sorted, 75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    
    const filtered = values.filter(v => v >= lowerBound && v <= upperBound);
    const removed = values.filter(v => v < lowerBound || v > upperBound);
    
    return { filtered, removed, lowerBound, upperBound };
  }

  /**
   * Calculate percentile
   */
  percentile(sortedValues, p) {
    if (sortedValues.length === 0) return 0;
    const k = (sortedValues.length - 1) * (p / 100);
    const f = Math.floor(k);
    const c = Math.ceil(k);
    if (f === c) return sortedValues[f];
    return sortedValues[f] * (c - k) + sortedValues[c] * (k - f);
  }

  /**
   * Classify impact level
   */
  classifyImpact(percentage) {
    if (percentage > 50) return "CRITICAL";
    if (percentage > 25) return "SIGNIFICANT";
    if (percentage > 10) return "MODERATE";
    if (percentage > 5) return "MINOR";
    return "NEGLIGIBLE";
  }

  /**
   * Format time with appropriate unit
   */
  formatTime(seconds) {
    if (seconds >= 1) return `${seconds.toFixed(2)}s`;
    if (seconds >= 0.001) return `${(seconds * 1000).toFixed(2)}ms`;
    return `${(seconds * 1000000).toFixed(2)}μs`;
  }

  /**
   * Format throughput
   */
  formatThroughput(opsPerSec) {
    if (opsPerSec >= 1000000) return `${(opsPerSec / 1000000).toFixed(2)}M ops/s`;
    if (opsPerSec >= 1000) return `${(opsPerSec / 1000).toFixed(2)}K ops/s`;
    return `${opsPerSec.toFixed(2)} ops/s`;
  }
}

/**
 * Helper to analyze benchmark results from our existing tests
 */
export async function analyzeBenchmarkResults() {
  const advisor = new AIBenchmarkAdvisor();
  
  // Import and run benchmarks
  const { benchmarkSettingsLifecycle, benchmarkNormalizationPipeline, 
          benchmarkVersionValidation, benchmarkBatchUpdates, 
          benchmarkParallelLoads, benchmarkDeepMerge } = 
    await import("./multi-step-perf.mjs");
  
  // Note: These functions need tmpDir, so we'll just demonstrate the analysis
  // In practice, you would run the benchmarks and pass results to advisor
  
  return {
    advisor,
    exampleUsage: `
      // Example usage:
      const advisor = new AIBenchmarkAdvisor();
      
      // After running benchmarks:
      const results = [
        { name: "SettingsStore.load()", stats: { mean: 0.527, stdDev: 0.1, cv: 0.19, rSD: 19.0, throughput: 19 } },
        { name: "fenceSettingsPatch()", stats: { mean: 0.0018, stdDev: 0.0005, cv: 0.29, rSD: 29.0, throughput: 499643 } },
      ];
      
      const analysis = advisor.analyzeAll(results);
      console.log(analysis);
    `
  };
}

// Export the class
/**
 * AI Benchmark Advisor for ModelDuck
 * 
 * Features:
 * - Automated analysis of benchmark results
 * - Anomaly detection
 * - Performance comparison (before/after)
 * - Multi-step task generation
 * - Prioritized recommendations
 * 
 * @example
 * const { AIBenchmarkAdvisor } = await import("./ai-benchmark-advisor.mjs");
 * const advisor = new AIBenchmarkAdvisor();
 * const analysis = advisor.analyzeAll(results);
 */
export { AIBenchmarkAdvisor };
