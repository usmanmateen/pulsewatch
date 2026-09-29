import * as z from 'zod';
import { formatElapsedProse } from '../../domain/format';
import { MINUTE_MS, type EpochMs } from '../../domain/types';
import { cooldownElapsed, isWakingHours } from '../policy';
import type { HealthRule, NotificationIntent, RuleOutcome, RulesConfigSlice } from '../types';
import {
  CONFIRMED_STATES,
  INITIAL_WEAR_MACHINE,
  WEAR_STATES,
  classifyWear,
  isEpisodeState,
  nextWearState,
  type WearEvidence,
  type WearState,
} from './machine';

type OffWristConfig = RulesConfigSlice<'deviceOffWrist'>;

/** Heart rate is looked up this far back; older data counts as "none". */
export const HEART_RATE_LOOKBACK_HOURS = 12;

const stateSchema = z.object({
  machine: z.object({
    state: z.enum(WEAR_STATES),
    staleChecks: z.number().int().min(0),
    lastCountedCheckAt: z.number().nullable(),
  }),
  episode: z
    .object({
      id: z.string(),
      startedAt: z.number(),
      /** Newest heart rate before the episode: when the tracker most likely came off. */
      lastHeartRateAt: z.number().nullable(),
      notifiedAt: z.number().nullable(),
      notificationId: z.string().nullable(),
    })
    .nullable(),
  lastNotifiedAt: z.number().nullable(),
  lastRecovery: z.object({ at: z.number(), offMinutes: z.number() }).nullable(),
});
export type OffWristState = z.infer<typeof stateSchema>;

const initialState = (): OffWristState => ({
  machine: { ...INITIAL_WEAR_MACHINE },
  episode: null,
  lastNotifiedAt: null,
  lastRecovery: null,
});

function staleness(evidence: Extract<WearEvidence, { kind: 'stale' }>, now: EpochMs): string {
  if (evidence.heartRateAt === null) return `over ${HEART_RATE_LOOKBACK_HOURS} hours`;
  return formatElapsedProse((now - evidence.heartRateAt) / MINUTE_MS);
}

/** Wording is deliberately hedged in proportion to the evidence. */
export function offWristMessage(
  state: WearState,
  evidence: Extract<WearEvidence, { kind: 'stale' }>,
  now: EpochMs,
  config: OffWristConfig,
): Pick<NotificationIntent, 'title' | 'body' | 'tags' | 'severity'> {
  const device = evidence.device?.model ?? 'Fitbit';
  const noHeartRate = staleness(evidence, now);
  const syncAgo =
    evidence.device?.lastSyncAt != null
      ? formatElapsedProse((now - evidence.device.lastSyncAt) / MINUTE_MS)
      : null;
  const battery = evidence.device?.batteryLevel;

  switch (state) {
    case 'CONFIRMED_OFF_WRIST': {
      const lowBattery =
        battery != null && battery <= config.lowBatteryPercent
          ? ` Its battery was at ${battery}%, so it's a good time to charge it.`
          : '';
      return {
        title: 'Fitbit reminder',
        body:
          `No heart-rate data has been recorded for ${noHeartRate}, even though your ${device} ` +
          `synced ${syncAgo} ago. You may have forgotten to put it back on.${lowBattery}`,
        tags: ['watch'],
        severity: 'warning',
      };
    }
    case 'BATTERY_EMPTY':
      return {
        title: 'Fitbit needs charging',
        body:
          `Your ${device} reported an empty battery when it last synced, and no heart-rate data ` +
          `has arrived for ${noHeartRate}. It probably needs charging.`,
        tags: ['battery'],
        severity: 'notice',
      };
    case 'BATTERY_LOW':
      return {
        title: 'Fitbit battery may be flat',
        body:
          `No heart-rate data for ${noHeartRate} and no sync for ${syncAgo}. Your ${device} ` +
          `reported ${battery ?? 'low'}${battery != null ? '%' : ''} battery at its last sync, ` +
          `so it has probably run out of charge.`,
        tags: ['battery'],
        severity: 'notice',
      };
    default:
      // SYNC_STALE: we genuinely cannot tell whether it is being worn.
      return {
        title: 'Fitbit not syncing',
        body:
          syncAgo === null
            ? `No heart-rate data has reached Google Health for ${noHeartRate}, and PulseWatch can't ` +
              `see when your ${device} last synced. It may be off your wrist or just not syncing.`
            : `No heart-rate data for ${noHeartRate}, and your ${device} last synced ${syncAgo} ` +
              `ago, so PulseWatch can't tell whether you're wearing it. Check it's on your wrist ` +
              `and near your phone.`,
        tags: ['watch', 'grey_question'],
        severity: 'notice',
      };
  }
}

