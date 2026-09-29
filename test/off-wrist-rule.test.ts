import { describe, expect, it } from 'vitest';
import { deviceOffWristRule, offWristMessage, type OffWristState } from '../src/rules/off-wrist/rule';
import type { RuleOutcome } from '../src/rules/types';
import { at, config, context, device, minutes, observations } from './helpers';

const rule = deviceOffWristRule;
const cfg = config.rules.deviceOffWrist;

/** Runs the rule over successive checks where the tracker was removed at `removedAt`. */
function simulate(removedAt: number, checkTimes: number[], ruleConfig = cfg) {
  let state = rule.initialState();
  const outcomes: RuleOutcome<OffWristState>[] = [];
  for (const now of checkTimes) {
    const outcome = rule.evaluate(
      context(now, ruleConfig, state, {
        observations: observations({
          heartRateAt: Math.min(now, removedAt) - minutes(1),
          device: device({ lastSyncAt: now - minutes(4) }),
        }),
      }),
    );
    outcomes.push(outcome);
    state = outcome.state;
  }
  return outcomes;
}

const checksFrom = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => start + minutes(10 * i));

describe('deviceOffWrist rule', () => {
  it('notifies once per episode, never repeating while it lasts', () => {
    const outcomes = simulate(at('14:00'), checksFrom(at('14:00'), 12));
    const notifications = outcomes.flatMap((o) => o.notifications ?? []);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      ruleId: 'deviceOffWrist',
      severity: 'warning',
      title: 'Fitbit reminder',
    });
    expect(outcomes.at(-1)!.status).toBe('alerting');
  });

  it('uses a stable, deterministic notification id for the episode', () => {
    const a = simulate(at('14:00'), checksFrom(at('14:00'), 6)).flatMap((o) => o.notifications ?? []);
    const b = simulate(at('14:00'), checksFrom(at('14:00'), 6)).flatMap((o) => o.notifications ?? []);
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('holds an overnight alert until waking hours, then sends it', () => {
    const outcomes = simulate(at('22:00'), checksFrom(at('23:00'), 60));
    const sent = outcomes.findIndex((o) => (o.notifications ?? []).length > 0);
    const deferred = outcomes.filter((o) => o.detail?.endsWith(':deferred'));
    expect(deferred.length).toBeGreaterThan(10);
    // 23:00 + 10 min × index = first check at or after 07:00 the next morning.
    expect(sent).toBe(48);
  });

  it('can notify overnight when configured to', () => {
    const outcomes = simulate(at('22:00'), checksFrom(at('23:00'), 4), {
      ...cfg,
      notifyDuringSleepHours: true,
    });
    expect(outcomes.flatMap((o) => o.notifications ?? [])).toHaveLength(1);
  });

  it('resolves (clears) the notification when readings resume, and records the recovery', () => {
    let state = rule.initialState();
    const removedAt = at('14:00');
    let notificationId = '';
    for (const now of checksFrom(at('14:00'), 6)) {
      const outcome = rule.evaluate(
        context(now, cfg, state, {
          observations: observations({
            heartRateAt: removedAt,
            device: device({ lastSyncAt: now - minutes(3) }),
          }),
        }),
      );
      notificationId ||= outcome.notifications?.[0]?.id ?? '';
      state = outcome.state;
    }
    const recovered = rule.evaluate(
      context(at('15:05'), cfg, state, {
        observations: observations({ heartRateAt: at('15:04'), device: device({ lastSyncAt: at('15:04') }) }),
      }),
    );
    expect(recovered.detail).toBe('RECOVERED');
    expect(recovered.resolved).toEqual([notificationId]);
    expect(recovered.state.episode).toBeNull();
    expect(recovered.state.lastRecovery?.offMinutes).toBeGreaterThan(50);
  });

  it('does not clear on recovery when clearOnRecovery is off', () => {
    let state = rule.initialState();
    const ruleConfig = { ...cfg, clearOnRecovery: false };
    for (const now of checksFrom(at('14:00'), 6)) {
      state = rule.evaluate(
        context(now, ruleConfig, state, {
          observations: observations({
            heartRateAt: at('14:00'),
            device: device({ lastSyncAt: now - minutes(3) }),
          }),
        }),
      ).state;
    }
    const recovered = rule.evaluate(
      context(at('15:05'), ruleConfig, state, {
        observations: observations({ heartRateAt: at('15:04'), device: device({ lastSyncAt: at('15:04') }) }),
      }),
    );
    expect(recovered.resolved).toEqual([]);
  });

  it('applies the cooldown between episodes, then delivers the deferred alert', () => {
    // Episode 1 notifies ~14:40; recovered 14:45; removed again 14:50.
    let state = rule.initialState();
    const run = (now: number, heartRateAt: number) => {
      const outcome = rule.evaluate(
        context(now, cfg, state, {
          observations: observations({ heartRateAt, device: device({ lastSyncAt: now - minutes(2) }) }),
        }),
      );
      state = outcome.state;
      return outcome;
    };
    for (const now of checksFrom(at('14:00'), 5)) run(now, at('14:00'));
    run(at('14:45'), at('14:44'));
    const second: (string | undefined)[] = [];
    for (const now of checksFrom(at('15:25'), 6)) second.push(run(now, at('14:50')).notifications?.[0]?.id);
    const firstSecondEpisodeAlert = second.findIndex((id) => id !== undefined);
    // Cooldown is 60 minutes from ~14:40, so nothing before 15:40.
    expect(firstSecondEpisodeAlert).toBe(2);
  });

  it('reports insufficient data (and keeps state) when heart rate cannot be fetched', () => {
    const state = rule.initialState();
    const outcome = rule.evaluate(
      context(at('14:00'), cfg, state, { observations: observations({ heartRateAt: 'unavailable' }) }),
    );
    expect(outcome.status).toBe('insufficient_data');
    expect(outcome.state).toBe(state);
  });

  it('is inert when disabled', () => {
    const outcome = rule.evaluate(context(at('14:00'), { ...cfg, enabled: false }, rule.initialState()));
    expect(outcome.status).toBe('disabled');
    expect(
      rule.needs({
        now: at('14:00'),
        timeZone: 'UTC',
        schedule: config.schedule,
        config: { ...cfg, enabled: false },
        state: rule.initialState(),
      }),
    ).toEqual([]);
  });
});

