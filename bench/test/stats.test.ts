import { expect, test } from 'bun:test';

import { cv, fitExponent, median, percentile, summarize } from '../src/stats';

const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

test('median handles odd, even and unsorted input without mutating it', () => {
  const xs = [3, 1, 2];
  expect(median(xs)).toBe(2);
  expect(xs).toEqual([3, 1, 2]);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test('percentile interpolates linearly between closest ranks', () => {
  expect(percentile(oneToHundred, 95)).toBeCloseTo(95.05, 6);
  expect(percentile(oneToHundred, 50)).toBeCloseTo(50.5, 6);
  expect(percentile(oneToHundred, 0)).toBe(1);
  expect(percentile(oneToHundred, 100)).toBe(100);
  expect(percentile([7], 95)).toBe(7);
});

test('cv is the sample stdev over the mean, and 0 when there is no spread', () => {
  expect(cv([10, 10, 10])).toBe(0);
  expect(cv([5])).toBe(0);
  // mean 5, sample variance 8 / 3
  expect(cv([2, 4, 6, 8])).toBeCloseTo(Math.sqrt(20 / 3) / 5, 9);
});

test('fitExponent recovers a quadratic law', () => {
  const fit = fitExponent([1e3, 2e3, 4e3, 8e3].map((n) => ({ n, t: n * n })))!;
  expect(fit.exponent).toBeCloseTo(2, 9);
  expect(fit.r2).toBeCloseTo(1, 9);
});

test('fitExponent needs at least three points', () => {
  expect(
    fitExponent([
      { n: 1, t: 1 },
      { n: 2, t: 2 },
    ])
  ).toBeNull();
});

test('summarize reports p50, p95 and cv, and nulls for no samples', () => {
  const s = summarize(oneToHundred);
  expect(s.p50Ms).toBeCloseTo(50.5, 6);
  expect(s.p95Ms).toBeCloseTo(95.05, 6);
  expect(s.cv).toBeGreaterThan(0);
  expect(summarize([])).toEqual({ p50Ms: null, p95Ms: null, cv: null });
});
