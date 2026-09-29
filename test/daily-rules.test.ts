import { describe, expect, it } from 'vitest';
import {
  computeDailyBaselines,
  dailySyncDue,
  isDailyComplete,
  sleepToDailyValues,
} from '../src/pipeline/daily';
import { composeBrief, morningBriefRule } from '../src/rules/morning-brief';
import { sleepRule } from '../src/rules/sleep';
import { hrvRule, restingHeartRateRule, type TrendState } from '../src/rules/trend';
import { addDays, zonedTimeToEpoch } from '../src/domain/time';
import type { DailyValue, SleepSession } from '../src/domain/types';
import { at, config, context, dailyView, series, wobble } from './helpers';

const TODAY = '2026-03-10';

function session(overrides: Partial<SleepSession>): SleepSession {
  return {
    id: 's',
    start: at('23:20', '2026-03-09'),
    end: at('06:50', TODAY),
    startOffsetMinutes: 0,
    endOffsetMinutes: 0,
    minutesAsleep: 420,
    minutesInPeriod: 450,
    isMainSleep: true,
    isNap: false,
    processed: true,
    ...overrides,
  };
}

describe('sleep → daily values', () => {
  it('attributes sleep that crosses midnight to the wake-up date, bedtime negative', () => {
    const values = sleepToDailyValues([session({})]);
    expect(values).toEqual([
      { metric: 'sleep_minutes', day: TODAY, value: 420 },
      { metric: 'bedtime', day: TODAY, value: -40 },
      { metric: 'waketime', day: TODAY, value: 410 },
    ]);
  });

  it('handles a bedtime after midnight', () => {
    const values = sleepToDailyValues([session({ start: at('00:45', TODAY) })]);
    expect(values.find((v) => v.metric === 'bedtime')?.value).toBe(45);
  });

  it('uses device offsets across the DST night (clocks go forward)', () => {
    // 23:00 GMT on 28 March to 07:00 BST on 29 March is 7 real hours.
    const start = zonedTimeToEpoch('2026-03-28', 23 * 60, 'Europe/London');
    const end = zonedTimeToEpoch('2026-03-29', 7 * 60, 'Europe/London');
    expect((end - start) / 3_600_000).toBe(7);
    const values = sleepToDailyValues([
      session({ start, end, startOffsetMinutes: 0, endOffsetMinutes: 60, minutesAsleep: 400 }),
    ]);
    expect(values).toContainEqual({ metric: 'bedtime', day: '2026-03-29', value: -60 });
    expect(values).toContainEqual({ metric: 'waketime', day: '2026-03-29', value: 420 });
  });

  it('ignores naps, non-main and still-processing sessions; keeps the longest main sleep per day', () => {
    const values = sleepToDailyValues([
      session({ isNap: true, isMainSleep: false, minutesAsleep: 30 }),
      session({ processed: false, minutesAsleep: 0 }),
      session({ minutesAsleep: 300 }),
      session({ minutesAsleep: 410 }),
    ]);
    expect(values.find((v) => v.metric === 'sleep_minutes')?.value).toBe(410);
  });

  it('daily data is complete only with last night’s sleep and a recovery metric', () => {
    const sleep: DailyValue = { metric: 'sleep_minutes', day: TODAY, value: 400 };
    expect(isDailyComplete([sleep], TODAY)).toBe(false);
    expect(isDailyComplete([sleep, { metric: 'hrv', day: TODAY, value: 50 }], TODAY)).toBe(true);
    expect(
      isDailyComplete(
        [
          { ...sleep, day: '2026-03-09' },
          { metric: 'hrv', day: TODAY, value: 50 },
        ],
        TODAY,
      ),
    ).toBe(false);
  });
});

describe('daily sync scheduling', () => {
  const base = { now: at('06:00'), today: TODAY, minuteOfDay: 360, config, lastAttemptAt: null };
  it('backfills immediately, then waits for the pre-wake window and spaces retries', () => {
    expect(dailySyncDue({ ...base, completeDay: null, backfilled: false, minuteOfDay: 60 })).toBe(true);
    expect(dailySyncDue({ ...base, completeDay: null, backfilled: true, minuteOfDay: 240 })).toBe(false);
    expect(dailySyncDue({ ...base, completeDay: null, backfilled: true })).toBe(true);
    expect(dailySyncDue({ ...base, completeDay: TODAY, backfilled: true })).toBe(false);
    expect(dailySyncDue({ ...base, completeDay: null, backfilled: true, lastAttemptAt: at('05:45') })).toBe(
      false,
    );
  });
});

