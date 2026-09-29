import { describe, expect, it } from 'vitest';
import {
  INITIAL_WEAR_MACHINE,
  WEAR_STATES,
  classifyWear,
  nextWearState,
  type WearEvidence,
  type WearMachine,
  type WearState,
} from '../src/rules/off-wrist/machine';
import { device, minutes, observations } from './helpers';

const NOW = Date.UTC(2026, 2, 10, 14, 0);
const thresholds = {
  staleAfterMinutes: 30,
  syncStaleAfterMinutes: 60,
  lowBatteryPercent: 15,
  emptyBatteryPercent: 5,
};

const classify = (input: Parameters<typeof observations>[0]) => {
  const obs = observations(input);
  return classifyWear(NOW, obs.heartRate, obs.device, thresholds);
};

describe('classifyWear', () => {
  it('treats recent heart rate as worn', () => {
    expect(classify({ heartRateAt: NOW - minutes(5) })).toEqual({
      kind: 'fresh',
      heartRateAt: NOW - minutes(5),
    });
  });

  it('never infers anything from a failed heart-rate fetch', () => {
    expect(classify({ heartRateAt: 'unavailable' })).toEqual({ kind: 'unavailable' });
  });

  it('is conclusive when the tracker synced long after its last heart rate', () => {
    const evidence = classify({
      heartRateAt: NOW - minutes(40),
      device: device({ lastSyncAt: NOW - minutes(5) }),
    });
    expect(evidence).toMatchObject({ kind: 'stale', explanation: 'off_wrist' });
  });

  it('waits when the last sync came right after the last heart rate (sync lag, not removal)', () => {
    const evidence = classify({
      heartRateAt: NOW - minutes(35),
      device: device({ lastSyncAt: NOW - minutes(34) }),
    });
    expect(evidence).toMatchObject({ kind: 'stale', explanation: 'awaiting_sync' });
  });

  it('reports sync_stale when the tracker has not synced recently', () => {
    const evidence = classify({
      heartRateAt: NOW - minutes(70),
      device: device({ lastSyncAt: NOW - minutes(65) }),
    });
    expect(evidence).toMatchObject({ kind: 'stale', explanation: 'sync_stale' });
  });

  it('falls back to sync_unknown without device information', () => {
    expect(classify({ heartRateAt: NOW - minutes(40), device: 'unavailable' })).toMatchObject({
      explanation: 'sync_unknown',
    });
    expect(classify({ heartRateAt: NOW - minutes(40), device: null })).toMatchObject({
      explanation: 'sync_unknown',
    });
  });

  it('prefers a battery explanation once sync is stale and the last level was low', () => {
    const evidence = classify({
      heartRateAt: NOW - minutes(70),
      device: device({ lastSyncAt: NOW - minutes(65), batteryLevel: 9, batteryStatus: 'LOW' }),
    });
    expect(evidence).toMatchObject({ explanation: 'battery_low' });
  });

  it('does not blame a low battery while the tracker is still syncing', () => {
    const evidence = classify({
      heartRateAt: NOW - minutes(45),
      device: device({ lastSyncAt: NOW - minutes(3), batteryLevel: 12, batteryStatus: 'LOW' }),
    });
    expect(evidence).toMatchObject({ explanation: 'off_wrist' });
  });

  it('treats an empty battery as the explanation regardless of sync age', () => {
    for (const lastSyncAt of [NOW - minutes(3), NOW - minutes(90)]) {
      const byStatus = classify({
        heartRateAt: NOW - minutes(45),
        device: device({ lastSyncAt, batteryLevel: 8, batteryStatus: 'EMPTY' }),
      });
      const byLevel = classify({
        heartRateAt: NOW - minutes(45),
        device: device({ lastSyncAt, batteryLevel: 4, batteryStatus: null }),
      });
      expect(byStatus).toMatchObject({ explanation: 'battery_empty' });
      expect(byLevel).toMatchObject({ explanation: 'battery_empty' });
    }
  });

  it('treats "no heart rate within the lookback" as stale with an unbounded gap', () => {
    const evidence = classify({ heartRateAt: null, device: device({ lastSyncAt: NOW - minutes(2) }) });
    expect(evidence).toMatchObject({ kind: 'stale', explanation: 'off_wrist', heartRateAt: null });
  });
});

