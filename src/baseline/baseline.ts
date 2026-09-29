import { addDays } from '../domain/time';
import type { LocalDate } from '../domain/types';
import {
  MAD_TO_SIGMA,
  mean,
  median,
  medianAbsoluteDeviation,
  percentChange,
  standardDeviation,
  type DailyPoint,
} from './stats';

/**
 * Personal baselines: "what is usual for this person recently", and how
 * unusual a given day is relative to that. This is a description of the
 * user's own history, not a clinical reference range.
 *
 * Method (see ARCHITECTURE.md for the reasoning):
 * - Centre and spread are the median and the MAD scaled to σ (×1.4826),
 *   which one bad night or sensor glitch cannot drag around the way it can
 *   a mean and standard deviation.
 * - HRV uses a log transform: RMSSD is right-skewed and changes are
 *   multiplicative, so "20% lower" is comparable at any level.
 * - A spread floor stops an unusually stable history from turning a
 *   trivial change into a huge z-score.
 * - The evaluated days are excluded from their own baseline (`before`).
 */

export type Transform = 'none' | 'log';

export interface BaselineOptions {
  /** The baseline covers the `windowDays` days strictly before this day. */
  before: LocalDate;
  windowDays: number;
  minimumSamples: number;
  transform?: Transform;
  /** Floor for the robust spread, in transformed units. */
  minimumSpread?: number;
}

export interface Baseline {
  windowStart: LocalDate;
  windowEnd: LocalDate;
  samples: number;
  transform: Transform;
  /** Descriptive statistics in the metric's own units. */
  mean: number;
  median: number;
  standardDeviation: number;
  mad: number;
  /** Robust centre and spread in transformed units, used for z-scores. */
  center: number;
  spread: number;
}

export type BaselineResult =
  | { ok: true; baseline: Baseline }
  | { ok: false; reason: 'insufficient_samples'; samples: number; required: number };

const applyTransform = (value: number, transform: Transform): number =>
  transform === 'log' ? Math.log(value) : value;

export function computeBaseline(series: readonly DailyPoint[], options: BaselineOptions): BaselineResult {
  const transform = options.transform ?? 'none';
  const windowStart = addDays(options.before, -options.windowDays);
  const windowEnd = addDays(options.before, -1);
  const byDay = new Map<LocalDate, number>();
  for (const point of series) {
    const usable = Number.isFinite(point.value) && (transform !== 'log' || point.value > 0);
    if (usable && point.day >= windowStart && point.day <= windowEnd) byDay.set(point.day, point.value);
  }
  const values = [...byDay.values()];
  if (values.length < options.minimumSamples || values.length === 0) {
    return {
      ok: false,
      reason: 'insufficient_samples',
      samples: values.length,
      required: options.minimumSamples,
    };
  }
  const transformed = values.map((value) => applyTransform(value, transform));
  const robustSpread = MAD_TO_SIGMA * medianAbsoluteDeviation(transformed);
  return {
    ok: true,
    baseline: {
      windowStart,
      windowEnd,
      samples: values.length,
      transform,
      mean: mean(values),
      median: median(values),
      standardDeviation: standardDeviation(values),
      mad: medianAbsoluteDeviation(values),
      center: median(transformed),
      spread: Math.max(robustSpread, options.minimumSpread ?? Number.EPSILON),
    },
  };
}

export interface Deviation {
  value: number;
  /** Difference from the baseline median, in the metric's units. */
  delta: number;
  /** Difference from the baseline median as a percentage. */
  percent: number | null;
  /** Robust z-score: distance from the centre in units of robust spread. */
  z: number;
}

export function compareToBaseline(value: number, baseline: Baseline): Deviation {
  const transformed = applyTransform(value, baseline.transform);
  return {
    value,
    delta: value - baseline.median,
    percent: percentChange(value, baseline.median),
    z: (transformed - baseline.center) / baseline.spread,
  };
}

export type Direction = 'above' | 'below' | 'either';

export interface DeviationThresholds {
  direction: Direction;
  zThreshold: number;
  /** Minimum absolute change in metric units (e.g. bpm). */
  minimumDelta?: number;
  /** Minimum change as a percentage of the baseline median. */
  minimumPercent?: number;
}

/** Whether one day's deviation is unusual in the given direction. */
export function isUnusual(
  deviation: Deviation,
  thresholds: DeviationThresholds,
  side: 'above' | 'below',
): boolean {
  if (thresholds.direction !== 'either' && thresholds.direction !== side) return false;
  const sign = side === 'above' ? 1 : -1;
  const percent = deviation.percent ?? 0;
  return (
    sign * deviation.z >= thresholds.zThreshold &&
    sign * deviation.delta >= (thresholds.minimumDelta ?? 0) &&
    sign * percent >= (thresholds.minimumPercent ?? 0)
  );
}

/** Which side of the usual range a value falls on, if either. */
export function unusualSide(deviation: Deviation, thresholds: DeviationThresholds): 'above' | 'below' | null {
  if (isUnusual(deviation, thresholds, 'above')) return 'above';
  if (isUnusual(deviation, thresholds, 'below')) return 'below';
  return null;
}

export interface SustainedDeviation {
  sustained: boolean;
  side: 'above' | 'below' | null;
  /** The evaluated days, oldest first. */
  days: Array<{ day: LocalDate; deviation: Deviation | null }>;
  reason: 'sustained' | 'missing_days' | 'within_range' | 'mixed_direction';
}

/**
 * True when each of the `days` consecutive calendar days ending on
 * `lastDay` is unusual on the same side. A missing day breaks the run:
 * absence of data is never treated as evidence.
 */
export function detectSustainedDeviation(
  series: readonly DailyPoint[],
  baseline: Baseline,
  lastDay: LocalDate,
  days: number,
  thresholds: DeviationThresholds,
): SustainedDeviation {
  const values = new Map(series.map((point) => [point.day, point.value]));
  const evaluated: SustainedDeviation['days'] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = addDays(lastDay, -offset);
    const value = values.get(day);
    evaluated.push({ day, deviation: value === undefined ? null : compareToBaseline(value, baseline) });
  }
  if (evaluated.some((entry) => entry.deviation === null)) {
    return { sustained: false, side: null, days: evaluated, reason: 'missing_days' };
  }
  const sides = evaluated.map((entry) => unusualSide(entry.deviation!, thresholds));
  if (sides.some((side) => side === null)) {
    return { sustained: false, side: null, days: evaluated, reason: 'within_range' };
  }
  if (new Set(sides).size > 1) {
    return { sustained: false, side: null, days: evaluated, reason: 'mixed_direction' };
  }
  return { sustained: true, side: sides[0]!, days: evaluated, reason: 'sustained' };
}
