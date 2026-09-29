import {
  addDays,
  isInDailyWindow,
  localDate,
  minutesOfDay,
  parseClock,
  zonedTimeToEpoch,
} from '../domain/time';
import { MINUTE_MS, type EpochMs } from '../domain/types';
import type { Schedule } from './types';

/**
 * Notification policies shared by several rules. Rules call these while
 * evaluating, so a deferred alert simply stays "not yet notified" in the
 * rule's own state and goes out on a later check.
 */

export function isWakingHours(now: EpochMs, timeZone: string, schedule: Schedule): boolean {
  return isInDailyWindow(
    minutesOfDay(now, timeZone),
    parseClock(schedule.wakeTime),
    parseClock(schedule.sleepTime),
  );
}

/** Start of the current waking period (today's wake time, or yesterday's for late evenings). */
export function currentWakeStart(now: EpochMs, timeZone: string, schedule: Schedule): EpochMs {
  const today = localDate(now, timeZone);
  const wakeToday = zonedTimeToEpoch(today, parseClock(schedule.wakeTime), timeZone);
  return wakeToday <= now
    ? wakeToday
    : zonedTimeToEpoch(addDays(today, -1), parseClock(schedule.wakeTime), timeZone);
}

export function cooldownElapsed(lastAt: EpochMs | null, now: EpochMs, cooldownMinutes: number): boolean {
  return lastAt === null || now - lastAt >= cooldownMinutes * MINUTE_MS;
}