describe('sleep rule', () => {
  const cfg = config.rules.sleep;
  const view = (minutes: number | null) =>
    dailyView(TODAY, [
      ...(minutes === null ? [] : [{ metric: 'sleep_minutes' as const, day: TODAY, value: minutes }]),
      { metric: 'bedtime', day: TODAY, value: -52 },
      { metric: 'waketime', day: TODAY, value: 300 },
    ]);

  it('alerts once when below target, with timing', () => {
    const first = sleepRule.evaluate(
      context(at('07:40'), cfg, sleepRule.initialState(), { daily: view(352) }),
    );
    expect(first.notifications?.[0]?.body).toBe(
      "Last night's recorded sleep was 5h 52m (23:08 → 05:00), below your 6h 30m target.",
    );
    const again = sleepRule.evaluate(context(at('07:50'), cfg, first.state, { daily: view(352) }));
    expect(again.notifications ?? []).toHaveLength(0);
  });

  it('stays quiet at or above target and while data is still processing', () => {
    expect(
      sleepRule.evaluate(context(at('07:40'), cfg, sleepRule.initialState(), { daily: view(390) }))
        .notifications,
    ).toBeUndefined();
    expect(
      sleepRule.evaluate(context(at('07:40'), cfg, sleepRule.initialState(), { daily: view(null) })).status,
    ).toBe('insufficient_data');
  });

  it('never notifies during sleeping hours', () => {
    const early = sleepRule.evaluate(
      context(at('05:30'), cfg, sleepRule.initialState(), { daily: view(300) }),
    );
    expect(early).toMatchObject({ status: 'not_due', detail: 'sleep_hours' });
  });
});

describe('trend rules', () => {
  const rhrHistory = (recent: number[]) =>
    series('resting_hr', TODAY, 40, (i) =>
      i >= 40 - recent.length ? recent[i - 40 + recent.length]! : 58 + wobble(i) * 1.5,
    );

  const evaluateRhr = (
    values: DailyValue[],
    state: TrendState = restingHeartRateRule.initialState(),
    day = TODAY,
    now = at('08:00'),
  ) =>
    restingHeartRateRule.evaluate(
      context(now, config.rules.restingHeartRate, state, { daily: dailyView(day, values) }),
    );

  it('alerts once for a sustained resting-HR rise, then keeps the episode without repeating', () => {
    const first = evaluateRhr(rhrHistory([65, 66, 65]));
    expect(first.status).toBe('alerting');
    expect(first.notifications?.[0]?.title).toBe('Resting heart rate above your usual range');
    expect(first.notifications?.[0]?.body).toMatch(/not a medical assessment/);

    const nextDay = addDays(TODAY, 1);
    const continued = evaluateRhr(
      [...rhrHistory([65, 66, 65]), { metric: 'resting_hr', day: nextDay, value: 66 }],
      first.state,
      nextDay,
      at('08:00', nextDay),
    );
    expect(continued.status).toBe('alerting');
    expect(continued.notifications ?? []).toHaveLength(0);
  });

  it('ignores a single high day', () => {
    expect(evaluateRhr(rhrHistory([58, 58, 70])).notifications ?? []).toHaveLength(0);
  });

  it('ends the episode when values return to the usual range', () => {
    const first = evaluateRhr(rhrHistory([65, 66, 65]));
    const nextDay = addDays(TODAY, 1);
    const back = evaluateRhr(
      [...rhrHistory([65, 66, 65]), { metric: 'resting_hr', day: nextDay, value: 58 }],
      first.state,
      nextDay,
      at('08:00', nextDay),
    );
    expect(back.status).toBe('ok');
    expect(back.state.episode).toBeNull();
  });

  it('respects the cooldown after a recent alert', () => {
    const state: TrendState = { lastEvaluatedDay: null, episode: null, lastNotifiedOn: addDays(TODAY, -2) };
    const outcome = evaluateRhr(rhrHistory([65, 66, 65]), state);
    expect(outcome).toMatchObject({ status: 'alerting', detail: 'cooldown' });
    expect(outcome.notifications ?? []).toHaveLength(0);
  });

  it('reports a baseline that is still building instead of guessing', () => {
    const short = series('resting_hr', TODAY, 8, () => 60);
    expect(evaluateRhr(short)).toMatchObject({
      status: 'insufficient_data',
      detail: 'baseline_building:5/14',
    });
  });

  it('does not act on stale data', () => {
    const old = series('resting_hr', addDays(TODAY, -5), 40, () => 60);
    expect(evaluateRhr(old)).toMatchObject({ status: 'insufficient_data', detail: 'no_recent_data' });
  });

  it('HRV: flags a sustained multiplicative drop, respecting direction', () => {
    const hrv = series('hrv', TODAY, 40, (i) => (i >= 37 ? 33 : 52 * Math.exp(wobble(i) * 0.1)));
    const outcome = hrvRule.evaluate(
      context(at('08:00'), config.rules.hrv, hrvRule.initialState(), { daily: dailyView(TODAY, hrv) }),
    );
    expect(outcome.notifications?.[0]?.title).toBe('HRV below your usual range');
    expect(outcome.notifications?.[0]?.body).toMatch(/−\d+%/);

    const up = series('hrv', TODAY, 40, (i) => (i >= 37 ? 80 : 52 * Math.exp(wobble(i) * 0.1)));
    const higher = hrvRule.evaluate(
      context(at('08:00'), config.rules.hrv, hrvRule.initialState(), { daily: dailyView(TODAY, up) }),
    );
    expect(higher.notifications ?? []).toHaveLength(0);
  });
});

