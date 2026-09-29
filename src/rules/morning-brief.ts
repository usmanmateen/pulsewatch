import * as z from 'zod';
import { compareToBaseline, unusualSide, type DeviationThresholds } from '../baseline/baseline';
import { formatCount, formatDuration, formatNumber } from '../domain/format';
import { addDays, localDate, minutesOfDay, parseClock } from '../domain/time';
import type { DailyMetric } from '../domain/types';
import { sleepTiming } from './sleep';
import type { DailyView, HealthRule, RulesConfigSlice } from './types';

type BriefConfig = RulesConfigSlice<'morningBrief'>;

/** A brief this late after the configured deadline is no longer useful. */
const SKIP_AFTER_DEADLINE_MINUTES = 90;

const stateSchema = z.object({
  lastSentDay: z.string().nullable(),
  lastSkippedDay: z.string().nullable(),
});
export type BriefState = z.infer<typeof stateSchema>;

interface DeviationCheck {
  metric: DailyMetric;
  label: string;
  thresholds: DeviationThresholds;
  describe(delta: number, percent: number | null, side: 'above' | 'below'): string;
}

/** Deliberately conservative: the brief mentions only clear departures from usual. */
const DEVIATION_CHECKS: DeviationCheck[] = [
  {
    metric: 'resting_hr',
    label: 'Resting HR',
    thresholds: { direction: 'either', zThreshold: 2, minimumDelta: 3 },
    describe: (delta, _p, side) =>
      `Resting HR is ${formatNumber(Math.abs(delta))} bpm ${side} your usual range.`,
  },
  {
    metric: 'hrv',
    label: 'HRV',
    thresholds: { direction: 'either', zThreshold: 2, minimumPercent: 15 },
    describe: (_d, percent, side) =>
      `HRV is ${formatNumber(Math.abs(percent ?? 0))}% ${side} your usual range.`,
  },
  {
    metric: 'respiratory_rate',
    label: 'Respiratory rate',
    thresholds: { direction: 'either', zThreshold: 2, minimumDelta: 1 },
    describe: (delta, _p, side) =>
      `Respiratory rate is ${formatNumber(Math.abs(delta), 1)} /min ${side} your usual range.`,
  },
  {
    metric: 'sleep_minutes',
    label: 'Sleep',
    thresholds: { direction: 'either', zThreshold: 2, minimumDelta: 45 },
    describe: (delta, _p, side) =>
      `Sleep was ${formatDuration(Math.abs(delta))} ${side === 'above' ? 'longer' : 'shorter'} than usual.`,
  },
];

/** Builds the brief's lines. Missing metrics are omitted, never estimated. */
export function composeBrief(daily: DailyView): string[] {
  const today = daily.today;
  const lines: string[] = [];

  const sleepMinutes = daily.value('sleep_minutes', today);
  if (sleepMinutes !== null) {
    const timing = sleepTiming(daily, today);
    lines.push(`Sleep: ${formatDuration(sleepMinutes)}${timing ? ` (${timing})` : ''}`);
  }
  const restingHr = daily.value('resting_hr', today);
  if (restingHr !== null) lines.push(`Resting HR: ${formatNumber(restingHr)} bpm`);
  const hrv = daily.value('hrv', today);
  if (hrv !== null) lines.push(`HRV: ${formatNumber(hrv)} ms`);
  const respiratory = daily.value('respiratory_rate', today);
  if (respiratory !== null) lines.push(`Respiratory rate: ${formatNumber(respiratory, 1)} /min`);
  const steps = daily.value('steps', addDays(today, -1));
  if (steps !== null) lines.push(`Yesterday: ${formatCount(steps)} steps`);

  if (lines.length === 0) return lines;

  const notes: string[] = [];
  let compared = 0;
  for (const check of DEVIATION_CHECKS) {
    const value = daily.value(check.metric, today);
    const baseline = daily.baseline(check.metric);
    if (value === null || baseline === null) continue;
    compared += 1;
    const deviation = compareToBaseline(value, baseline);
    const side = unusualSide(deviation, check.thresholds);
    if (side) notes.push(check.describe(deviation.delta, deviation.percent, side));
  }

  if (notes.length > 0) {
    lines.push(...notes);
  } else if (compared > 0) {
    lines.push('No notable deviations from your recent baseline.');
  } else {
    const samples = Math.max(...DEVIATION_CHECKS.map((c) => daily.baselineSamples(c.metric)));
    lines.push(`Personal baselines are still building (${samples} days of history so far).`);
  }
  return lines;
}

export const morningBriefRule: HealthRule<BriefConfig, BriefState> = {
  id: 'morningBrief',
  name: 'Morning brief',
  description: "One concise summary of last night's sleep and recovery metrics each morning.",
  severity: 'info',
  stateSchema,
  initialState: () => ({ lastSentDay: null, lastSkippedDay: null }),
  selectConfig: (rules) => rules.morningBrief,
  needs: ({ now, timeZone, config, state }) => {
    if (!config.enabled) return [];
    const today = localDate(now, timeZone);
    const done = state.lastSentDay === today || state.lastSkippedDay === today;
    return !done && minutesOfDay(now, timeZone) >= parseClock(config.earliest) ? ['daily'] : [];
  },

  evaluate({ now, timeZone, config, state, daily }) {
    if (!config.enabled) return { state, status: 'disabled' };
    const today = localDate(now, timeZone);
    if (state.lastSentDay === today) return { state, status: 'ok', detail: 'sent' };
    if (state.lastSkippedDay === today) return { state, status: 'ok', detail: 'skipped' };

    const minute = minutesOfDay(now, timeZone);
    const earliest = parseClock(config.earliest);
    const latest = parseClock(config.latest);
    if (minute < earliest) return { state, status: 'not_due', detail: 'before_window' };
    if (minute > latest + SKIP_AFTER_DEADLINE_MINUTES) {
      return { state: { ...state, lastSkippedDay: today }, status: 'ok', detail: 'missed_window' };
    }
    if (daily === null) return { state, status: 'not_due', detail: 'daily_not_loaded' };
    if (!daily.syncComplete && minute < latest) {
      return { state, status: 'pending', detail: 'awaiting_data' };
    }

    const lines = composeBrief(daily);
    if (lines.length === 0) {
      return { state: { ...state, lastSkippedDay: today }, status: 'ok', detail: 'no_data' };
    }
    return {
      state: { ...state, lastSentDay: today },
      status: 'ok',
      detail: 'sent',
      notifications: [
        {
          id: `morningBrief:${today}`,
          ruleId: 'morningBrief',
          severity: 'notice',
          title: 'Morning health brief',
          body: lines.join('\n'),
          tags: ['sunny'],
          ttlMinutes: 4 * 60,
        },
      ],
    };
  },
};