describe('off-wrist wording matches the strength of the evidence', () => {
  const now = at('14:40');
  const evidence = (overrides: Partial<ReturnType<typeof device>> = {}) => ({
    kind: 'stale' as const,
    explanation: 'off_wrist' as const,
    heartRateAt: at('14:00'),
    device: device({ lastSyncAt: at('14:36'), ...overrides }),
  });

  it('confirmed: says "may have forgotten", never "is off"', () => {
    const message = offWristMessage('CONFIRMED_OFF_WRIST', evidence(), now, cfg);
    expect(message.body).toBe(
      'No heart-rate data has been recorded for 40 minutes, even though your Fitbit Air synced 4 minutes ago. You may have forgotten to put it back on.',
    );
  });

  it('confirmed with low battery: suggests charging', () => {
    const message = offWristMessage('CONFIRMED_OFF_WRIST', evidence({ batteryLevel: 11 }), now, cfg);
    expect(message.body).toMatch(/battery was at 11%/);
  });

  it('sync stale: states the uncertainty explicitly', () => {
    const message = offWristMessage('SYNC_STALE', evidence({ lastSyncAt: at('13:30') }), now, cfg);
    expect(message.title).toBe('Fitbit not syncing');
    expect(message.body).toMatch(/can't tell whether you're wearing it/);
  });

  it('sync unknown: does not invent a sync time', () => {
    const message = offWristMessage(
      'SYNC_STALE',
      { kind: 'stale', explanation: 'sync_unknown', heartRateAt: at('14:00'), device: null },
      now,
      cfg,
    );
    expect(message.body).toMatch(/can't see when your Fitbit last synced/);
  });

  it('battery: explains rather than blames', () => {
    expect(offWristMessage('BATTERY_EMPTY', evidence({ batteryLevel: 2 }), now, cfg).title).toBe(
      'Fitbit needs charging',
    );
    expect(offWristMessage('BATTERY_LOW', evidence({ batteryLevel: 9 }), now, cfg).body).toMatch(
      /probably run out of charge/,
    );
  });

  it('handles "no heart rate in the lookback window"', () => {
    const message = offWristMessage('CONFIRMED_OFF_WRIST', { ...evidence(), heartRateAt: null }, now, cfg);
    expect(message.body).toMatch(/for over 12 hours/);
  });
});
