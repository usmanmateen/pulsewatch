/**
 * Internal domain model. Nothing in here knows about Google's wire format;
 * the normaliser in `src/google/normalise.ts` is the only place that maps
 * API responses into these types.
 */

/** Milliseconds since the Unix epoch (UTC). */
export type EpochMs = number;

/** A calendar date in the user's time zone, formatted `YYYY-MM-DD`. */
export type LocalDate = string;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type BatteryStatus = 'HIGH' | 'MEDIUM' | 'LOW' | 'EMPTY';

/** The paired tracker, as last reported to Google by the phone app. */
export interface DeviceStatus {
  /** Product name, e.g. "Fitbit Air". Used only to personalise wording. */
  model: string | null;
  /** When the tracker last synced with the phone app. */
  lastSyncAt: EpochMs | null;
  /** Battery percentage reported at the last sync. */
  batteryLevel: number | null;
  batteryStatus: BatteryStatus | null;
}

/**
 * A short, fixed-width slice of the recent past built from Google's rollups.
 * Only step totals and "was any heart rate recorded" are kept; heart-rate
 * values themselves are never needed for these rules.
 */
export interface ActivityWindow {
  start: EpochMs;
  end: EpochMs;
  steps: number;
  heartRateObserved: boolean;
}

export interface SleepSession {
  id: string;
  start: EpochMs;
  end: EpochMs;
  /** UTC offsets recorded by the device, so bed/wake times render in local time. */
  startOffsetMinutes: number;
  endOffsetMinutes: number;
  minutesAsleep: number;
  minutesInPeriod: number;
  isMainSleep: boolean;
  isNap: boolean;
  processed: boolean;
}

/**
 * Daily aggregates persisted for baselines and the morning brief.
 * `bedtime`/`waketime` are minutes relative to local midnight of the wake-up
 * day (bedtime is negative when it falls before midnight), which keeps
 * sleep timing continuous across midnight.
 */
export const DAILY_METRICS = [
  'resting_hr',
  'hrv',
  'respiratory_rate',
  'sleep_minutes',
  'bedtime',
  'waketime',
  'steps',
] as const;
export type DailyMetric = (typeof DAILY_METRICS)[number];

export interface DailyValue {
  metric: DailyMetric;
  day: LocalDate;
  value: number;
}
