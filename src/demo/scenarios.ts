import { parseClock, zonedTimeToEpoch } from '../domain/time';
import { MINUTE_MS, type EpochMs, type LocalDate } from '../domain/types';
import type { NtfyFailurePlan } from './ntfy-emulator';
import { DEFAULT_PROFILE, type Interval, type WorldSpec } from './world';

/**
 * Scripted demo scenarios. Each is a synthetic person plus a timeline; the
 * runner advances a simulated clock through it in 10-minute checks exactly
 * as the cron trigger would.
 */

export interface Scenario {
  id: string;
  title: string;
  description: string;
  /** Local time of the first check. */
  start: string;
  checks: number;
  world(at: (clock: string) => EpochMs): Partial<WorldSpec>;
  ntfyFailures?: NtfyFailurePlan;
  duplicateQueueDelivery?: boolean;
  /** Rule ids expected to notify (used by the scenario tests). */
  expectNotifications: string[];
}

export const DEMO_TIME_ZONE = 'Europe/London';
/** A fixed date keeps demo output reproducible. */
export const DEMO_DAY: LocalDate = '2026-03-10';

const between = (start: EpochMs, end: EpochMs): Interval => ({ start, end });

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'normal-day',
    title: 'Normal day',
    description: 'Tracker worn, typical night. The only notification is the morning brief.',
    start: '07:20',
    checks: 7,
    world: () => ({}),
    expectNotifications: ['morningBrief'],
  },
  {
    id: 'wearable-removed',
    title: 'Wearable removed',
    description: 'Taken off at 14:00 and not put back. One reminder, no repeats.',
    start: '13:50',
    checks: 10,
    world: (at) => ({ offWrist: [between(at('14:00'), at('23:59'))] }),
    expectNotifications: ['deviceOffWrist'],
  },
  {
    id: 'wearable-removed-recovered',
    title: 'Wearable removed, then recovered',
    description: 'Off for a shower at 14:00, back on at 15:05. The reminder is cleared on recovery.',
    start: '13:50',
    checks: 11,
    world: (at) => ({ offWrist: [between(at('14:00'), at('15:05'))] }),
    expectNotifications: ['deviceOffWrist'],
  },
  {
    id: 'stale-sync',
    title: 'Stale device sync',
    description: 'Worn, but the phone is out of range from 14:00. PulseWatch refuses to claim it is off.',
    start: '13:50',
    checks: 10,
    world: (at) => ({ syncOutages: [between(at('14:00'), at('18:00'))] }),
    expectNotifications: ['deviceOffWrist'],
  },
  {
    id: 'low-battery',
    title: 'Low battery',
    description: 'Last sync reported 9% battery, then the tracker went silent.',
    start: '13:50',
    checks: 10,
    world: (at) => ({
      battery: [
        { at: at('12:00'), level: 14 },
        { at: at('14:12'), level: 9 },
        { at: at('14:14'), level: 0 },
      ],
    }),
    expectNotifications: ['deviceOffWrist'],
  },
  {
    id: 'empty-battery',
    title: 'Empty battery',
    description: 'The tracker reported an empty battery at its last sync and then died.',
    start: '13:50',
    checks: 8,
    world: (at) => ({
      battery: [
        { at: at('12:00'), level: 8 },
        { at: at('14:04'), level: 3 },
        { at: at('14:07'), level: 0 },
      ],
    }),
    expectNotifications: ['deviceOffWrist'],
  },
  {
    id: 'short-sleep',
    title: 'Short sleep',
    description: 'Last night 4h 55m against a 6h 30m target.',
    start: '07:20',
    checks: 7,
    world: () => ({ dailyOverrides: { sleep_minutes: { 0: 295 } } }),
    expectNotifications: ['sleep', 'morningBrief'],
  },
  {
    id: 'hrv-trend',
    title: 'Unusual HRV trend',
    description: 'Overnight HRV about 35% below the personal baseline for three days.',
    start: '07:20',
    checks: 7,
    world: () => ({ dailyOverrides: { hrv: { [-2]: 33.5, [-1]: 34.1, 0: 32.8 } } }),
    expectNotifications: ['hrv', 'morningBrief'],
  },
  {
    id: 'resting-hr-trend',
    title: 'Higher resting-HR trend',
    description: 'Resting heart rate 7–8 bpm above the personal baseline for three days.',
    start: '07:20',
    checks: 7,
    world: () => ({ dailyOverrides: { resting_hr: { [-2]: 64, [-1]: 65, 0: 64 } } }),
    expectNotifications: ['restingHeartRate', 'morningBrief'],
  },
  {
    id: 'inactivity',
    title: 'Extended inactivity',
    description: 'Sitting from 13:00 while wearing the tracker; a walk at 15:10 clears the nudge.',
    start: '14:20',
    checks: 10,
    world: (at) => ({
      sedentary: [between(at('13:00'), at('15:10'))],
      walks: [between(at('15:10'), at('15:18'))],
    }),
    expectNotifications: ['inactivity'],
  },
  {
    id: 'notification-retry',
    title: 'Notification retry',
    description:
      'ntfy.sh rejects the first two attempts with its daily-quota 429; the queue retries with backoff.',
    start: '13:50',
    checks: 12,
    world: (at) => ({ offWrist: [between(at('14:00'), at('23:59'))] }),
    ntfyFailures: { rejectFirst: 2, status: 429, code: 42908 },
    expectNotifications: ['deviceOffWrist'],
  },
  {
    id: 'duplicate-queue-delivery',
    title: 'Duplicate queue message',
    description: 'The queue delivers the same message twice; the phone still gets exactly one notification.',
    start: '13:50',
    checks: 8,
    world: (at) => ({ offWrist: [between(at('14:00'), at('23:59'))] }),
    duplicateQueueDelivery: true,
    expectNotifications: ['deviceOffWrist'],
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

export function buildWorldSpec(
  scenario: Scenario,
  day: LocalDate = DEMO_DAY,
  timeZone = DEMO_TIME_ZONE,
): WorldSpec {
  const at = (clock: string): EpochMs => zonedTimeToEpoch(day, parseClock(clock), timeZone);
  return {
    timeZone,
    seed: 20260310,
    deviceModel: 'Fitbit Air',
    today: day,
    historyDays: 70,
    profile: DEFAULT_PROFILE,
    dailyOverrides: {},
    offWrist: [],
    syncOutages: [],
    sedentary: [],
    battery: [{ at: at('00:00'), level: 78 }],
    syncIntervalMinutes: 15,
    sleepProcessingMinutes: 20,
    ...scenario.world(at),
  };
}

export function scenarioStart(
  scenario: Scenario,
  day: LocalDate = DEMO_DAY,
  timeZone = DEMO_TIME_ZONE,
): EpochMs {
  return zonedTimeToEpoch(day, parseClock(scenario.start), timeZone);
}

export const CHECK_INTERVAL_MS = 10 * MINUTE_MS;