function statusFor(state: WearState): RuleOutcome<OffWristState>['status'] {
  if (state === 'POSSIBLY_OFF_WRIST') return 'pending';
  return CONFIRMED_STATES.has(state) ? 'alerting' : 'ok';
}

export const deviceOffWristRule: HealthRule<OffWristConfig, OffWristState> = {
  id: 'deviceOffWrist',
  name: 'Off-wrist / missing data',
  description:
    'Detects when the tracker has stopped recording heart rate, and explains whether it looks ' +
    'removed, out of sync, or out of battery.',
  severity: 'warning',
  stateSchema,
  initialState,
  selectConfig: (rules) => rules.deviceOffWrist,
  needs: ({ config }) => (config.enabled ? ['heartRate', 'device'] : []),

  evaluate({ now, timeZone, schedule, config, state, observations }) {
    if (!config.enabled) return { state, status: 'disabled' };

    const evidence = classifyWear(now, observations.heartRate, observations.device, config);
    if (evidence.kind === 'unavailable') {
      return { state, status: 'insufficient_data', detail: 'heart_rate_unavailable' };
    }

    const machine = nextWearState(state.machine, evidence, now, config.confirmationChecks);
    if (machine === state.machine) {
      return { state, status: statusFor(machine.state), detail: machine.state };
    }

    const next: OffWristState = { ...state, machine };
    const resolved: string[] = [];
    const notifications: NotificationIntent[] = [];

    if (machine.state === 'RECOVERED') {
      const episode = state.episode;
      if (episode) {
        const offSince = episode.lastHeartRateAt ?? episode.startedAt;
        next.lastRecovery = { at: now, offMinutes: Math.round((now - offSince) / MINUTE_MS) };
        if (episode.notificationId && config.clearOnRecovery) resolved.push(episode.notificationId);
      }
      next.episode = null;
    } else if (isEpisodeState(machine.state) && next.episode === null) {
      // First stale check of a new episode. The id is stable for its lifetime.
      next.episode = {
        id: `ep-${now}`,
        startedAt: now,
        lastHeartRateAt: evidence.kind === 'stale' ? evidence.heartRateAt : null,
        notifiedAt: null,
        notificationId: null,
      };
    }

    const episode = next.episode;
    if (
      evidence.kind === 'stale' &&
      episode &&
      episode.notifiedAt === null &&
      CONFIRMED_STATES.has(machine.state)
    ) {
      const allowedNow =
        (config.notifyDuringSleepHours || isWakingHours(now, timeZone, schedule)) &&
        cooldownElapsed(state.lastNotifiedAt, now, config.cooldownMinutes);
      if (allowedNow) {
        const id = `deviceOffWrist:${episode.id}`;
        notifications.push({
          id,
          ruleId: 'deviceOffWrist',
          ttlMinutes: 180,
          ...offWristMessage(machine.state, evidence, now, config),
        });
        next.episode = { ...episode, notifiedAt: now, notificationId: id };
        next.lastNotifiedAt = now;
      }
    }

    const deferred = CONFIRMED_STATES.has(machine.state) && next.episode?.notifiedAt === null;
    return {
      state: next,
      status: statusFor(machine.state),
      detail: deferred ? `${machine.state}:deferred` : machine.state,
      notifications,
      resolved,
    };
  },
};
