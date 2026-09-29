import { computeBaseline, type Transform } from '../baseline/baseline';
import type { PulseWatchConfig } from '../config/schema';
import { addDays, parseClock, startOfLocalDay } from '../domain/time';
import {
  HOUR_MS,
  MINUTE_MS,
  type DailyMetric,
  type DailyValue,
  type EpochMs,
  type LocalDate,
  type SleepSession,
} from '../domain/types';
import type { GoogleHealthClient } from '../google/client';
import { errorCode } from '../observability/log';
import type { DailyView, StoredBaseline } from '../rules/types';

/** First sync pulls enough history for a 30-day baseline plus headroom. */
export const BACKFILL_DAYS = 60;
/** Routine syncs re-read a few days to pick up late or revised values. */
export const REFRESH_DAYS = 4;
/** Minimum gap between daily-sync attempts while waiting for last night's data. */
export const DAILY_RETRY_MS = 30 * MINUTE_MS;

/**
 * Converts processed main sleeps into per-day values, keyed by the local
 * wake-up date (the date Google also uses for sleep-derived daily metrics).
 * Bed and wake times are minutes from that date's local midnight, so a
 * 23:40 bedtime is -20 and the series stays continuous across midnight.
 */
export function sleepToDailyValues(sessions: readonly SleepSession[]): DailyValue[] {
  const bestByDay = new Map<LocalDate, SleepSession>();
  for (const session of sessions) {
    if (!session.processed || !session.isMainSleep || session.isNap) continue;
    const wakeDay = new Date(session.end + session.endOffsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
    const existing = bestByDay.get(wakeDay);
    if (!existing || session.minutesAsleep > existing.minutesAsleep) bestByDay.set(wakeDay, session);
  }
  const values: DailyValue[] = [];
  for (const [day, session] of bestByDay) {
    const localMidnightAsUtc = Date.parse(`${day}T00:00:00Z`);
    const bedtime = (session.start + session.startOffsetMinutes * MINUTE_MS - localMidnightAsUtc) / MINUTE_MS;
    const waketime = (session.end + session.endOffsetMinutes * MINUTE_MS - localMidnightAsUtc) / MINUTE_MS;
    values.push(
      { metric: 'sleep_minutes', day, value: session.minutesAsleep },
      { metric: 'bedtime', day, value: Math.round(bedtime) },
      { metric: 'waketime', day, value: Math.round(waketime) },
    );
  }
  return values;
}

export interface DailyFetchResult {
  values: DailyValue[];
  failures: string[];
  successes: number;
}

/** Fetches every daily source independently; one failing metric never blocks the rest. */
export async function fetchDailyData(
  health: GoogleHealthClient,
  today: LocalDate,
  now: EpochMs,
  timeZone: string,
  days: number,
): Promise<DailyFetchResult> {
  const from = addDays(today, 1 - days);
  const toExclusive = addDays(today, 1);
  const failures: string[] = [];
  let successes = 0;
  const attempt = async (name: string, fetch: () => Promise<DailyValue[]>): Promise<DailyValue[]> => {
    try {
      const values = await fetch();
      successes += 1;
      return values;
    } catch (error) {
      failures.push(`${name}:${errorCode(error)}`);
      return [];
    }
  };

  const results = await Promise.all([
    attempt('resting_hr', () => health.dailyMetric('resting_hr', from, toExclusive)),
    attempt('hrv', () => health.dailyMetric('hrv', from, toExclusive)),
    attempt('respiratory_rate', () => health.dailyMetric('respiratory_rate', from, toExclusive)),
    // Today's step total is still growing; only completed days are stored.
    attempt('steps', () => health.dailySteps(from, today)),
    attempt('sleep', async () =>
      sleepToDailyValues(
        await health.sleepSessions(startOfLocalDay(from, timeZone) - 12 * HOUR_MS, now + MINUTE_MS),
      ),
    ),
  ]);
  return { values: results.flat(), failures, successes };
}

/** Today's data is "complete" once last night's sleep and a recovery metric exist. */
export function isDailyComplete(values: readonly DailyValue[], today: LocalDate): boolean {
  const has = (metric: DailyMetric) => values.some((v) => v.metric === metric && v.day === today);
  return has('sleep_minutes') && (has('hrv') || has('resting_hr'));
}

export function dailySyncDue(input: {
  now: EpochMs;
  today: LocalDate;
  minuteOfDay: number;
  config: PulseWatchConfig;
  completeDay: string | null;
  lastAttemptAt: number | null;
  backfilled: boolean;
}): boolean {
  if (input.lastAttemptAt !== null && input.now - input.lastAttemptAt < DAILY_RETRY_MS) return false;
  if (!input.backfilled) return true;
  if (input.completeDay === input.today) return false;
  // Start looking two hours before the configured wake time.
  const windowStart = (parseClock(input.config.schedule.wakeTime) - 120 + 1440) % 1440;
  return input.minuteOfDay >= windowStart;
}

interface BaselineSpec {
  metric: DailyMetric;
  transform: Transform;
  minimumSpread: number;
}

const BASELINE_SPECS: BaselineSpec[] = [
  { metric: 'resting_hr', transform: 'none', minimumSpread: 1 },
  { metric: 'hrv', transform: 'log', minimumSpread: 0.05 },
  { metric: 'respiratory_rate', transform: 'none', minimumSpread: 0.3 },
  { metric: 'sleep_minutes', transform: 'none', minimumSpread: 20 },
  { metric: 'steps', transform: 'none', minimumSpread: 500 },
];

/**
 * Daily baseline aggregation (only when new daily data arrives, never on the
 * plain 10-minute path). Like the trend rules, the window stops before the
 * most recent `consecutiveDays`, so a sustained change cannot absorb itself
 * into the "usual range" it is compared against.
 */
export function computeDailyBaselines(
  values: readonly DailyValue[],
  today: LocalDate,
  config: PulseWatchConfig,
): StoredBaseline[] {
  const baselines: StoredBaseline[] = [];
  for (const spec of BASELINE_SPECS) {
    const ruleConfig = spec.metric === 'hrv' ? config.rules.hrv : config.rules.restingHeartRate;
    const result = computeBaseline(
      values.filter((v) => v.metric === spec.metric),
      {
        before: addDays(today, 1 - ruleConfig.consecutiveDays),
        windowDays: ruleConfig.baselineDays,
        minimumSamples: ruleConfig.minimumSamples,
        transform: spec.transform,
        minimumSpread: spec.minimumSpread,
      },
    );
    if (result.ok) baselines.push({ ...result.baseline, metric: spec.metric, computedFor: today });
  }
  return baselines;
}

/** How far back the daily view must reach for every baseline window. */
export function historyStart(today: LocalDate, config: PulseWatchConfig): LocalDate {
  const longest = Math.max(config.rules.restingHeartRate.baselineDays, config.rules.hrv.baselineDays);
  const guard = Math.max(config.rules.restingHeartRate.consecutiveDays, config.rules.hrv.consecutiveDays);
  return addDays(today, -(longest + guard + 2));
}

export function createDailyView(
  today: LocalDate,
  values: readonly DailyValue[],
  baselines: readonly StoredBaseline[],
  syncComplete: boolean,
): DailyView {
  const byMetric = new Map<DailyMetric, DailyValue[]>();
  for (const value of values) {
    const list = byMetric.get(value.metric) ?? [];
    list.push(value);
    byMetric.set(value.metric, list);
  }
  for (const list of byMetric.values()) list.sort((a, b) => a.day.localeCompare(b.day));
  const baselineByMetric = new Map(baselines.map((b) => [b.metric, b]));
  return {
    today,
    syncComplete,
    series: (metric) => (byMetric.get(metric) ?? []).map((v) => ({ day: v.day, value: v.value })),
    value: (metric, day) => byMetric.get(metric)?.find((v) => v.day === day)?.value ?? null,
    baseline: (metric) => {
      const baseline = baselineByMetric.get(metric);
      // A baseline computed on an earlier day is still a fair reference for today.
      return baseline && baseline.computedFor <= today ? baseline : null;
    },
    baselineSamples: (metric) => {
      const since = addDays(today, -30);
      return (byMetric.get(metric) ?? []).filter((v) => v.day >= since && v.day < today).length;
    },
  };
}
