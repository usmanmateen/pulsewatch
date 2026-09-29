import { createDailyView } from '../src/pipeline/daily';
import { parseConfig, type PulseWatchConfig } from '../src/config/schema';
import { zonedTimeToEpoch, parseClock, addDays } from '../src/domain/time';
import type { DailyMetric, DailyValue, DeviceStatus, EpochMs, LocalDate } from '../src/domain/types';
import { MINUTE_MS } from '../src/domain/types';
import type { FetchFn } from '../src/google/http';
import type { DailyView, Observations, RuleContext, StoredBaseline, SystemFacts } from '../src/rules/types';

export const TZ = 'Europe/London';
export const DAY = '2026-03-10';
export const config: PulseWatchConfig = parseConfig({});

/** Epoch for a local clock time on a day in Europe/London. */
export const at = (clock: string, day: LocalDate = DAY): EpochMs =>
  zonedTimeToEpoch(day, parseClock(clock), TZ);
export const minutes = (n: number): number => n * MINUTE_MS;

export const device = (overrides: Partial<DeviceStatus> = {}): DeviceStatus => ({
  model: 'Fitbit Air',
  lastSyncAt: null,
  batteryLevel: 70,
  batteryStatus: 'HIGH',
  ...overrides,
});

export function observations(
  input: {
    heartRateAt?: EpochMs | null | 'unavailable';
    device?: DeviceStatus | null | 'unavailable';
  } = {},
): Observations {
  const hr = input.heartRateAt;
  const dev = input.device;
  return {
    heartRate:
      hr === 'unavailable'
        ? { status: 'unavailable', reason: 'google_server' }
        : { status: 'ok', value: { latestAt: hr ?? null } },
    device:
      dev === 'unavailable'
        ? { status: 'unavailable', reason: 'google_forbidden' }
        : { status: 'ok', value: dev ?? null },
    activity: { status: 'not_requested' },
  };
}

export const systemFacts = (overrides: Partial<SystemFacts> = {}): SystemFacts => ({
  mode: 'live',
  auth: 'ok',
  credentialFingerprint: 'abc',
  consecutiveFailedChecks: 0,
  lastSuccessfulSyncAt: null,
  credentialAgeMs: null,
  ...overrides,
});

export function context<C, S>(
  now: EpochMs,
  ruleConfig: C,
  state: S,
  extra: Partial<Pick<RuleContext<C, S>, 'observations' | 'daily' | 'system'>> = {},
): RuleContext<C, S> {
  return {
    now,
    timeZone: TZ,
    schedule: config.schedule,
    config: ruleConfig,
    state,
    observations: extra.observations ?? observations(),
    daily: extra.daily ?? null,
    system: extra.system ?? systemFacts(),
  };
}

/** A daily series of `days` values ending on `lastDay`, from a generator. */
export function series(
  metric: DailyMetric,
  lastDay: LocalDate,
  days: number,
  value: (dayIndex: number) => number,
): DailyValue[] {
  return Array.from({ length: days }, (_, i) => ({
    metric,
    day: addDays(lastDay, i - days + 1),
    value: value(i),
  }));
}

export function dailyView(
  today: LocalDate,
  values: DailyValue[],
  baselines: StoredBaseline[] = [],
  syncComplete = true,
): DailyView {
  return createDailyView(today, values, baselines, syncComplete);
}

/** Deterministic pseudo-noise in [-1, 1] for building realistic series. */
export const wobble = (i: number): number => Math.sin(i * 12.9898) * 0.9;

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

/** A fetch double that records requests and answers from a handler. */
export function fakeFetch(handler: (request: RecordedRequest) => Response | Promise<Response>): {
  fetch: FetchFn;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const recorded: RecordedRequest = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: new TextDecoder().decode(await request.arrayBuffer()),
      };
      requests.push(recorded);
      return handler(recorded);
    },
  };
}
