import { addDays, localDate, parseClock, zonedTimeToEpoch } from '../domain/time';
import { HOUR_MS, MINUTE_MS, type EpochMs } from '../domain/types';
import type { FetchFn } from '../google/http';
import { createGoogleHealthEmulator } from './google-emulator';
import { buildWorldSpec, findScenario, scenarioStart } from './scenarios';
import { DEFAULT_PROFILE, SyntheticWorld, type Interval, type WorldSpec } from './world';

/**
 * Synthetic data for a Worker running with MODE=demo (e.g. `npm run dev`).
 * The emulator is anchored to the real clock, so cron-driven checks play a
 * scenario out in real time through the real Worker runtime, D1 and Queue.
 *
 * - A scripted scenario id replays that scenario at its times today, or —
 *   with an anchor — starting at the anchor, so a demo deployment behaves the
 *   same whatever the time of day.
 * - "daily-routine" (default) takes the tracker off for 70 minutes every
 *   two hours during the day, so the full off-wrist cycle is always nearby.
 */
export function createLiveDemoFetch(
  scenarioId: string,
  now: () => EpochMs,
  timeZone: string,
  anchor: EpochMs | null = null,
): FetchFn {
  const today = localDate(now(), timeZone);
  const scenario = findScenario(scenarioId);
  let spec = scenario ? buildWorldSpec(scenario, today, timeZone) : dailyRoutineSpec(today, timeZone);
  if (scenario && anchor !== null) {
    spec = shiftTimeline(spec, anchor - scenarioStart(scenario, today, timeZone));
  }
  return createGoogleHealthEmulator(new SyntheticWorld(spec), now);
}

/** Moves every scripted event (removals, sync outages, still periods, battery) by `shiftMs`. */
export function shiftTimeline(spec: WorldSpec, shiftMs: number): WorldSpec {
  const shift = (interval: Interval): Interval => ({
    start: interval.start + shiftMs,
    end: interval.end + shiftMs,
  });
  return {
    ...spec,
    offWrist: spec.offWrist.map(shift),
    syncOutages: spec.syncOutages.map(shift),
    sedentary: spec.sedentary.map(shift),
    ...(spec.walks ? { walks: spec.walks.map(shift) } : {}),
    battery: spec.battery.map((point) => ({ ...point, at: point.at + shiftMs })),
  };
}

export function dailyRoutineSpec(today: string, timeZone: string): WorldSpec {
  const offWrist: Interval[] = [];
  for (const day of [addDays(today, -1), today]) {
    const eight = zonedTimeToEpoch(day, parseClock('08:00'), timeZone);
    for (let block = 0; block < 7; block++) {
      const start = eight + block * 2 * HOUR_MS + 20 * MINUTE_MS;
      offWrist.push({ start, end: start + 70 * MINUTE_MS });
    }
  }
  return {
    timeZone,
    seed: 424242,
    deviceModel: 'Fitbit Air',
    today,
    historyDays: 70,
    profile: DEFAULT_PROFILE,
    dailyOverrides: {},
    offWrist,
    syncOutages: [],
    sedentary: [],
    battery: [{ at: zonedTimeToEpoch(today, 0, timeZone), level: 72 }],
    syncIntervalMinutes: 15,
    sleepProcessingMinutes: 20,
  };
}
