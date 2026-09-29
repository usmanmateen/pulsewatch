import * as z from 'zod';
import {
  computeBaseline,
  detectSustainedDeviation,
  type DeviationThresholds,
  type Transform,
} from '../baseline/baseline';
import { formatNumber, formatSigned } from '../domain/format';
import { addDays, daysBetween, localDate } from '../domain/time';
import type { DailyMetric } from '../domain/types';
import { isWakingHours } from './policy';
import type { HealthRule, NotificationIntent, RulesConfigSlice } from './types';

/**
 * Sustained personal-baseline deviation for one daily metric. The same
 * factory backs resting heart rate and HRV; adding a respiratory-rate or
 * SpO₂ trend is another call with different thresholds.
 */

type TrendRuleId = 'restingHeartRate' | 'hrv';

const stateSchema = z.object({
  lastEvaluatedDay: z.string().nullable(),
  episode: z
    .object({
      startedOn: z.string(),
      side: z.enum(['above', 'below']),
      notificationId: z.string().nullable(),
    })
    .nullable(),
  lastNotifiedOn: z.string().nullable(),
});
export type TrendState = z.infer<typeof stateSchema>;

interface TrendSpec<Id extends TrendRuleId> {
  id: Id;
  name: string;
  description: string;
  metric: DailyMetric;
  transform: Transform;
  /** Spread floor in transformed units (bpm for RHR, log-units for HRV). */
  minimumSpread: number;
  thresholds(config: RulesConfigSlice<Id>): DeviationThresholds;
  message(input: {
    side: 'above' | 'below';
    days: number;
    latest: number;
    median: number;
    percent: number | null;
    baselineDays: number;
  }): Pick<NotificationIntent, 'title' | 'body' | 'tags'>;
}

const DISCLAIMER = 'This compares against your own recent history and is not a medical assessment.';

function createTrendRule<Id extends TrendRuleId>(
  spec: TrendSpec<Id>,
): HealthRule<RulesConfigSlice<Id>, TrendState> {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    severity: 'notice',
    stateSchema,
    initialState: () => ({ lastEvaluatedDay: null, episode: null, lastNotifiedOn: null }),
    selectConfig: (rules) => rules[spec.id],
    needs: ({ now, timeZone, schedule, config, state }) =>
      config.enabled &&
      state.lastEvaluatedDay !== localDate(now, timeZone) &&
      isWakingHours(now, timeZone, schedule)
        ? ['daily']
        : [],

    evaluate({ now, timeZone, schedule, config, state, daily }) {
      if (!config.enabled) return { state, status: 'disabled' };
      if (!isWakingHours(now, timeZone, schedule)) return { state, status: 'not_due', detail: 'sleep_hours' };
      if (daily === null) return { state, status: state.episode ? 'alerting' : 'not_due' };

      const series = daily.series(spec.metric);
      const latestDay = series.at(-1)?.day;
      // Only act on current data; an old value says nothing about now.
      if (latestDay === undefined || daysBetween(latestDay, daily.today) > 1) {
        return { state, status: 'insufficient_data', detail: 'no_recent_data' };
      }
      const activeStatus = state.episode ? 'alerting' : 'ok';
      if (state.lastEvaluatedDay === latestDay) return { state, status: activeStatus, detail: 'evaluated' };

      const evaluated: TrendState = { ...state, lastEvaluatedDay: latestDay };
      const baseline = computeBaseline(series, {
        before: addDays(latestDay, 1 - config.consecutiveDays),
        windowDays: config.baselineDays,
        minimumSamples: config.minimumSamples,
        transform: spec.transform,
        minimumSpread: spec.minimumSpread,
      });
      if (!baseline.ok) {
        return {
          state: evaluated,
          status: 'insufficient_data',
          detail: `baseline_building:${baseline.samples}/${baseline.required}`,
        };
      }

      const result = detectSustainedDeviation(
        series,
        baseline.baseline,
        latestDay,
        config.consecutiveDays,
        spec.thresholds(config),
      );

      if (!result.sustained || result.side === null) {
        // The run is broken: the episode (if any) has ended.
        return { state: { ...evaluated, episode: null }, status: 'ok', detail: result.reason };
      }
      if (state.episode && state.episode.side === result.side) {
        return { state: evaluated, status: 'alerting', detail: `sustained_${result.side}` };
      }

      const startedOn = result.days[0]!.day;
      const inCooldown =
        state.lastNotifiedOn !== null && daysBetween(state.lastNotifiedOn, latestDay) < config.cooldownDays;
      if (inCooldown) {
        return {
          state: { ...evaluated, episode: { startedOn, side: result.side, notificationId: null } },
          status: 'alerting',
          detail: 'cooldown',
        };
      }

      const latest = result.days.at(-1)!.deviation!;
      const id = `${spec.id}:${startedOn}`;
      return {
        state: {
          ...evaluated,
          episode: { startedOn, side: result.side, notificationId: id },
          lastNotifiedOn: latestDay,
        },
        status: 'alerting',
        detail: `sustained_${result.side}`,
        notifications: [
          {
            id,
            ruleId: spec.id,
            severity: 'notice',
            ttlMinutes: 24 * 60,
            ...spec.message({
              side: result.side,
              days: config.consecutiveDays,
              latest: latest.value,
              median: baseline.baseline.median,
              percent: latest.percent,
              baselineDays: config.baselineDays,
            }),
          },
        ],
      };
    },
  };
}

export const restingHeartRateRule = createTrendRule({
  id: 'restingHeartRate',
  name: 'Resting heart rate trend',
  description: 'Flags a resting heart rate outside your usual range for several consecutive days.',
  metric: 'resting_hr',
  transform: 'none',
  minimumSpread: 1,
  thresholds: (config) => ({
    direction: config.direction,
    zThreshold: config.zThreshold,
    minimumDelta: config.minimumDeltaBpm,
  }),
  message: ({ side, days, latest, median, baselineDays }) => ({
    title: `Resting heart rate ${side} your usual range`,
    body:
      `Your resting heart rate has been ${side} your usual range for ${days} days ` +
      `(latest ${formatNumber(latest)} bpm vs a ${baselineDays}-day median of ${formatNumber(median)} bpm). ` +
      DISCLAIMER,
    tags: ['heart'],
  }),
});

export const hrvRule = createTrendRule({
  id: 'hrv',
  name: 'HRV trend',
  description: 'Flags overnight HRV outside your usual range for several consecutive days.',
  metric: 'hrv',
  transform: 'log',
  // ≈5%: day-to-day HRV noise is multiplicative.
  minimumSpread: 0.05,
  thresholds: (config) => ({
    direction: config.direction,
    zThreshold: config.zThreshold,
    minimumPercent: config.minimumPercentChange,
  }),
  message: ({ side, days, latest, median, percent, baselineDays }) => ({
    title: `HRV ${side} your usual range`,
    body:
      `Your overnight HRV has been ${side} your usual range for ${days} days ` +
      `(latest ${formatNumber(latest)} ms vs a ${baselineDays}-day median of ${formatNumber(median)} ms` +
      `${percent === null ? '' : `, ${formatSigned(percent)}%`}). ${DISCLAIMER}`,
    tags: [side === 'below' ? 'chart_with_downwards_trend' : 'chart_with_upwards_trend'],
  }),
});
