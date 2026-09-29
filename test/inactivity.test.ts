import { describe, expect, it } from 'vitest';
import type { ActivityWindow } from '../src/domain/types';
import { inactivityRule, sedentaryStreak, type InactivityState } from '../src/rules/inactivity';
import type { Observations } from '../src/rules/types';
import { at, config, context, minutes } from './helpers';

const cfg = config.rules.inactivity;

/** Five-minute windows from `start`, each described by [steps, worn]. */
function windows(start: number, spec: Array<[number, boolean]>): ActivityWindow[] {
  return spec.map(([steps, worn], i) => ({
    start: start + minutes(5 * i),
    end: start + minutes(5 * (i + 1)),
    steps,
    heartRateObserved: worn,
  }));
}
const still = (n: number): Array<[number, boolean]> => Array.from({ length: n }, () => [8, true]);

const withActivity = (value: ActivityWindow[]): Observations => ({
  heartRate: { status: 'not_requested' },
  device: { status: 'not_requested' },
  activity: { status: 'ok', value },
});

describe('sedentaryStreak', () => {
  it('measures stillness back to the last movement break', () => {
    const w = windows(at('12:00'), [[140, true], ...still(20)]);
    const streak = sedentaryStreak(w, at('13:45'), 100, at('07:00'));
    expect(streak).toEqual({ start: at('12:05'), end: at('13:45'), minutes: 100 });
  });

  it('fidgeting below the break threshold does not reset it', () => {
    const w = windows(at('12:00'), [[140, true], ...still(8), [60, true], ...still(11)]);
    expect(sedentaryStreak(w, at('13:45'), 100, at('07:00'))?.minutes).toBe(100);
  });

  it('a window without heart rate (not worn) ends the streak: unknown is not "still"', () => {
    const w = windows(at('12:00'), [...still(10), [0, false], ...still(9)]);
    expect(sedentaryStreak(w, at('13:40'), 100, at('07:00'))?.minutes).toBe(45);
  });

  it('never counts stillness from before the waking window', () => {
    const w = windows(at('06:00'), still(30));
    expect(sedentaryStreak(w, at('08:30'), 100, at('07:00'))).toEqual({
      start: at('07:00'),
      end: at('08:30'),
      minutes: 90,
    });
  });

  it('returns null without recent worn data (sync lag or off-wrist)', () => {
    const w = windows(at('12:00'), [
      ...still(10),
      ...Array.from({ length: 10 }, (): [number, boolean] => [0, false]),
    ]);
    expect(sedentaryStreak(w, at('13:40'), 100, at('07:00'))).toBeNull();
    expect(sedentaryStreak([], at('13:40'), 100, at('07:00'))).toBeNull();
  });
});

describe('inactivity rule', () => {
  const evaluate = (
    now: number,
    w: ActivityWindow[],
    state: InactivityState = inactivityRule.initialState(),
  ) => inactivityRule.evaluate(context(now, cfg, state, { observations: withActivity(w) }));

  it('nudges once per still period', () => {
    const first = evaluate(at('13:45'), windows(at('12:00'), [[140, true], ...still(20)]));
    expect(first.notifications?.[0]).toMatchObject({ ruleId: 'inactivity', title: 'Time to move?' });
    expect(first.notifications?.[0]?.body).toMatch(/mostly still for 1h 40m/);
    const later = evaluate(at('13:55'), windows(at('12:00'), [[140, true], ...still(22)]), first.state);
    expect(later.notifications ?? []).toHaveLength(0);
    expect(later.status).toBe('alerting');
  });

  it('clears the nudge once movement resumes', () => {
    const first = evaluate(at('13:45'), windows(at('12:00'), [[140, true], ...still(20)]));
    const moved = evaluate(
      at('14:00'),
      windows(at('12:00'), [[140, true], ...still(21), [180, true], [10, true]]),
      first.state,
    );
    expect(moved.status).toBe('ok');
    expect(moved.resolved).toEqual([first.notifications![0]!.id]);
  });

  it('respects the cooldown for a new still period shortly after a nudge', () => {
    const state: InactivityState = { episode: null, lastNotifiedAt: at('13:30') };
    const outcome = evaluate(at('14:00'), windows(at('12:10'), [[140, true], ...still(21)]), state);
    expect(outcome).toMatchObject({ status: 'alerting', detail: 'cooldown' });
  });

  it('is not evaluated during sleep hours and needs no data then', () => {
    expect(evaluate(at('23:30'), windows(at('21:00'), still(30))).status).toBe('not_due');
    expect(
      inactivityRule.needs({
        now: at('23:30'),
        timeZone: 'Europe/London',
        schedule: config.schedule,
        config: cfg,
        state: inactivityRule.initialState(),
      }),
    ).toEqual([]);
  });

  it('reports insufficient data when activity could not be fetched', () => {
    const outcome = inactivityRule.evaluate(
      context(at('14:00'), cfg, inactivityRule.initialState(), {
        observations: { ...withActivity([]), activity: { status: 'unavailable', reason: 'google_server' } },
      }),
    );
    expect(outcome.status).toBe('insufficient_data');
  });
});
