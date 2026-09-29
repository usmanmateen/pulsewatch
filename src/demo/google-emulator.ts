import { addDays, localDate, parseLocalDate } from '../domain/time';
import { MINUTE_MS, type EpochMs, type LocalDate } from '../domain/types';
import type { FetchFn } from '../google/http';
import { REQUIRED_SCOPES } from '../google/oauth';
import { SyntheticWorld } from './world';

/**
 * An HTTP emulator of the parts of the Google Health API v4 PulseWatch uses,
 * backed by a {@link SyntheticWorld}. It returns the real wire format
 * (int64s as strings, protobuf durations, civil dates, extra fields the
 * client does not ask for) and rejects malformed filters like the real API,
 * so demo runs exercise the production client and normaliser end to end.
 *
 * Only data recorded before the tracker's last sync is visible, which is
 * exactly the sync-lag behaviour the off-wrist state machine reasons about.
 */

export interface GoogleFault {
  /** Matches `METHOD path`, e.g. /GET .*heart-rate/. */
  match: RegExp;
  status: number;
  /** Raw body to return; defaults to a Google-style error JSON. */
  body?: string;
  /** How many matching requests fail; undefined means every one. */
  times?: number;
}

const DEMO_ACCESS_TOKEN = 'demo-access-token';
const iso = (t: EpochMs): string => new Date(t).toISOString();

function durationString(offsetMinutes: number): string {
  return `${offsetMinutes * 60}s`;
}

function googleError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code: status, message, status: code } }, { status });
}

interface FilterClause {
  field: string;
  op: '>=' | '<';
  value: string;
}

function parseFilter(filter: string | null): FilterClause[] | null {
  if (!filter) return [];
  const clauses: FilterClause[] = [];
  for (const part of filter.split(/\s+AND\s+/)) {
    const match = /^([a-z_.]+)\s*(>=|<)\s*"([^"]+)"$/.exec(part.trim());
    if (!match) return null;
    clauses.push({ field: match[1]!, op: match[2] as '>=' | '<', value: match[3]! });
  }
  return clauses;
}

function bounds(clauses: FilterClause[], field: string): { from?: string; to?: string } | null {
  const result: { from?: string; to?: string } = {};
  for (const clause of clauses) {
    if (clause.field !== field) return null;
    if (clause.op === '>=') result.from = clause.value;
    else result.to = clause.value;
  }
  return result;
}

const civilDate = (day: LocalDate) => parseLocalDate(day);