describe('morning brief', () => {
  const cfg = config.rules.morningBrief;
  const history: DailyValue[] = [
    ...series('resting_hr', TODAY, 35, (i) => 58 + wobble(i)),
    ...series('hrv', TODAY, 35, (i) => 50 + wobble(i) * 3),
    ...series('respiratory_rate', TODAY, 35, (i) => 14.6 + wobble(i) * 0.3),
    ...series('sleep_minutes', TODAY, 35, (i) => 430 + wobble(i) * 20),
    ...series('steps', addDays(TODAY, -1), 34, (i) => 8421 + i * 0),
    { metric: 'bedtime', day: TODAY, value: -19 },
    { metric: 'waketime', day: TODAY, value: 389 },
  ];
  const baselines = computeDailyBaselines(history, TODAY, config).map((b) => b);

  it('composes a concise brief with timing and no-deviation summary', () => {
    const lines = composeBrief(dailyView(TODAY, history, baselines));
    expect(lines[0]).toMatch(/^Sleep: \dh \d{2}m \(23:41 → 06:29\)$/);
    expect(lines).toContain('Yesterday: 8,421 steps');
    expect(lines.at(-1)).toBe('No notable deviations from your recent baseline.');
  });

  it('omits missing metrics rather than inventing them', () => {
    const lines = composeBrief(dailyView(TODAY, [{ metric: 'resting_hr', day: TODAY, value: 61 }], []));
    expect(lines).toEqual([
      'Resting HR: 61 bpm',
      'Personal baselines are still building (0 days of history so far).',
    ]);
  });

  it('waits for data, then sends once; falls back to partial data at the deadline', () => {
    const pending = morningBriefRule.evaluate(
      context(at('07:40'), cfg, morningBriefRule.initialState(), {
        daily: dailyView(TODAY, history, baselines, false),
      }),
    );
    expect(pending.status).toBe('pending');

    const sent = morningBriefRule.evaluate(
      context(at('07:40'), cfg, morningBriefRule.initialState(), {
        daily: dailyView(TODAY, history, baselines, true),
      }),
    );
    expect(sent.notifications?.[0]?.id).toBe(`morningBrief:${TODAY}`);
    const again = morningBriefRule.evaluate(
      context(at('08:00'), cfg, sent.state, { daily: dailyView(TODAY, history, baselines) }),
    );
    expect(again.notifications ?? []).toHaveLength(0);

    const deadline = morningBriefRule.evaluate(
      context(at('11:00'), cfg, morningBriefRule.initialState(), {
        daily: dailyView(TODAY, history, baselines, false),
      }),
    );
    expect(deadline.notifications).toHaveLength(1);
  });

  it('is not due before the window and skips a stale window', () => {
    expect(morningBriefRule.evaluate(context(at('07:00'), cfg, morningBriefRule.initialState())).status).toBe(
      'not_due',
    );
    const late = morningBriefRule.evaluate(context(at('13:00'), cfg, morningBriefRule.initialState()));
    expect(late).toMatchObject({ detail: 'missed_window' });
    expect(late.state.lastSkippedDay).toBe(TODAY);
  });

  it('mentions clear deviations only', () => {
    const shifted = history.map((v) =>
      v.metric === 'resting_hr' && v.day === TODAY ? { ...v, value: 66 } : v,
    );
    const lines = composeBrief(dailyView(TODAY, shifted, baselines));
    expect(lines).toContain('Resting HR is 8 bpm above your usual range.');
    expect(lines).not.toContain('No notable deviations from your recent baseline.');
  });
});
