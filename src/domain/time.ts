import { DAY_MS, MINUTE_MS, type EpochMs, type LocalDate } from './types';

/**
 * Time-zone helpers built on `Intl` so daylight-saving rules come from the
 * runtime's tz database rather than hand-written offsets. Cron triggers fire
 * in UTC; every "local" decision (waking hours, morning brief, day
 * boundaries) goes through these functions.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(at: EpochMs, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some engines render midnight as hour 24 even with h23.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

export function formatLocalDate(year: number, month: number, day: number): LocalDate {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function localDate(at: EpochMs, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(at, timeZone);
  return formatLocalDate(year, month, day);
}

/** Minutes since local midnight (0–1439). */
export function minutesOfDay(at: EpochMs, timeZone: string): number {
  const { hour, minute } = zonedParts(at, timeZone);
  return hour * 60 + minute;
}

/** The offset (in minutes) between local wall-clock time and UTC at an instant. */
export function utcOffsetMinutes(at: EpochMs, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(at / 1000) * 1000;
  return Math.round((asUtc - truncated) / MINUTE_MS);
}

export function parseLocalDate(date: LocalDate): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid local date: ${date}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  // Noon UTC keeps the arithmetic clear of any DST edge.
  const shifted = new Date(Date.UTC(year, month - 1, day, 12) + days * DAY_MS);
  return formatLocalDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

/**
 * The UTC instant at which local wall-clock time reads `date` + `minutes`.
 * Iterates the offset once to settle on the correct side of a DST change.
 * For a wall time that does not exist (spring-forward gap) the result lands
 * just after the gap, which is the useful answer for scheduling.
 */
export function zonedTimeToEpoch(date: LocalDate, minutes: number, timeZone: string): EpochMs {
  const { year, month, day } = parseLocalDate(date);
  const wallClockAsUtc = Date.UTC(year, month - 1, day) + minutes * MINUTE_MS;
  const firstGuess = wallClockAsUtc - utcOffsetMinutes(wallClockAsUtc, timeZone) * MINUTE_MS;
  const secondOffset = utcOffsetMinutes(firstGuess, timeZone);
  return wallClockAsUtc - secondOffset * MINUTE_MS;
}

export function startOfLocalDay(date: LocalDate, timeZone: string): EpochMs {
  return zonedTimeToEpoch(date, 0, timeZone);
}

/** Parses `HH:MM` into minutes since midnight. */
export function parseClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Invalid clock time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether `minute` (minutes since midnight) falls in the daily window
 * [start, end). Windows may wrap midnight, e.g. 23:00–07:00.
 */
export function isInDailyWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
