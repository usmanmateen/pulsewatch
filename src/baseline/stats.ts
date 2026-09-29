import { addDays } from '../domain/time';
import type { LocalDate } from '../domain/types';

/**
 * Plain descriptive statistics. Inputs are small (≤ 90 daily values), so
 * clarity wins over incremental algorithms.
 */

/** Scales a median absolute deviation to estimate σ for normally distributed data. */
export const MAD_TO_SIGMA = 1.4826;

function requireValues(values: readonly number[]): void {
  if (values.length === 0) throw new RangeError('At least one value is required');
}

export function mean(values: readonly number[]): number {
  requireValues(values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  requireValues(values);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Sample standard deviation (n − 1); 0 for a single value. */
export function standardDeviation(values: readonly number[]): number {
  requireValues(values);
  if (values.length === 1) return 0;
  const average = mean(values);
  const squares = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
}

/** Median absolute deviation around the median. */
export function medianAbsoluteDeviation(values: readonly number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

/** Relative difference as a percentage, or null when the reference is zero. */
export function percentChange(value: number, reference: number): number | null {
  if (reference === 0) return null;
  return ((value - reference) / Math.abs(reference)) * 100;
}

export interface DailyPoint {
  day: LocalDate;
  value: number;
}

export interface RollingPoint {
  day: LocalDate;
  /** Null when fewer than `minimumSamples` values fall in the window. */
  value: number | null;
  samples: number;
}

/**
 * Applies `reduce` over a trailing calendar window of `windowDays` ending on
 * (and including) each point's day. Missing days shrink the sample rather
 * than being filled in.
 */
export function rolling(
  series: readonly DailyPoint[],
  windowDays: number,
  reduce: (values: readonly number[]) => number,
  minimumSamples = 1,
): RollingPoint[] {
  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day));
  return sorted.map((point) => {
    const windowStart = addDays(point.day, 1 - windowDays);
    const values = sorted.filter((p) => p.day >= windowStart && p.day <= point.day).map((p) => p.value);
    return {
      day: point.day,
      value: values.length >= minimumSamples ? reduce(values) : null,
      samples: values.length,
    };
  });
}

export const rollingMean = (series: readonly DailyPoint[], windowDays: number, minimumSamples = 1) =>
  rolling(series, windowDays, mean, minimumSamples);

export const rollingMedian = (series: readonly DailyPoint[], windowDays: number, minimumSamples = 1) =>
  rolling(series, windowDays, median, minimumSamples);