const stale = (explanation: Extract<WearEvidence, { kind: 'stale' }>['explanation']): WearEvidence => ({
  kind: 'stale',
  explanation,
  heartRateAt: NOW - minutes(40),
  device: null,
});
const fresh: WearEvidence = { kind: 'fresh', heartRateAt: NOW - minutes(1) };
const machine = (
  state: WearState,
  staleChecks = 0,
  lastCountedCheckAt: number | null = null,
): WearMachine => ({
  state,
  staleChecks,
  lastCountedCheckAt,
});

describe('nextWearState', () => {
  it('needs the configured number of consecutive stale checks before confirming', () => {
    let m = INITIAL_WEAR_MACHINE;
    m = nextWearState(m, stale('off_wrist'), NOW, 2);
    expect(m.state).toBe('POSSIBLY_OFF_WRIST');
    m = nextWearState(m, stale('off_wrist'), NOW + minutes(10), 2);
    expect(m.state).toBe('CONFIRMED_OFF_WRIST');

    let three = INITIAL_WEAR_MACHINE;
    for (let i = 0; i < 2; i++) three = nextWearState(three, stale('off_wrist'), NOW + minutes(10 * i), 3);
    expect(three.state).toBe('POSSIBLY_OFF_WRIST');
    three = nextWearState(three, stale('off_wrist'), NOW + minutes(20), 3);
    expect(three.state).toBe('CONFIRMED_OFF_WRIST');

    expect(nextWearState(INITIAL_WEAR_MACHINE, stale('off_wrist'), NOW, 1).state).toBe('CONFIRMED_OFF_WRIST');
  });

  it('never confirms on inconclusive evidence alone, but confirms once evidence arrives', () => {
    let m = INITIAL_WEAR_MACHINE;
    for (let i = 0; i < 4; i++) m = nextWearState(m, stale('awaiting_sync'), NOW + minutes(10 * i), 2);
    expect(m).toMatchObject({ state: 'POSSIBLY_OFF_WRIST', staleChecks: 4 });
    m = nextWearState(m, stale('off_wrist'), NOW + minutes(40), 2);
    expect(m.state).toBe('CONFIRMED_OFF_WRIST');
  });

  it('maps each confirmed explanation to its state', () => {
    const confirmed = (explanation: Parameters<typeof stale>[0]) =>
      nextWearState(machine('POSSIBLY_OFF_WRIST', 1, NOW - minutes(10)), stale(explanation), NOW, 2).state;
    expect(confirmed('off_wrist')).toBe('CONFIRMED_OFF_WRIST');
    expect(confirmed('sync_stale')).toBe('SYNC_STALE');
    expect(confirmed('sync_unknown')).toBe('SYNC_STALE');
    expect(confirmed('battery_low')).toBe('BATTERY_LOW');
    expect(confirmed('battery_empty')).toBe('BATTERY_EMPTY');
  });

  it('recovers through RECOVERED to NORMAL', () => {
    const recovered = nextWearState(machine('CONFIRMED_OFF_WRIST', 3, NOW - minutes(10)), fresh, NOW, 2);
    expect(recovered).toEqual({ state: 'RECOVERED', staleChecks: 0, lastCountedCheckAt: NOW });
    expect(nextWearState(recovered, fresh, NOW + minutes(10), 2).state).toBe('NORMAL');
  });

  it('returns the identical object in steady state (no database write)', () => {
    const normal = machine('NORMAL');
    expect(nextWearState(normal, fresh, NOW, 2)).toBe(normal);
  });

  it('freezes on unavailable data: an outage neither starts nor ends an episode', () => {
    const confirmed = machine('CONFIRMED_OFF_WRIST', 2, NOW - minutes(10));
    expect(nextWearState(confirmed, { kind: 'unavailable' }, NOW, 2)).toBe(confirmed);
    const normal = machine('NORMAL');
    expect(nextWearState(normal, { kind: 'unavailable' }, NOW, 2)).toBe(normal);
  });

  it('ignores stale checks less than five minutes apart (duplicate or manual runs)', () => {
    const first = nextWearState(INITIAL_WEAR_MACHINE, stale('off_wrist'), NOW, 2);
    expect(nextWearState(first, stale('off_wrist'), NOW + minutes(2), 2)).toBe(first);
    expect(nextWearState(first, stale('off_wrist'), NOW + minutes(5), 2).state).toBe('CONFIRMED_OFF_WRIST');
  });

  it('confirms as soon as proof arrives, even a minute after an inconclusive check', () => {
    // Checks every minute, one confirmation: the sync that proves the removal
    // lands two minutes after the check that found heart rate merely late.
    const waiting = nextWearState(INITIAL_WEAR_MACHINE, stale('awaiting_sync'), NOW, 1);
    expect(waiting.state).toBe('POSSIBLY_OFF_WRIST');
    const proven = nextWearState(waiting, stale('off_wrist'), NOW + minutes(2), 1);
    expect(proven).toEqual({ state: 'CONFIRMED_OFF_WRIST', staleChecks: 1, lastCountedCheckAt: NOW });
    // Still no fast-forwarding when more than one check is required.
    const two = nextWearState(INITIAL_WEAR_MACHINE, stale('awaiting_sync'), NOW, 2);
    expect(nextWearState(two, stale('off_wrist'), NOW + minutes(2), 2)).toBe(two);
  });

  it('keeps one episode while the explanation changes between confirmed states', () => {
    let m = machine('CONFIRMED_OFF_WRIST', 2, NOW - minutes(10));
    m = nextWearState(m, stale('sync_stale'), NOW, 2);
    expect(m).toMatchObject({ state: 'SYNC_STALE', staleChecks: 3 });
    m = nextWearState(m, stale('awaiting_sync'), NOW + minutes(10), 2);
    expect(m.state).toBe('SYNC_STALE');
  });

  it('transition table: every state handles every kind of evidence', () => {
    const table: Record<WearState, Record<'fresh' | 'stale' | 'unavailable', WearState>> = {
      NORMAL: { fresh: 'NORMAL', stale: 'POSSIBLY_OFF_WRIST', unavailable: 'NORMAL' },
      POSSIBLY_OFF_WRIST: {
        fresh: 'RECOVERED',
        stale: 'CONFIRMED_OFF_WRIST',
        unavailable: 'POSSIBLY_OFF_WRIST',
      },
      CONFIRMED_OFF_WRIST: {
        fresh: 'RECOVERED',
        stale: 'CONFIRMED_OFF_WRIST',
        unavailable: 'CONFIRMED_OFF_WRIST',
      },
      SYNC_STALE: { fresh: 'RECOVERED', stale: 'CONFIRMED_OFF_WRIST', unavailable: 'SYNC_STALE' },
      BATTERY_LOW: { fresh: 'RECOVERED', stale: 'CONFIRMED_OFF_WRIST', unavailable: 'BATTERY_LOW' },
      BATTERY_EMPTY: { fresh: 'RECOVERED', stale: 'CONFIRMED_OFF_WRIST', unavailable: 'BATTERY_EMPTY' },
      RECOVERED: { fresh: 'NORMAL', stale: 'POSSIBLY_OFF_WRIST', unavailable: 'RECOVERED' },
    };
    for (const state of WEAR_STATES) {
      const previous = machine(state, state === 'NORMAL' || state === 'RECOVERED' ? 0 : 1, NOW - minutes(10));
      expect(nextWearState(previous, fresh, NOW, 2).state, `${state} + fresh`).toBe(table[state].fresh);
      expect(nextWearState(previous, stale('off_wrist'), NOW, 2).state, `${state} + stale`).toBe(
        table[state].stale,
      );
      expect(nextWearState(previous, { kind: 'unavailable' }, NOW, 2).state, `${state} + unavailable`).toBe(
        table[state].unavailable,
      );
    }
  });
});
