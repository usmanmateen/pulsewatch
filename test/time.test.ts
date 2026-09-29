import { describe, expect, it } from 'vitest';
import { formatClockMinutes, formatCount, formatDuration, formatSigned } from '../src/domain/format';
import {
  addDays,
  daysBetween,
  isInDailyWindow,
  isValidTimeZone,
  localDate,
  minutesOfDay,
  parseClock,
  utcOffsetMinutes,
  zonedTimeToEpoch,
} from '../src/domain/time';
import { isWakingHours } from '../src/rules/policy';
import { config } from './helpers';

const LONDON = 'Europe/London';

describe('local time and daylight saving (Europe/London)', () => {
  it('knows the UTC offset either side of the spring and autumn changes', () => {
    expect(utcOffsetMinutes(Date.UTC(2026, 2, 29, 0, 59), LONDON)).toBe(0);
    expect(utcOffsetMinutes(Date.UTC(2026, 2, 29, 1, 0), LONDON)).toBe(60);
    expect(utcOffsetMinutes(Date.UTC(2026, 9, 25, 0, 59), LONDON)).toBe(60);
    expect(utcOffsetMinutes(Date.UTC(2026, 9, 25, 1, 0), LONDON)).toBe(0);
  });

  it('maps local wall-clock times to the right instant in summer and winter', () => {
    expect(zonedTimeToEpoch('2026-01-15', parseClock('07:30'), LONDON)).toBe(Date.UTC(2026, 0, 15, 7, 30));
    expect(zonedTimeToEpoch('2026-07-15', parseClock('07:30'), LONDON)).toBe(Date.UTC(2026, 6, 15, 6, 30));
  });

  it('handles the spring-forward gap and the autumn repeat', () => {
    // 01:30 does not exist on 29 March; the result lands after the gap.
    expect(localDate(zonedTimeToEpoch('2026-03-29', parseClock('01:30'), LONDON), LONDON)).toBe('2026-03-29');
    // 01:30 happens twice on 25 October; either instant reads 01:30 locally.
    const repeated = zonedTimeToEpoch('2026-10-25', parseClock('01:30'), LONDON);
    expect(minutesOfDay(repeated, LONDON)).toBe(90);
  });

  it('computes the local date across midnight and year boundaries', () => {
    expect(localDate(Date.UTC(2026, 6, 15, 23, 30), LONDON)).toBe('2026-07-16'); // 00:30 BST
    expect(localDate(Date.UTC(2026, 11, 31, 23, 30), LONDON)).toBe('2026-12-31'); // GMT
    expect(localDate(Date.UTC(2026, 11, 31, 23, 30), 'Asia/Tokyo')).toBe('2027-01-01');
  });

  it('adds days across month ends, leap years and DST without drifting', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('evaluates waking hours in local time, so a UTC cron sees the right hour after DST', () => {
    // 06:30 UTC is 07:30 BST (awake) in July but 06:30 GMT (asleep) in January.
    expect(isWakingHours(Date.UTC(2026, 6, 15, 6, 30), LONDON, config.schedule)).toBe(true);
    expect(isWakingHours(Date.UTC(2026, 0, 15, 6, 30), LONDON, config.schedule)).toBe(false);
  });
});

describe('daily windows and parsing', () => {
  it('supports windows that wrap midnight', () => {
    const start = parseClock('23:00');
    const end = parseClock('07:00');
    expect(isInDailyWindow(parseClock('23:30'), start, end)).toBe(true);
    expect(isInDailyWindow(parseClock('06:59'), start, end)).toBe(true);
    expect(isInDailyWindow(parseClock('07:00'), start, end)).toBe(false);
    expect(isInDailyWindow(parseClock('12:00'), parseClock('07:00'), parseClock('23:00'))).toBe(true);
  });

  it('validates clock strings and time zones', () => {
    expect(() => parseClock('24:00')).toThrow();
    expect(() => parseClock('7:30')).toThrow();
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats durations, counts, signs and clock minutes', () => {
    expect(formatDuration(408)).toBe('6h 48m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatCount(8421)).toBe('8,421');
    expect(formatSigned(12)).toBe('+12');
    expect(formatSigned(-7.4)).toBe('−7');
    expect(formatClockMinutes(-52)).toBe('23:08');
    expect(formatClockMinutes(410)).toBe('06:50');
  });
});
