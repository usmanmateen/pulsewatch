import * as z from 'zod';
import { formatLocalDate } from '../domain/time';
import type {
  ActivityWindow,
  BatteryStatus,
  DailyMetric,
  DailyValue,
  DeviceStatus,
  EpochMs,
  SleepSession,
} from '../domain/types';
import { GoogleApiError } from './http';

/**
 * Maps Google Health API v4 responses into the internal domain model.
 *
 * Wire-format quirks handled here:
 * - int64 fields (beatsPerMinute, count, minutesAsleep…) arrive as JSON strings.
 * - Offsets are protobuf durations such as "-14400s".
 * - Dates are {year, month, day} objects in the user's time zone.
 *
 * Top-level shape problems raise `invalid_response`; an individual malformed
 * point is skipped and counted so one bad record cannot sink a whole sync.
 */

const int64 = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^-?\d{1,15}$/)
    .transform(Number),
]);

const timestamp = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));

const offsetMinutes = z
  .string()
  .regex(/^-?\d+(\.\d+)?s$/)
  .transform((value) => Math.round(Number.parseFloat(value) / 60));

const civilDate = z
  .looseObject({
    year: z.number().int().min(1970).max(9999),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .transform((d) => formatLocalDate(d.year, d.month, d.day))
  .refine((date) => new Date(`${date}T12:00:00Z`).toISOString().startsWith(date), {
    message: 'impossible calendar date',
  });

export interface Normalised<T> {
  items: T[];
  /** Points that failed validation and were skipped. */
  skipped: number;
}

function collect<T>(raw: unknown[], parse: (item: unknown) => T | null): Normalised<T> {
  const items: T[] = [];
  let skipped = 0;
  for (const item of raw) {
    const value = parse(item);
    if (value === null) skipped += 1;
    else items.push(value);
  }
  return { items, skipped };
}

/** Validates the envelope of a paged response (`{ <key>: [...], nextPageToken }`). */
export function pageItems(body: unknown, key: string): { items: unknown[]; nextPageToken: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoogleApiError('invalid_response');
  }
  const record = body as Record<string, unknown>;
  const items = record[key];
  const token = record.nextPageToken;
  if ((items !== undefined && !Array.isArray(items)) || (token !== undefined && typeof token !== 'string')) {
    throw new GoogleApiError('invalid_response');
  }
  return { items: items ?? [], nextPageToken: token ? token : null };
}

// --- Heart rate -------------------------------------------------------------

const heartRatePoint = z.looseObject({
  heartRate: z.looseObject({
    sampleTime: z.looseObject({ physicalTime: timestamp }),
  }),
});

/**
 * The latest heart-rate sample time. Only the timestamp is requested (via a
 * field mask) and read — PulseWatch never needs the heart-rate value to
 * decide whether the tracker is being worn.
 */
export function latestHeartRateTime(body: unknown): { at: EpochMs | null; skipped: number } {
  const { items } = pageItems(body, 'dataPoints');
  const times = collect(items, (item) => {
    const result = heartRatePoint.safeParse(item);
    return result.success ? result.data.heartRate.sampleTime.physicalTime : null;
  });
  const latest = times.items.length > 0 ? Math.max(...times.items) : null;
  return { at: latest, skipped: times.skipped };
}

// --- Rollups (activity windows) ---------------------------------------------

const rollupPoint = z.looseObject({
  startTime: timestamp,
  endTime: timestamp,
  steps: z.looseObject({ countSum: int64.optional() }).optional(),
  heartRate: z.looseObject({ beatsPerMinuteAvg: z.number().optional() }).optional(),
});

export interface RollupWindow {
  start: EpochMs;
  end: EpochMs;
  steps: number | null;
  heartRatePresent: boolean;
}

export function rollupWindows(items: unknown[]): Normalised<RollupWindow> {
  return collect(items, (item) => {
    const result = rollupPoint.safeParse(item);
    if (!result.success || result.data.endTime <= result.data.startTime) return null;
    const steps = result.data.steps?.countSum;
    if (steps !== undefined && (steps < 0 || steps > 100_000)) return null;
    return {
      start: result.data.startTime,
      end: result.data.endTime,
      steps: steps ?? null,
      heartRatePresent: result.data.heartRate?.beatsPerMinuteAvg !== undefined,
    };
  });
}

/**
 * Joins step and heart-rate rollups onto a fixed grid. Windows Google does
 * not return are treated as "no steps, no heart rate recorded".
 */
export function mergeActivityWindows(
  gridStart: EpochMs,
  gridEnd: EpochMs,
  windowMs: number,
  steps: RollupWindow[],
  heartRate: RollupWindow[],
): ActivityWindow[] {
  const windows: ActivityWindow[] = [];
  const stepsByStart = new Map(steps.map((w) => [w.start, w.steps ?? 0]));
  const hrStarts = new Set(heartRate.filter((w) => w.heartRatePresent).map((w) => w.start));
  for (let start = gridStart; start + windowMs <= gridEnd; start += windowMs) {
    windows.push({
      start,
      end: start + windowMs,
      steps: stepsByStart.get(start) ?? 0,
      heartRateObserved: hrStarts.has(start),
    });
  }
  return windows;
}

// --- Paired devices ---------------------------------------------------------

const pairedDevice = z.looseObject({
  deviceVersion: z.string().max(200).optional(),
  deviceType: z.string().optional(),
  lastSyncTime: timestamp.optional(),
  batteryLevel: z.number().int().min(0).max(100).optional(),
  batteryStatus: z.string().max(32).optional(),
});

function batteryStatus(value: string | undefined): BatteryStatus | null {
  switch (value?.toUpperCase()) {
    case 'HIGH':
      return 'HIGH';
    case 'MEDIUM':
      return 'MEDIUM';
    case 'LOW':
      return 'LOW';
    case 'EMPTY':
      return 'EMPTY';
    default:
      return null;
  }
}

/**
 * Picks the tracker to reason about. With several trackers (an old band in
 * a drawer, say) the most recently synced one is the one being worn.
 */
export function selectTracker(body: unknown, preferredModel?: string): DeviceStatus | null {
  const { items } = pageItems(body, 'pairedDevices');
  const devices = collect(items, (item) => {
    const result = pairedDevice.safeParse(item);
    if (!result.success) return null;
    const d = result.data;
    if (d.deviceType && d.deviceType !== 'TRACKER') return null;
    return {
      model: d.deviceVersion?.trim() || null,
      lastSyncAt: d.lastSyncTime ?? null,
      batteryLevel: d.batteryLevel ?? null,
      batteryStatus: batteryStatus(d.batteryStatus),
    } satisfies DeviceStatus;
  }).items;
  const candidates = preferredModel
    ? devices.filter((d) => d.model?.toLowerCase() === preferredModel.toLowerCase())
    : devices;
  candidates.sort((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0));
  return candidates[0] ?? null;
}

// --- Sleep ------------------------------------------------------------------

const sleepPoint = z.looseObject({
  name: z.string().max(300).optional(),
  sleep: z.looseObject({
    interval: z.looseObject({
      startTime: timestamp,
      endTime: timestamp,
      startUtcOffset: offsetMinutes.optional(),
      endUtcOffset: offsetMinutes.optional(),
    }),
    metadata: z
      .looseObject({
        mainSleep: z.boolean().optional(),
        nap: z.boolean().optional(),
        processed: z.boolean().optional(),
      })
      .optional(),
    summary: z
      .looseObject({
        minutesAsleep: int64.optional(),
        minutesInSleepPeriod: int64.optional(),
      })
      .optional(),
  }),
});

export function sleepSessions(items: unknown[]): Normalised<SleepSession> {
  return collect(items, (item) => {
    const result = sleepPoint.safeParse(item);
    if (!result.success) return null;
    const { interval, metadata, summary } = result.data.sleep;
    const spanMinutes = (interval.endTime - interval.startTime) / 60_000;
    if (spanMinutes <= 0 || spanMinutes > 24 * 60) return null;
    const processed = metadata?.processed === true;
    // Still-processing sessions legitimately have no summary yet.
    const minutesAsleep = summary?.minutesAsleep ?? (processed ? undefined : 0);
    if (minutesAsleep === undefined || minutesAsleep < 0 || minutesAsleep > spanMinutes + 1) {
      return null;
    }
    const startOffset = interval.startUtcOffset ?? interval.endUtcOffset ?? 0;
    return {
      id: result.data.name ?? `sleep-${interval.startTime}`,
      start: interval.startTime,
      end: interval.endTime,
      startOffsetMinutes: startOffset,
      endOffsetMinutes: interval.endUtcOffset ?? startOffset,
      minutesAsleep,
      minutesInPeriod: summary?.minutesInSleepPeriod ?? Math.round(spanMinutes),
      isMainSleep: metadata?.mainSleep === true,
      isNap: metadata?.nap === true,
      processed,
    } satisfies SleepSession;
  });
}

// --- Daily summaries --------------------------------------------------------

/** Plausibility bounds keep sensor glitches out of personal baselines. */
const dailySchemas = {
  resting_hr: z
    .looseObject({
      dailyRestingHeartRate: z.looseObject({
        date: civilDate,
        beatsPerMinute: int64.pipe(z.number().min(25).max(220)),
      }),
    })
    .transform((p) => ({
      day: p.dailyRestingHeartRate.date,
      value: p.dailyRestingHeartRate.beatsPerMinute,
    })),
  hrv: z
    .looseObject({
      dailyHeartRateVariability: z.looseObject({
        date: civilDate,
        averageHeartRateVariabilityMilliseconds: z.number().min(1).max(300),
      }),
    })
    .transform((p) => ({
      day: p.dailyHeartRateVariability.date,
      value: p.dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds,
    })),
  respiratory_rate: z
    .looseObject({
      dailyRespiratoryRate: z.looseObject({
        date: civilDate,
        breathsPerMinute: z.number().min(4).max(60),
      }),
    })
    .transform((p) => ({
      day: p.dailyRespiratoryRate.date,
      value: p.dailyRespiratoryRate.breathsPerMinute,
    })),
} as const;

export type DailySummaryMetric = keyof typeof dailySchemas;

export function dailySummaries(metric: DailySummaryMetric, items: unknown[]): Normalised<DailyValue> {
  const seen = new Set<string>();
  return collect(items, (item) => {
    const result = dailySchemas[metric].safeParse(item);
    if (!result.success) return null;
    // One value per day; the API returns newest first, so keep the first.
    if (seen.has(result.data.day)) return null;
    seen.add(result.data.day);
    return { metric, day: result.data.day, value: result.data.value } satisfies DailyValue;
  });
}

const dailyStepsPoint = z.looseObject({
  civilStartTime: z.looseObject({ date: civilDate }),
  steps: z.looseObject({ countSum: int64.pipe(z.number().min(0).max(200_000)) }).optional(),
});

export function dailySteps(items: unknown[]): Normalised<DailyValue> {
  return collect(items, (item) => {
    const result = dailyStepsPoint.safeParse(item);
    if (!result.success) return null;
    const metric: DailyMetric = 'steps';
    return {
      metric,
      day: result.data.civilStartTime.date,
      value: result.data.steps?.countSum ?? 0,
    };
  });
}
