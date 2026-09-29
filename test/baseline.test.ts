import { describe, expect, it } from 'vitest';
import {
  compareToBaseline,
  computeBaseline,
  detectSustainedDeviation,
  unusualSide,
  type Baseline,
} from '../src/baseline/baseline';
import {
  mean,
  median,
  medianAbsoluteDeviation,
  percentChange,
  rollingMean,
  rollingMedian,
  standardDeviation,
} from '../src/baseline/stats';
import { addDays } from '../src/domain/time';
import { series, wobble } from './helpers';

const points = (values: number[], lastDay = '2026-03-10') =>
  values.map((value, i) => ({ day: addDays(lastDay, i - values.length + 1), value }));

describe('descriptive statistics', () => {
  it('computes mean, median, sample SD and MAD', () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(values)).toBe(5);
    expect(median(values)).toBe(4.5);
    expect(standardDeviation(values)).toBeCloseTo(2.138, 3);
    expect(medianAbsoluteDeviation(values)).toBe(0.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(standardDeviation([42])).toBe(0);
  });

  it('rejects empty input and handles a zero reference in percentages', () => {
    expect(() => mean([])).toThrow(RangeError);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(55, 50)).toBeCloseTo(10);
  });

  it('is robust: one outlier moves the mean and SD but barely the median and MAD', () => {
    const typical = [58, 57, 59, 58, 56, 58, 57, 59, 58, 57];
    const withOutlier = [...typical.slice(0, 9), 95];
    expect(mean(withOutlier) - mean(typical)).toBeGreaterThan(3.5);
    expect(standardDeviation(withOutlier)).toBeGreaterThan(5 * standardDeviation(typical));
    expect(Math.abs(median(withOutlier) - median(typical))).toBeLessThanOrEqual(0.5);
    expect(medianAbsoluteDeviation(withOutlier)).toBeLessThanOrEqual(1);
  });
});

describe('rolling windows', () => {
  it('uses calendar windows, so gaps shrink the sample instead of borrowing older days', () => {
    const data = [
      { day: '2026-03-01', value: 10 },
      { day: '2026-03-02', value: 20 },
      { day: '2026-03-05', value: 30 },
    ];
    const means = rollingMean(data, 3);
    expect(means.map((p) => [p.day, p.value, p.samples])).toEqual([
      ['2026-03-01', 10, 1],
      ['2026-03-02', 15, 2],
      ['2026-03-05', 30, 1],
    ]);
  });

  it('honours the minimum sample count', () => {
    const medians = rollingMedian(points([1, 2, 3, 4]), 7, 3);
    expect(medians.map((p) => p.value)).toEqual([null, null, 2, 2.5]);
  });
});

