import { MINUTE_MS, type DeviceStatus, type EpochMs } from '../../domain/types';
import type { Observation } from '../types';

/**
 * Off-wrist detection as an explicit state machine.
 *
 *   NORMAL ──stale──▶ POSSIBLY_OFF_WRIST ──(N consecutive stale checks)──▶ CONFIRMED_OFF_WRIST
 *                                                                        ├▶ SYNC_STALE
 *                                                                        ├▶ BATTERY_LOW
 *                                                                        └▶ BATTERY_EMPTY
 *   any non-normal state ──fresh heart rate──▶ RECOVERED ──▶ NORMAL
 *
 * The key signal is not "no heart rate for 30 minutes" but *why* there is
 * none. Heart-rate data only reaches Google when the tracker syncs, so a gap
 * measured against `now` cannot tell "off the wrist" from "phone hasn't
 * synced". The gap measured against the tracker's last sync can: if the
 * tracker synced at 08:40 and its newest heart rate is from 08:05, it was
 * demonstrably not recording on-skin for 35 minutes.
 */

export const WEAR_STATES = [
  'NORMAL',
  'POSSIBLY_OFF_WRIST',
  'CONFIRMED_OFF_WRIST',
  'SYNC_STALE',
  'BATTERY_LOW',
  'BATTERY_EMPTY',
  'RECOVERED',
] as const;
export type WearState = (typeof WEAR_STATES)[number];

/** States in which an episode is confirmed and notifiable. */
export const CONFIRMED_STATES: ReadonlySet<WearState> = new Set<WearState>([
  'CONFIRMED_OFF_WRIST',
  'SYNC_STALE',
  'BATTERY_LOW',
  'BATTERY_EMPTY',
]);

export const isEpisodeState = (state: WearState): boolean => state !== 'NORMAL' && state !== 'RECOVERED';

/**
 * Why heart rate is stale:
 * - off_wrist:     tracker synced well after its last heart rate (strong evidence)
 * - awaiting_sync: tracker synced shortly after its last heart rate; not yet conclusive
 * - sync_stale:    tracker hasn't synced recently; wear status is unknowable
 * - sync_unknown:  device sync information unavailable
 * - battery_low / battery_empty: last reported battery explains the silence
 */
export type StaleExplanation =
  'off_wrist' | 'awaiting_sync' | 'sync_stale' | 'sync_unknown' | 'battery_low' | 'battery_empty';

export type WearEvidence =
  | { kind: 'unavailable' }
  | { kind: 'fresh'; heartRateAt: EpochMs }
  | {
      kind: 'stale';
      explanation: StaleExplanation;
      heartRateAt: EpochMs | null;
      device: DeviceStatus | null;
    };

export interface WearThresholds {
  staleAfterMinutes: number;
  syncStaleAfterMinutes: number;
  lowBatteryPercent: number;
  emptyBatteryPercent: number;
}

export function classifyWear(
  now: EpochMs,
  heartRate: Observation<{ latestAt: EpochMs | null }>,
  device: Observation<DeviceStatus | null>,
  thresholds: WearThresholds,
): WearEvidence {
  // An API failure is not evidence of anything: the state must not move.
  if (heartRate.status !== 'ok') return { kind: 'unavailable' };

  const staleAfter = thresholds.staleAfterMinutes * MINUTE_MS;
  const heartRateAt = heartRate.value.latestAt;
  if (heartRateAt !== null && now - heartRateAt < staleAfter) {
    return { kind: 'fresh', heartRateAt };
  }

  const tracker = device.status === 'ok' ? device.value : null;
  const stale = (explanation: StaleExplanation): WearEvidence => ({
    kind: 'stale',
    explanation,
    heartRateAt,
    device: tracker,
  });

  if (tracker === null || tracker.lastSyncAt === null) return stale('sync_unknown');

  const level = tracker.batteryLevel;
  const batteryEmpty =
    tracker.batteryStatus === 'EMPTY' || (level !== null && level <= thresholds.emptyBatteryPercent);
  const batteryLow =
    tracker.batteryStatus === 'LOW' || (level !== null && level <= thresholds.lowBatteryPercent);

  // A flat battery explains missing data better than any wear claim.
  if (batteryEmpty) return stale('battery_empty');

  const syncAge = now - tracker.lastSyncAt;
  if (syncAge >= thresholds.syncStaleAfterMinutes * MINUTE_MS) {
    return stale(batteryLow ? 'battery_low' : 'sync_stale');
  }

  const gapBeforeSync = heartRateAt === null ? Number.POSITIVE_INFINITY : tracker.lastSyncAt - heartRateAt;
  return stale(gapBeforeSync >= staleAfter ? 'off_wrist' : 'awaiting_sync');
}

export interface WearMachine {
  state: WearState;
  /** Consecutive counted checks with stale heart rate. */
  staleChecks: number;
  lastCountedCheckAt: EpochMs | null;
}

export const INITIAL_WEAR_MACHINE: WearMachine = {
  state: 'NORMAL',
  staleChecks: 0,
  lastCountedCheckAt: null,
};

/**
 * Checks closer together than this do not count separately, so a duplicate
 * cron delivery or a manual run cannot fast-forward confirmation.
 */
export const MIN_CHECK_SPACING_MS = 5 * MINUTE_MS;

const TARGET_STATE: Record<Exclude<StaleExplanation, 'awaiting_sync'>, WearState> = {
  off_wrist: 'CONFIRMED_OFF_WRIST',
  sync_stale: 'SYNC_STALE',
  sync_unknown: 'SYNC_STALE',
  battery_low: 'BATTERY_LOW',
  battery_empty: 'BATTERY_EMPTY',
};

/**
 * Pure transition function. Returns the identical `previous` object when
 * nothing changes, so steady state costs no database writes.
 */
export function nextWearState(
  previous: WearMachine,
  evidence: WearEvidence,
  now: EpochMs,
  confirmationChecks: number,
): WearMachine {
  if (evidence.kind === 'unavailable') return previous;

  if (evidence.kind === 'fresh') {
    if (previous.state === 'NORMAL') return previous;
    return {
      state: isEpisodeState(previous.state) ? 'RECOVERED' : 'NORMAL',
      staleChecks: 0,
      lastCountedCheckAt: now,
    };
  }

  // Within an episode, a check counts towards confirmation only if it comes
  // MIN_CHECK_SPACING_MS after the last counted one, so duplicate or manual
  // runs cannot fast-forward confirmation. An uncounted check still applies
  // new evidence once the count is enough: with checks every minute, the sync
  // that proves a removal must not wait five minutes behind an inconclusive
  // check.
  const inEpisode = isEpisodeState(previous.state);
  const counted =
    !inEpisode ||
    previous.lastCountedCheckAt === null ||
    now - previous.lastCountedCheckAt >= MIN_CHECK_SPACING_MS;
  const staleChecks = inEpisode ? previous.staleChecks + (counted ? 1 : 0) : 1;
  let state: WearState;
  if (staleChecks < confirmationChecks) {
    state = 'POSSIBLY_OFF_WRIST';
  } else if (evidence.explanation === 'awaiting_sync') {
    // Not conclusive: keep an already-confirmed episode as-is, otherwise wait.
    state = CONFIRMED_STATES.has(previous.state) ? previous.state : 'POSSIBLY_OFF_WRIST';
  } else {
    state = TARGET_STATE[evidence.explanation];
  }
  if (!counted && state === previous.state) return previous;
  return { state, staleChecks, lastCountedCheckAt: counted ? now : previous.lastCountedCheckAt };
}
