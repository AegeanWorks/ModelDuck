/** Statistical utilities for performance benchmarking.
 *
 * Provides proper statistical analysis including:
 * - Mean, median, mode
 * - Standard deviation, variance
 * - Percentiles (p5, p25, p50, p75, p95, p99)
 * - Confidence intervals
 * - Outlier detection and filtering
 * - Warmup handling
 */

/** Calculate arithmetic mean */
export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Calculate median */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Calculate standard deviation */
export function stdDev(values, usePopulation = false) {
  if (values.length <= 1) return 0;
  const m = mean(values);
  const sumSquared = values.reduce((sum, v) => sum + Math.pow(v - m, 2), 0);
  const divisor = usePopulation ? values.length : values.length - 1;
  return Math.sqrt(sumSquared / divisor);
}

/** Calculate variance */
export function variance(values, usePopulation = false) {
  const sd = stdDev(values, usePopulation);
  return sd * sd;
}

/** Calculate percentile */
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const k = (sortedValues.length - 1) * (p / 100);
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) {
    return sortedValues[f];
  }
  return sortedValues[f] * (c - k) + sortedValues[c] * (k - f);
}

/** Calculate multiple percentiles at once */
export function percentiles(values, percentilesToCalculate = [5, 25, 50, 75, 95, 99]) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = {};
  for (const p of percentilesToCalculate) {
    result[`p${p}`] = percentile(sorted, p);
  }
  return result;
}

/** Calculate confidence interval for mean using t-distribution approximation
 * For small sample sizes (n < 30), uses t-distribution
 * For large sample sizes, uses normal distribution (z-score)
 * Ensures lower bound is never negative
 */
export function confidenceInterval(values, confidence = 0.95) {
  if (values.length < 2) return { lower: 0, upper: 0, margin: 0, mean: mean(values) };
  
  const m = mean(values);
  const sd = stdDev(values);
  const n = values.length;
  const sem = sd / Math.sqrt(n); // Standard error of mean
  
  // Use t-distribution for small samples, z for large
  // Degrees of freedom = n - 1
  // For 95% confidence: t(∞) ≈ 1.96, t(10) ≈ 2.228, t(20) ≈ 2.086
  const isSmallSample = n < 30;
  const tValue = isSmallSample 
    ? tCriticalValue(n - 1, confidence) 
    : zScoreForConfidence(confidence);
  
  const margin = tValue * sem;
  
  // Ensure lower bound is not negative (for timing data, negative doesn't make sense)
  const lower = Math.max(0, m - margin);
  const upper = m + margin;
  
  return {
    mean: m,
    lower,
    upper,
    margin,
    standardError: sem,
    degreesOfFreedom: n - 1,
    tValue
  };
}

/** Approximate t-critical value for given degrees of freedom and confidence
 * Uses simplified approximation for common values
 */
function tCriticalValue(df, confidence) {
  // Two-tailed t-values for common confidence levels
  const table = {
    0.90: { 1: 6.314, 2: 2.920, 5: 2.015, 10: 1.812, 20: 1.725, 30: 1.697 },
    0.95: { 1: 12.706, 2: 4.303, 5: 2.571, 10: 2.228, 20: 2.086, 30: 2.042 },
    0.99: { 1: 63.656, 2: 9.925, 5: 4.032, 10: 3.169, 20: 2.845, 30: 2.750 }
  };
  
  const confKey = Object.keys(table).find(c => Math.abs(c - confidence) < 0.01);
  if (!confKey) return zScoreForConfidence(confidence);
  
  const dfKeys = Object.keys(table[confKey]).map(Number).sort((a, b) => a - b);
  
  // Find closest df
  if (df <= dfKeys[0]) return table[confKey][dfKeys[0]];
  if (df >= dfKeys[dfKeys.length - 1]) return table[confKey][dfKeys[dfKeys.length - 1]];
  
  // Linear interpolation for intermediate df
  for (let i = 0; i < dfKeys.length - 1; i++) {
    if (df >= dfKeys[i] && df <= dfKeys[i + 1]) {
      const lowerDf = dfKeys[i];
      const upperDf = dfKeys[i + 1];
      const ratio = (df - lowerDf) / (upperDf - lowerDf);
      return table[confKey][lowerDf] + 
             (table[confKey][upperDf] - table[confKey][lowerDf]) * ratio;
    }
  }
  
  return table[confKey][dfKeys[0]];
}

/** Z-score for common confidence levels */
function zScoreForConfidence(confidence) {
  // Two-tailed z-scores
  if (confidence >= 0.999) return 3.291;  // 99.9%
  if (confidence >= 0.99) return 2.576;    // 99%
  if (confidence >= 0.98) return 2.326;    // 98%
  if (confidence >= 0.95) return 1.960;    // 95%
  if (confidence >= 0.90) return 1.645;    // 90%
  return 1.960;  // Default to 95%
}

/** Detect and filter outliers using the 1.5 * IQR rule */
export function filterOutliers(values) {
  if (values.length < 3) return { filtered: [...values], removed: [] };
  
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  
  const filtered = values.filter(v => v >= lowerBound && v <= upperBound);
  const removed = values.filter(v => v < lowerBound || v > upperBound);
  
  return { filtered, removed, lowerBound, upperBound };
}

/** Detect and filter extreme outliers using the 3 * IQR rule (more aggressive) */
export function filterExtremeOutliers(values) {
  if (values.length < 3) return { filtered: [...values], removed: [] };
  
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  
  const lowerBound = q1 - 3 * iqr;
  const upperBound = q3 + 3 * iqr;
  
  const filtered = values.filter(v => v >= lowerBound && v <= upperBound);
  const removed = values.filter(v => v < lowerBound || v > upperBound);
  
  return { filtered, removed, lowerBound, upperBound };
}