describe('computeBaseline', () => {
  const history = points(Array.from({ length: 40 }, (_, i) => 58 + wobble(i) * 2));

  it('uses only the window strictly before the evaluated day', () => {
    const result = computeBaseline(history, { before: '2026-03-10', windowDays: 30, minimumSamples: 14 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline).toMatchObject({
      windowStart: '2026-02-08',
      windowEnd: '2026-03-09',
      samples: 30,
    });
  });

  it('refuses to produce a baseline from too few samples', () => {
    const result = computeBaseline(points([58, 57, 59, 60, 58]), {
      before: '2026-03-11',
      windowDays: 30,
      minimumSamples: 14,
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_samples', samples: 5, required: 14 });
  });

  it('applies a spread floor so a very stable history cannot create huge z-scores', () => {
    const flat = points(
      Array.from({ length: 30 }, () => 58),
      '2026-03-09',
    );
    const result = computeBaseline(flat, {
      before: '2026-03-10',
      windowDays: 30,
      minimumSamples: 14,
      minimumSpread: 1,
    });
    if (!result.ok) throw new Error('expected a baseline');
    expect(result.baseline.mad).toBe(0);
    expect(result.baseline.spread).toBe(1);
    expect(compareToBaseline(59, result.baseline).z).toBe(1);
  });

  it('log transform makes HRV deviations multiplicative', () => {
    const hrv = points(
      Array.from({ length: 30 }, (_, i) => 50 * Math.exp(wobble(i) * 0.1)),
      '2026-03-09',
    );
    const result = computeBaseline(hrv, {
      before: '2026-03-10',
      windowDays: 30,
      minimumSamples: 14,
      transform: 'log',
      minimumSpread: 0.05,
    });
    if (!result.ok) throw new Error('expected a baseline');
    // Halving and doubling are equally unusual around the (geometric) centre.
    const centre = Math.exp(result.baseline.center);
    const halved = compareToBaseline(centre / 2, result.baseline);
    const doubled = compareToBaseline(centre * 2, result.baseline);
    expect(halved.z).toBeCloseTo(-doubled.z, 6);
    expect(compareToBaseline(result.baseline.median / 2, result.baseline).percent).toBeCloseTo(-50, 6);
  });

  it('ignores non-positive values under a log transform', () => {
    const result = computeBaseline(points([0, -1, ...Array.from({ length: 14 }, () => 50)], '2026-03-09'), {
      before: '2026-03-10',
      windowDays: 30,
      minimumSamples: 14,
      transform: 'log',
    });
    expect(result.ok && result.baseline.samples).toBe(14);
  });
});

describe('sustained deviation', () => {
  const baselineFor = (values: number[]): Baseline => {
    const result = computeBaseline(points(values, '2026-03-07'), {
      before: '2026-03-08',
      windowDays: 30,
      minimumSamples: 14,
      minimumSpread: 1,
    });
    if (!result.ok) throw new Error('expected a baseline');
    return result.baseline;
  };
  const history = Array.from({ length: 30 }, (_, i) => 58 + wobble(i) * 1.5);
  const baseline = baselineFor(history);
  const thresholds = { direction: 'above' as const, zThreshold: 2, minimumDelta: 3 };

  it('flags N consecutive unusual days on the same side', () => {
    const recent = [...points(history, '2026-03-07'), ...points([65, 66, 64])];
    const result = detectSustainedDeviation(recent, baseline, '2026-03-10', 3, thresholds);
    expect(result).toMatchObject({ sustained: true, side: 'above', reason: 'sustained' });
    expect(result.days.map((d) => d.day)).toEqual(['2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('a single noisy day is not a trend', () => {
    const result = detectSustainedDeviation(points([58, 58, 72]), baseline, '2026-03-10', 3, thresholds);
    expect(result).toMatchObject({ sustained: false, reason: 'within_range' });
  });

  it('a missing day breaks the run (absence of data is not evidence)', () => {
    const result = detectSustainedDeviation(
      [
        { day: '2026-03-08', value: 66 },
        { day: '2026-03-10', value: 66 },
      ],
      baseline,
      '2026-03-10',
      3,
      thresholds,
    );
    expect(result).toMatchObject({ sustained: false, reason: 'missing_days' });
  });

  it('requires one direction when either is allowed', () => {
    const result = detectSustainedDeviation(points([66, 50, 66]), baseline, '2026-03-10', 3, {
      ...thresholds,
      direction: 'either',
    });
    expect(result).toMatchObject({ sustained: false, reason: 'mixed_direction' });
  });

  it('requires both statistical and practical significance', () => {
    // A very stable history: spread sits at its 1 bpm floor.
    const stable = baselineFor(Array.from({ length: 30 }, (_, i) => 58 + wobble(i) * 0.3));
    const deviation = compareToBaseline(stable.median + 2.5, stable);
    expect(deviation.z).toBeGreaterThan(2);
    // Statistically unusual, but under the 3 bpm minimum change.
    expect(unusualSide(deviation, thresholds)).toBeNull();
    expect(unusualSide(compareToBaseline(stable.median + 5, stable), thresholds)).toBe('above');
    // Direction 'above' ignores drops.
    expect(unusualSide(compareToBaseline(stable.median - 5, stable), thresholds)).toBeNull();
  });

  it('works on a realistic generated series', () => {
    const rhr = series('resting_hr', '2026-03-10', 33, (i) => (i >= 30 ? 65 : 58 + wobble(i) * 1.5));
    const result = detectSustainedDeviation(rhr, baseline, '2026-03-10', 3, thresholds);
    expect(result.sustained).toBe(true);
  });
});
