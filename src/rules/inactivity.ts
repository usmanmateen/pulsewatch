import * as z from 'zod';
import { formatDuration } from '../domain/format';
import { MINUTE_MS, type ActivityWindow, type EpochMs } from '../domain/types';
import { cooldownElapsed, currentWakeStart, isWakingHours } from './policy';
import type { HealthRule, NotificationIntent, RulesConfigSlice } from './types';

type InactivityConfig = RulesConfigSlice<'inactivity'>;

/** Width of the activity windows requested from Google. */
export const ACTIVITY_WINDOW_MINUTES = 5;
/** Activity data older than this is too stale to call someone "still". */
export const MAX_ACTIVITY_DATA_AGE_MS = 20 * MINUTE_MS;

const stateSchema = z.object({
  episode: z
    .object({
      streakStart: z.number(),
      notifiedAt: z.number().nullable(),
      notificationId: z.string().nullable(),
    })
    .nullable(),
  lastNotifiedAt: z.number().nullable(),
});
export type InactivityState = z.infer<typeof stateSchema>;

export interface SedentaryStreak {
  start: EpochMs;
  /** End of the newest window with heart rate: the edge of what we know. */
  end: EpochMs;
  minutes: number;
}

/**
 * Walks back from the newest worn window until a movement break (a window
 * with at least `breakSteps` steps) or a window without heart rate (not
 * worn, so stillness is unknown). Returns null without recent worn data.
 */
export function sedentaryStreak(
  windows: readonly ActivityWindow[],
  now: EpochMs,
  breakSteps: number,
  notBefore: EpochMs,
): SedentaryStreak | null {
  let newest = -1;
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i]!.heartRateObserved) {
      newest = i;
      break;
    }
  }
  if (newest < 0) return null;
  const end = windows[newest]!.end;
  if (now - end > MAX_ACTIVITY_DATA_AGE_MS) return null;

  let start = end;
  for (let i = newest; i >= 0; i--) {
    const window = windows[i]!;
    if (!window.heartRateObserved || window.steps >= breakSteps) break;
    start = window.start;
  }
  start = Math.max(start, notBefore);
  return { start, end, minutes: Math.max(0, (end - start) / MINUTE_MS) };
}

export const inactivityRule: HealthRule<InactivityConfig, InactivityState> = {
  id: 'inactivity',
  name: 'Extended inactivity',
  description: 'Suggests a movement break after a long still period during waking hours.',
  severity: 'notice',
  stateSchema,
  initialState: () => ({ episode: null, lastNotifiedAt: null }),
  selectConfig: (rules) => rules.inactivity,
  needs: ({ now, timeZone, schedule, config }) =>
    config.enabled && isWakingHours(now, timeZone, schedule) ? ['activity'] : [],

  evaluate({ now, timeZone, schedule, config, state, observations }) {
    if (!config.enabled) return { state, status: 'disabled' };
    if (!isWakingHours(now, timeZone, schedule)) return { state, status: 'not_due', detail: 'sleep_hours' };
    if (observations.activity.status !== 'ok') {
      return { state, status: 'insufficient_data', detail: 'activity_unavailable' };
    }

    const streak = sedentaryStreak(
      observations.activity.value,
      now,
      config.breakSteps,
      currentWakeStart(now, timeZone, schedule),
    );
    if (streak === null) return { state, status: 'insufficient_data', detail: 'no_recent_wear_data' };

    const previous = state.episode;
    const sameEpisode = previous !== null && previous.streakStart === streak.start;
    const resolved =
      previous && !sameEpisode && previous.notificationId && config.clearOnMovement
        ? [previous.notificationId]
        : [];

    if (streak.minutes < config.thresholdMinutes) {
      return { state: { ...state, episode: null }, status: 'ok', detail: 'moving', resolved };
    }

    const episode = sameEpisode
      ? previous
      : { streakStart: streak.start, notifiedAt: null, notificationId: null };
    if (episode.notifiedAt !== null) {
      return { state: { ...state, episode }, status: 'alerting', detail: 'notified', resolved };
    }
    if (!cooldownElapsed(state.lastNotifiedAt, now, config.cooldownMinutes)) {
      return { state: { ...state, episode }, status: 'alerting', detail: 'cooldown', resolved };
    }

    const id = `inactivity:${streak.start}`;
    const notification: NotificationIntent = {
      id,
      ruleId: 'inactivity',
      severity: 'notice',
      title: 'Time to move?',
      body:
        `You've been mostly still for ${formatDuration(streak.minutes)}, with no 5-minute stretch ` +
        `of ${config.breakSteps}+ steps. A short walk could be a good break.`,
      tags: ['walking'],
      ttlMinutes: 60,
    };
    return {
      state: { episode: { ...episode, notifiedAt: now, notificationId: id }, lastNotifiedAt: now },
      status: 'alerting',
      detail: 'notified',
      notifications: [notification],
      resolved,
    };
  },
};