/** Calculate coefficient of variation (CV = stdDev / mean) */
export function coefficientOfVariation(values) {
  const m = mean(values);
  if (m === 0) return 0;
  return stdDev(values) / Math.abs(m);
}

/** Calculate relative standard deviation in percentage */
export function relativeStdDevPercent(values) {
  return coefficientOfVariation(values) * 100;
}

/** Format a number with appropriate units */
export function formatValue(value, unit = "s") {
  if (unit === "s") {
    if (value >= 1) return `${value.toFixed(3)} s`;
    if (value >= 0.001) return `${(value * 1000).toFixed(3)} ms`;
    return `${(value * 1000000).toFixed(3)} μs`;
  }
  if (unit === "ms") {
    if (value >= 1000) return `${(value / 1000).toFixed(3)} s`;
    return `${value.toFixed(3)} ms`;
  }
  if (unit === "ops/sec") {
    if (value >= 1000000) return `${(value / 1000000).toFixed(3)} M ops/s`;
    if (value >= 1000) return `${(value / 1000).toFixed(3)} K ops/s`;
    return `${value.toFixed(3)} ops/s`;
  }
  return `${value.toFixed(3)} ${unit}`;
}

/** Format a value with its unit based on magnitude */
export function formatWithAutoUnit(value) {
  if (value === 0) return "0 s";
  if (value >= 1) return `${value.toFixed(3)} s`;
  if (value >= 0.001) return `${(value * 1000).toFixed(3)} ms`;
  return `${(value * 1000000).toFixed(3)} μs`;
}

/** Calculate throughput (operations per second) */
export function calculateThroughput(totalTime, iterations) {
  return iterations / totalTime;
}

/** Summarize a list of timing values with full statistics */
export function summarizeStats(values, name = "", unit = "s") {
  if (values.length === 0) {
    return {
      name,
      count: 0,
      mean: 0,
      median: 0,
      stdDev: 0,
      min: 0,
      max: 0,
      percentiles: {},
      confidenceInterval: { lower: 0, upper: 0 },
      throughput: 0
    };
  }
  
  const sorted = [...values].sort((a, b) => a - b);
  const totalTime = mean(values);
  
  return {
    name,
    count: values.length,
    mean: mean(values),
    median: median(values),
    stdDev: stdDev(values),
    cv: coefficientOfVariation(values),
    rSD: relativeStdDevPercent(values),
    min: sorted[0],
    max: sorted[values.length - 1],
    range: sorted[values.length - 1] - sorted[0],
    percentiles: percentiles(values, [5, 25, 50, 75, 95, 99]),
    confidenceInterval: confidenceInterval(values, 0.95),
    throughput: calculateThroughput(totalTime, values.length)
  };
}

/** Format a full statistical summary as text */
export function formatStatsSummary(stats, unit = "s") {
  const lines = [];
  
  lines.push(`Name: ${stats.name}`);
  lines.push(`  Count: ${stats.count}`);
  lines.push(`  Mean: ${formatWithAutoUnit(stats.mean)}`);
  lines.push(`  Median: ${formatWithAutoUnit(stats.median)}`);
  lines.push(`  Std Dev: ${formatWithAutoUnit(stats.stdDev)}`);
  lines.push(`  CV: ${stats.cv.toFixed(3)} (${stats.rSD.toFixed(1)}%)`);
  lines.push(`  Min: ${formatWithAutoUnit(stats.min)}`);
  lines.push(`  Max: ${formatWithAutoUnit(stats.max)}`);
  lines.push(`  Range: ${formatWithAutoUnit(stats.range)}`);
  lines.push(`  95% CI: [${formatWithAutoUnit(stats.confidenceInterval.lower)}, ${formatWithAutoUnit(stats.confidenceInterval.upper)}]`);
  
  lines.push(`  Percentiles:`);
  lines.push(`    p5:  ${formatWithAutoUnit(stats.percentiles.p5)}`);
  lines.push(`    p25: ${formatWithAutoUnit(stats.percentiles.p25)}`);
  lines.push(`    p50: ${formatWithAutoUnit(stats.percentiles.p50)} (median)`);
  lines.push(`    p75: ${formatWithAutoUnit(stats.percentiles.p75)}`);
  lines.push(`    p95: ${formatWithAutoUnit(stats.percentiles.p95)}`);
  lines.push(`    p99: ${formatWithAutoUnit(stats.percentiles.p99)}`);
  
  lines.push(`  Throughput: ${formatValue(stats.throughput, "ops/sec")}`);
  
  return lines.join("\n");
}

/** Format a compact statistical summary for table display */
export function formatCompactStats(stats, unit = "s") {
  const format = (v) => formatWithAutoUnit(v);
  return {
    name: stats.name,
    mean: format(stats.mean),
    median: format(stats.median),
    stdDev: format(stats.stdDev),
    p5: format(stats.percentiles.p5),
    p50: format(stats.percentiles.p50),
    p95: format(stats.percentiles.p95),
    p99: format(stats.percentiles.p99),
    ci95: `[${format(stats.confidenceInterval.lower)}, ${format(stats.confidenceInterval.upper)}]`,
    throughput: formatValue(stats.throughput, "ops/sec"),
    cv: `${stats.rSD.toFixed(1)}%`
  };
}
