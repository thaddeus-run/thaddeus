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
// cannot distinguish a trend from a coincidence, so the fit is null.
export function fitExponent(
  points: { n: number; t: number }[]
): { exponent: number; r2: number } | null {
  if (points.length < 3) return null;
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