export function createGoogleHealthEmulator(
  world: SyntheticWorld,
  now: () => EpochMs,
  faults: GoogleFault[] = [],
): FetchFn {
  const remaining = faults.map((fault) => ({ ...fault, left: fault.times ?? Number.POSITIVE_INFINITY }));

  const heartRateLatest = (from: EpochMs): unknown[] => {
    const visibleUntil = world.lastSyncAt(now());
    if (visibleUntil === null) return [];
    for (
      let minute = Math.floor(visibleUntil / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
      minute >= from;
      minute -= MINUTE_MS
    ) {
      if (world.isWorn(minute)) {
        const bpm = world.spec.profile.restingHr + 8 + Math.round(world.noise(`hr:${minute}`) * 6);
        return [
          {
            heartRate: {
              beatsPerMinute: String(bpm),
              sampleTime: { physicalTime: iso(minute + 30_000), utcOffset: '0s' },
              metadata: { motionContext: 'SEDENTARY', sensorLocation: 'WRIST' },
            },
            dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' },
          },
        ];
      }
    }
    return [];
  };

  const rollup = (dataType: string, start: EpochMs, end: EpochMs, windowMs: number): unknown[] => {
    const visibleUntil = world.lastSyncAt(now()) ?? 0;
    const points: unknown[] = [];
    for (let windowStart = start; windowStart + windowMs <= end; windowStart += windowMs) {
      let steps = 0;
      let heartRate = false;
      for (let minute = windowStart; minute < windowStart + windowMs; minute += MINUTE_MS) {
        if (minute + MINUTE_MS > visibleUntil) break;
        if (world.isWorn(minute)) {
          heartRate = true;
          steps += world.stepsInMinute(minute);
        }
      }
      const base = { startTime: iso(windowStart), endTime: iso(windowStart + windowMs) };
      if (dataType === 'steps' && steps > 0) points.push({ ...base, steps: { countSum: String(steps) } });
      if (dataType === 'heart-rate' && heartRate) {
        const avg = world.spec.profile.restingHr + 10;
        points.push({
          ...base,
          heartRate: { beatsPerMinuteAvg: avg, beatsPerMinuteMin: avg - 6, beatsPerMinuteMax: avg + 9 },
        });
      }
    }
    return points;
  };

  const sleepPoints = (from: EpochMs, to: EpochMs): unknown[] => {
    const today = localDate(now(), world.spec.timeZone);
    const points: unknown[] = [];
    for (let offset = 0; offset <= world.spec.historyDays; offset++) {
      const day = addDays(today, -offset);
      const sleep = world.sleepFor(day);
      if (sleep.end < from || sleep.end >= to) continue;
      // Tonight's session appears once synced after waking; its summary once processed.
      if (offset === 0 && sleep.end > (world.lastSyncAt(now()) ?? 0)) continue;
      const processed = offset > 0 || world.sleepProcessed(day, now());
      points.push({
        name: `users/me/dataTypes/sleep/dataPoints/demo-${day}`,
        sleep: {
          interval: {
            startTime: iso(sleep.start),
            startUtcOffset: durationString(sleep.startOffsetMinutes),
            endTime: iso(sleep.end),
            endUtcOffset: durationString(sleep.endOffsetMinutes),
          },
          type: 'STAGES',
          metadata: {
            mainSleep: true,
            nap: false,
            processed,
            stagesStatus: processed ? 'SUCCEEDED' : 'STAGES_STATE_UNSPECIFIED',
          },
          summary: processed
            ? {
                minutesAsleep: String(sleep.minutesAsleep),
                minutesInSleepPeriod: String(sleep.minutesInPeriod),
                minutesAwake: String(sleep.minutesInPeriod - sleep.minutesAsleep),
              }
            : undefined,
        },
      });
    }
    return points;
  };

  const dailyPoints = (dataType: string, from: LocalDate, to: LocalDate): unknown[] => {
    const today = localDate(now(), world.spec.timeZone);
    const points: unknown[] = [];
    for (let day = addDays(to, -1); day >= from; day = addDays(day, -1)) {
      if (world.dayOffset(day) < -world.spec.historyDays || day > today) continue;
      // Sleep-derived daily metrics exist once last night's sleep is processed.
      if (day === today && !world.sleepProcessed(day, now())) continue;
      const date = civilDate(day);
      if (dataType === 'daily-resting-heart-rate') {
        points.push({
          dailyRestingHeartRate: {
            date,
            beatsPerMinute: String(world.dailyValue('resting_hr', day)),
            dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' },
          },
        });
      } else if (dataType === 'daily-heart-rate-variability') {
        points.push({
          dailyHeartRateVariability: {
            date,
            averageHeartRateVariabilityMilliseconds: world.dailyValue('hrv', day),
            entropy: 2.1,
          },
        });
      } else if (dataType === 'daily-respiratory-rate') {
        points.push({
          dailyRespiratoryRate: { date, breathsPerMinute: world.dailyValue('respiratory_rate', day) },
        });
      }
    }
    return points;
  };

  /** `serverCap` models the live API returning fewer items than the requested pageSize. */
  const page = (
    items: unknown[],
    key: string,
    url: URL,
    defaultSize: number,
    serverCap = 10_000,
  ): Response => {
    const requested = Number(url.searchParams.get('pageSize') ?? defaultSize) || defaultSize;
    const size = Math.min(requested, serverCap);
    const offset = Number(url.searchParams.get('pageToken') ?? '0') || 0;
    const slice = items.slice(offset, offset + size);
    const next = offset + size < items.length ? String(offset + size) : undefined;
    return Response.json({ [key]: slice, ...(next ? { nextPageToken: next } : {}) });
  };

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    for (const fault of remaining) {
      if (fault.left > 0 && fault.match.test(`${method} ${url.pathname}`)) {
        fault.left -= 1;
        return new Response(
          fault.body ?? JSON.stringify({ error: { code: fault.status, status: 'UNAVAILABLE' } }),
          {
            status: fault.status,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
    }

    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return Response.json({
        access_token: DEMO_ACCESS_TOKEN,
        expires_in: 3599,
        token_type: 'Bearer',
        scope: REQUIRED_SCOPES.join(' '),
      });
    }
    if (url.hostname !== 'health.googleapis.com') return googleError(404, 'NOT_FOUND', 'Unknown host');
    if (request.headers.get('Authorization') !== `Bearer ${DEMO_ACCESS_TOKEN}`) {
      return googleError(401, 'UNAUTHENTICATED', 'Missing or invalid credentials');
    }

    const path = url.pathname.replace(/^\/v4\/users\/me\//, '');
    const body = method === 'POST' ? await request.json<Record<string, unknown>>() : {};
    const filter = parseFilter(url.searchParams.get('filter'));
    if (filter === null) return googleError(400, 'INVALID_ARGUMENT', 'Invalid filter');

    if (path === 'pairedDevices') {
      const syncedAt = world.lastSyncAt(now());
      const level = syncedAt === null ? null : Math.max(0, Math.round(world.batteryAt(syncedAt)));
      const status = level === null ? undefined : SyntheticWorld.batteryStatus(level);
      return Response.json({
        pairedDevices: [
          {
            name: 'users/me/pairedDevices/demo-tracker',
            deviceType: 'TRACKER',
            deviceVersion: world.spec.deviceModel,
            macAddress: '02:00:00:00:00:01',
            ...(syncedAt === null ? {} : { lastSyncTime: iso(syncedAt) }),
            ...(level === null ? {} : { batteryLevel: level }),
            ...(status ? { batteryStatus: status.charAt(0) + status.slice(1).toLowerCase() } : {}),
          },
        ],
      });
    }

    if (path === 'dataTypes/heart-rate/dataPoints' && method === 'GET') {
      const range = bounds(filter, 'heart_rate.sample_time.physical_time');
      if (!range?.from) return googleError(400, 'INVALID_ARGUMENT', 'heart-rate filter required');
      return page(heartRateLatest(Date.parse(range.from)), 'dataPoints', url, 1440);
    }

    const rollUpMatch = /^dataTypes\/(steps|heart-rate)\/dataPoints:rollUp$/.exec(path);
    if (rollUpMatch && method === 'POST') {
      const range = body.range as { startTime?: string; endTime?: string } | undefined;
      const windowSeconds =
        typeof body.windowSize === 'string' ? Number(body.windowSize.replace(/s$/, '')) : NaN;
      if (!range?.startTime || !range.endTime || !Number.isFinite(windowSeconds) || windowSeconds < 1) {
        return googleError(400, 'INVALID_ARGUMENT', 'range and windowSize are required');
      }
      const points = rollup(
        rollUpMatch[1]!,
        Date.parse(range.startTime),
        Date.parse(range.endTime),
        windowSeconds * 1000,
      );
      return Response.json({ rollupDataPoints: points });
    }

    if (path === 'dataTypes/steps/dataPoints:dailyRollUp' && method === 'POST') {
      // As observed on the live API: despite the published schema, any pageSize is rejected.
      if ('pageSize' in body) return googleError(400, 'INVALID_ARGUMENT', 'Invalid argument in request.');
      const range = body.range as
        | {
            start?: { date?: { year: number; month: number; day: number } };
            end?: { date?: { year: number; month: number; day: number } };
          }
        | undefined;
      const start = range?.start?.date;
      const end = range?.end?.date;
      if (!start || !end) return googleError(400, 'INVALID_ARGUMENT', 'civil range required');
      const toDay = (d: { year: number; month: number; day: number }) =>
        `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      const points: unknown[] = [];
      for (let day = toDay(start); day < toDay(end); day = addDays(day, 1)) {
        if (world.dayOffset(day) < -world.spec.historyDays) continue;
        points.push({
          civilStartTime: { date: civilDate(day), time: {} },
          civilEndTime: { date: civilDate(addDays(day, 1)), time: {} },
          steps: { countSum: String(world.dailySteps(day)) },
        });
      }
      return Response.json({ rollupDataPoints: points });
    }

    if (path === 'dataTypes/sleep/dataPoints' && method === 'GET') {
      const range = bounds(filter, 'sleep.interval.end_time');
      if (!range?.from || !range.to) return googleError(400, 'INVALID_ARGUMENT', 'sleep filter required');
      // Sleep pages are capped at 25 and, like the live API, often come back shorter.
      return page(sleepPoints(Date.parse(range.from), Date.parse(range.to)), 'dataPoints', url, 25, 10);
    }

    const dailyMatch =
      /^dataTypes\/(daily-resting-heart-rate|daily-heart-rate-variability|daily-respiratory-rate)\/dataPoints$/.exec(
        path,
      );
    if (dailyMatch && method === 'GET') {
      const field = `${dailyMatch[1]!.replaceAll('-', '_')}.date`;
      const range = bounds(filter, field);
      if (!range?.from || !range.to) return googleError(400, 'INVALID_ARGUMENT', `${field} range required`);
      return page(dailyPoints(dailyMatch[1]!, range.from, range.to), 'dataPoints', url, 1440);
    }

    return googleError(404, 'NOT_FOUND', `No emulated endpoint for ${method} ${path}`);
  };
}
