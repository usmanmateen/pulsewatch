import { describe, expect, it } from 'vitest';
import { GoogleApiError } from '../src/google/http';
import {
  dailySteps,
  dailySummaries,
  latestHeartRateTime,
  mergeActivityWindows,
  pageItems,
  rollupWindows,
  selectTracker,
  sleepSessions,
} from '../src/google/normalise';
import { minutes } from './helpers';

describe('envelope validation', () => {
  it('accepts an empty page and rejects wrong shapes', () => {
    expect(pageItems({}, 'dataPoints')).toEqual({ items: [], nextPageToken: null });
    expect(pageItems({ dataPoints: [1], nextPageToken: 'x' }, 'dataPoints')).toEqual({
      items: [1],
      nextPageToken: 'x',
    });
    for (const bad of [null, [], 'text', { dataPoints: {} }, { dataPoints: [], nextPageToken: 5 }]) {
      expect(() => pageItems(bad, 'dataPoints')).toThrow(GoogleApiError);
    }
  });
});

describe('heart rate', () => {
  it('reads only the sample time, and tolerates a malformed point', () => {
    const result = latestHeartRateTime({
      dataPoints: [
        { heartRate: { beatsPerMinute: '61', sampleTime: { physicalTime: '2026-03-10T14:00:30Z' } } },
        { heartRate: { sampleTime: { physicalTime: 'not-a-time' } } },
      ],
    });
    expect(result).toEqual({ at: Date.parse('2026-03-10T14:00:30Z'), skipped: 1 });
    expect(latestHeartRateTime({})).toEqual({ at: null, skipped: 0 });
  });
});

describe('daily summaries', () => {
  it('coerces int64 strings and validates dates and plausible ranges', () => {
    const result = dailySummaries('resting_hr', [
      { dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 10 }, beatsPerMinute: '58' } },
      { dailyRestingHeartRate: { date: { year: 2026, month: 2, day: 30 }, beatsPerMinute: '58' } }, // impossible date
      { dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 9 }, beatsPerMinute: '999' } }, // implausible
      { dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 8 }, beatsPerMinute: 'abc' } },
    ]);
    expect(result.items).toEqual([{ metric: 'resting_hr', day: '2026-03-10', value: 58 }]);
    expect(result.skipped).toBe(3);
  });

  it('keeps one value per day (newest first) and skips days without the average HRV', () => {
    const result = dailySummaries('hrv', [
      {
        dailyHeartRateVariability: {
          date: { year: 2026, month: 3, day: 10 },
          averageHeartRateVariabilityMilliseconds: 48.2,
        },
      },
      {
        dailyHeartRateVariability: {
          date: { year: 2026, month: 3, day: 10 },
          averageHeartRateVariabilityMilliseconds: 40,
        },
      },
      { dailyHeartRateVariability: { date: { year: 2026, month: 3, day: 9 }, entropy: 2.1 } },
    ]);
    expect(result.items).toEqual([{ metric: 'hrv', day: '2026-03-10', value: 48.2 }]);
    expect(result.skipped).toBe(2);
  });

  it('parses the respiratory rate and daily step rollups', () => {
    expect(
      dailySummaries('respiratory_rate', [
        { dailyRespiratoryRate: { date: { year: 2026, month: 3, day: 10 }, breathsPerMinute: 14.6 } },
      ]).items,
    ).toEqual([{ metric: 'respiratory_rate', day: '2026-03-10', value: 14.6 }]);
    expect(
      dailySteps([
        { civilStartTime: { date: { year: 2026, month: 3, day: 9 }, time: {} }, steps: { countSum: '8421' } },
        { civilStartTime: { date: { year: 2026, month: 3, day: 8 } } }, // no steps recorded → 0
      ]).items,
    ).toEqual([
      { metric: 'steps', day: '2026-03-09', value: 8421 },
      { metric: 'steps', day: '2026-03-08', value: 0 },
    ]);
  });
});

