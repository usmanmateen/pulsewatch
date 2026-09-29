import * as z from 'zod';
import { formatClockMinutes, formatDuration } from '../domain/format';
import { localDate } from '../domain/time';
import { isWakingHours } from './policy';
import type { DailyView, HealthRule, RulesConfigSlice } from './types';

type SleepConfig = RulesConfigSlice<'sleep'>;

const stateSchema = z.object({
  /** Wake-up date of the last main sleep evaluated. */
  lastEvaluatedDay: z.string().nullable(),
  lastNotifiedDay: z.string().nullable(),
});
export type SleepState = z.infer<typeof stateSchema>;

/** "23:48 → 06:10", when both times are known. */
export function sleepTiming(daily: DailyView, day: string): string | null {
  const bedtime = daily.value('bedtime', day);
  const waketime = daily.value('waketime', day);
  if (bedtime === null || waketime === null) return null;
  return `${formatClockMinutes(bedtime)} → ${formatClockMinutes(waketime)}`;
}

export const sleepRule: HealthRule<SleepConfig, SleepState> = {
  id: 'sleep',
  name: 'Short sleep',
  description: "Flags when last night's recorded main sleep was below your target.",
  severity: 'notice',
  stateSchema,
  initialState: () => ({ lastEvaluatedDay: null, lastNotifiedDay: null }),
  selectConfig: (rules) => rules.sleep,
  // Evaluated during waking hours only, so a short-sleep alert never wakes anyone.
  needs: ({ now, timeZone, schedule, config, state }) =>
    config.enabled &&
    state.lastEvaluatedDay !== localDate(now, timeZone) &&
    isWakingHours(now, timeZone, schedule)
      ? ['daily']
      : [],

  evaluate({ now, timeZone, schedule, config, state, daily }) {
    if (!config.enabled) return { state, status: 'disabled' };
    if (!isWakingHours(now, timeZone, schedule)) return { state, status: 'not_due', detail: 'sleep_hours' };
    if (daily === null) {
      return { state, status: state.lastNotifiedDay === localDate(now, timeZone) ? 'alerting' : 'not_due' };
    }

    const today = daily.today;
    if (state.lastEvaluatedDay === today) {
      return { state, status: state.lastNotifiedDay === today ? 'alerting' : 'ok', detail: 'evaluated' };
    }
    const minutesAsleep = daily.value('sleep_minutes', today);
    if (minutesAsleep === null) return { state, status: 'insufficient_data', detail: 'awaiting_sleep' };

    const targetMinutes = Math.round(config.minimumHours * 60);
    const evaluated: SleepState = { ...state, lastEvaluatedDay: today };
    if (minutesAsleep >= targetMinutes) return { state: evaluated, status: 'ok', detail: 'met_target' };

    const timing = sleepTiming(daily, today);
    const median = daily.baseline('sleep_minutes')?.median;
    const body =
      `Last night's recorded sleep was ${formatDuration(minutesAsleep)}` +
      `${timing ? ` (${timing})` : ''}, below your ${formatDuration(targetMinutes)} target.` +
      (median !== undefined ? ` Your recent median is ${formatDuration(median)}.` : '');
    return {
      state: { ...evaluated, lastNotifiedDay: today },
      status: 'alerting',
      detail: 'below_target',
      notifications: [
        {
          id: `sleep:${today}`,
          ruleId: 'sleep',
          severity: 'notice',
          title: 'Short sleep',
          body,
          tags: ['sleeping'],
          ttlMinutes: 12 * 60,
        },
      ],
    };
  },
};
