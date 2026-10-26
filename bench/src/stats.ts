// Summary statistics over timing samples (milliseconds). All functions are
// pure and never mutate their input.

// Returns the p-th percentile (0..100) by linear interpolation between the
// closest ranks, with rank = (p / 100) * (n - 1). Throws on an empty array
// because there is no sensible value; callers use `summarize` for that case.
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) throw new RangeError('percentile of an empty sample');
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loValue = sorted[lo];
  const hiValue = sorted[hi];
  return loValue + (hiValue - loValue) * (rank - lo);
}

// The 50th percentile: the middle sample, or the mean of the two middle ones.
export function median(xs: number[]): number {
  return percentile(xs, 50);
}

// Coefficient of variation: sample standard deviation (n - 1) divided by the
// mean. It says how noisy a case is relative to its size. A single sample or
// identical samples have no spread, so they give 0.
export function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance =
    xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
  if (variance === 0 || mean === 0) return 0;
  return Math.sqrt(variance) / mean;
}

// Fits t = c * n^exponent by least squares on (ln n, ln t) and returns the
// slope as the exponent plus R² as a goodness-of-fit. Fewer than three points
// cannot distinguish a trend from a coincidence, so the fit is null. A point
// with n or t at or below zero has no logarithm, so the fit is null too.
export function fitExponent(
  points: { n: number; t: number }[]
): { exponent: number; r2: number } | null {
  if (points.length < 3) return null;
  if (points.some((p) => !(p.n > 0 && p.t > 0))) return null;
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(p.t));
  const count = points.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / count;
  const meanY = ys.reduce((a, b) => a + b, 0) / count;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  // With constant times the line is perfectly flat, so the fit is exact.
  return { exponent: sxy / sxx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) };
}

// Reduces raw samples to the three numbers stored in a CaseResult. An empty
// sample set (setup failed, or the budget hit before any repeat finished)
// yields nulls rather than throwing.
export function summarize(samplesMs: number[]): {
  p50Ms: number | null;
  p95Ms: number | null;
  cv: number | null;
} {
  if (samplesMs.length === 0) return { p50Ms: null, p95Ms: null, cv: null };
  return {
    p50Ms: median(samplesMs),
    p95Ms: percentile(samplesMs, 95),
    cv: cv(samplesMs),
  };
}

// Coefficients of Acklam's rational approximation to the inverse normal CDF.
const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];
// Below this probability (and above 1 minus it) the tail formula applies.
const ACKLAM_P_LOW = 0.02425;

// Evaluates a polynomial with coefficients from the highest power down.
function horner(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((acc, c) => acc * x + c, 0);
}

// The standard normal quantile: the z with P(Z <= z) = p. Uses Acklam's
// rational approximation (relative error below 1.2e-9), one formula for the
// central region and one for each tail. The noise study needs it to turn a
// family-wise confidence level into a number of standard deviations.
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`normalQuantile needs 0 < p < 1, got ${p}`);
  }
  if (p < ACKLAM_P_LOW || p > 1 - ACKLAM_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
    const z = horner(ACKLAM_C, q) / (horner(ACKLAM_D, q) * q + 1);
    return p < 0.5 ? z : -z;
  }
  const q = p - 0.5;
  const r = q * q;
  return (q * horner(ACKLAM_A, r)) / (horner(ACKLAM_B, r) * r + 1);
}

// Mean and sample standard deviation (n - 1) of the natural logs of `xs`.
export function logMeanStdev(xs: readonly number[]): {
  mu: number;
  sigma: number;
} {
  const logs = xs.map(Math.log);
  const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
  if (logs.length < 2) return { mu, sigma: 0 };
  const variance =
    logs.reduce((a, x) => a + (x - mu) ** 2, 0) / (logs.length - 1);
  return { mu, sigma: Math.sqrt(variance) };
}