describe('sleep', () => {
  const point = (sleep: Record<string, unknown>) => ({
    name: 'users/me/dataTypes/sleep/dataPoints/1',
    sleep,
  });
  const interval = {
    startTime: '2026-03-09T23:20:00Z',
    endTime: '2026-03-10T06:50:00Z',
    startUtcOffset: '0s',
    endUtcOffset: '3600s',
  };

  it('parses processed sessions with string int64 summaries and duration offsets', () => {
    const result = sleepSessions([
      point({
        interval,
        metadata: { mainSleep: true, processed: true },
        summary: { minutesAsleep: '412', minutesInSleepPeriod: '450' },
      }),
    ]);
    expect(result.items[0]).toMatchObject({
      minutesAsleep: 412,
      endOffsetMinutes: 60,
      isMainSleep: true,
      processed: true,
    });
  });

  it('accepts still-processing sessions without a summary, rejects inconsistent ones', () => {
    const result = sleepSessions([
      point({ interval, metadata: { mainSleep: true, processed: false } }),
      point({ interval, metadata: { processed: true } }), // processed but no summary
      point({ interval, metadata: { processed: true }, summary: { minutesAsleep: '900' } }), // longer than the session
      point({ interval: { ...interval, endTime: '2026-03-09T22:00:00Z' }, summary: { minutesAsleep: '10' } }),
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ processed: false, minutesAsleep: 0 });
    expect(result.skipped).toBe(3);
  });
});

describe('paired devices', () => {
  const devices = {
    pairedDevices: [
      { deviceType: 'SCALE', deviceVersion: 'Aria Air', lastSyncTime: '2026-03-10T14:00:00Z' },
      {
        deviceType: 'TRACKER',
        deviceVersion: 'Charge 6',
        lastSyncTime: '2026-01-01T10:00:00Z',
        batteryLevel: 40,
      },
      {
        deviceType: 'TRACKER',
        deviceVersion: 'Fitbit Air',
        lastSyncTime: '2026-03-10T13:55:00Z',
        batteryLevel: 12,
        batteryStatus: 'Low',
      },
    ],
  };

  it('picks the most recently synced tracker and ignores scales', () => {
    expect(selectTracker(devices)).toEqual({
      model: 'Fitbit Air',
      lastSyncAt: Date.parse('2026-03-10T13:55:00Z'),
      batteryLevel: 12,
      batteryStatus: 'LOW',
    });
  });

  it('can pin a model, and returns null when nothing matches', () => {
    expect(selectTracker(devices, 'charge 6')?.model).toBe('Charge 6');
    expect(selectTracker({ pairedDevices: [] })).toBeNull();
    expect(selectTracker({})).toBeNull();
  });
});

describe('activity windows', () => {
  it('aligns rollups onto a grid; missing windows mean no steps and no heart rate', () => {
    const start = Date.parse('2026-03-10T13:00:00Z');
    const steps = rollupWindows([
      { startTime: '2026-03-10T13:00:00Z', endTime: '2026-03-10T13:05:00Z', steps: { countSum: '120' } },
    ]);
    const hr = rollupWindows([
      {
        startTime: '2026-03-10T13:00:00Z',
        endTime: '2026-03-10T13:05:00Z',
        heartRate: { beatsPerMinuteAvg: 70 },
      },
      {
        startTime: '2026-03-10T13:05:00Z',
        endTime: '2026-03-10T13:10:00Z',
        heartRate: { beatsPerMinuteAvg: 66 },
      },
      { startTime: '2026-03-10T13:10:00Z', endTime: '2026-03-10T13:05:00Z' }, // inverted: skipped
    ]);
    expect(hr.skipped).toBe(1);
    const merged = mergeActivityWindows(start, start + minutes(15), minutes(5), steps.items, hr.items);
    expect(merged.map((w) => [w.steps, w.heartRateObserved])).toEqual([
      [120, true],
      [0, true],
      [0, false],
    ]);
  });
});
