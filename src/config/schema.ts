import * as z from 'zod';
import { parseClock } from '../domain/time';

/**
 * PulseWatch configuration. Every field has a default, so an empty object is
 * a valid configuration; overrides are supplied through the
 * `PULSEWATCH_CONFIG` Worker variable. Objects are strict: a misspelt key is
 * an error rather than a silently ignored setting.
 */

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');

const deviceOffWrist = z
  .strictObject({
    enabled: z.boolean().default(true),
    /**
     * Heart rate older than this counts as a stale check, and a gap this long
     * before the tracker's last sync is proof of removal. Short values alert
     * sooner but also on brief gaps in readings while worn.
     */
    staleAfterMinutes: z.number().int().min(5).max(240).default(30),
    /** Device sync older than this means wear status cannot be confirmed. */
    syncStaleAfterMinutes: z.number().int().min(15).max(720).default(60),
    /** Consecutive stale checks required before notifying. */
    confirmationChecks: z.number().int().min(1).max(6).default(2),
    /** Minimum gap between off-wrist notifications across episodes. */
    cooldownMinutes: z.number().int().min(0).max(1440).default(60),
    lowBatteryPercent: z.number().int().min(1).max(50).default(15),
    emptyBatteryPercent: z.number().int().min(0).max(20).default(5),
    /** When false, alerts raised overnight are held until waking hours. */
    notifyDuringSleepHours: z.boolean().default(false),
    /** Dismiss the phone notification once readings resume. */
    clearOnRecovery: z.boolean().default(true),
  })
  .refine((c) => c.emptyBatteryPercent < c.lowBatteryPercent, {
    message: 'emptyBatteryPercent must be below lowBatteryPercent',
  })
  .refine((c) => c.syncStaleAfterMinutes >= c.staleAfterMinutes, {
    message: 'syncStaleAfterMinutes must be at least staleAfterMinutes',
  });

const inactivity = z.strictObject({
  enabled: z.boolean().default(true),
  thresholdMinutes: z.number().int().min(30).max(240).default(90),
  /** Steps within one 5-minute window that count as a movement break. */
  breakSteps: z.number().int().min(20).max(1000).default(100),
  cooldownMinutes: z.number().int().min(0).max(1440).default(60),
  clearOnMovement: z.boolean().default(true),
});

const sleep = z.strictObject({
  enabled: z.boolean().default(true),
  minimumHours: z.number().min(3).max(12).default(6.5),
});

const restingHeartRate = z
  .strictObject({
    enabled: z.boolean().default(true),
    baselineDays: z.number().int().min(14).max(90).default(30),
    minimumSamples: z.number().int().min(7).max(90).default(14),
    consecutiveDays: z.number().int().min(2).max(7).default(3),
    /** Robust z-score each day must exceed. */
    zThreshold: z.number().min(1).max(5).default(2),
    /** ...and the absolute change must be at least this many bpm. */
    minimumDeltaBpm: z.number().min(0).max(30).default(3),
    direction: z.enum(['above', 'below', 'either']).default('above'),
    cooldownDays: z.number().int().min(0).max(30).default(7),
  })
  .refine((c) => c.minimumSamples <= c.baselineDays, {
    message: 'minimumSamples cannot exceed baselineDays',
  });

const hrv = z
  .strictObject({
    enabled: z.boolean().default(true),
    baselineDays: z.number().int().min(14).max(90).default(30),
    minimumSamples: z.number().int().min(7).max(90).default(14),
    consecutiveDays: z.number().int().min(2).max(7).default(3),
    zThreshold: z.number().min(1).max(5).default(1.5),
    /** Minimum percentage change from the baseline median. */
    minimumPercentChange: z.number().min(0).max(80).default(15),
    direction: z.enum(['above', 'below', 'either']).default('below'),
    cooldownDays: z.number().int().min(0).max(30).default(7),
  })
  .refine((c) => c.minimumSamples <= c.baselineDays, {
    message: 'minimumSamples cannot exceed baselineDays',
  });

const morningBrief = z
  .strictObject({
    enabled: z.boolean().default(true),
    /** Send as soon as last night's data is ready, but not before this. */
    earliest: clockTime.default('07:30'),
    /** Send with whatever is available once this time passes. */
    latest: clockTime.default('11:00'),
  })
  .refine((c) => parseClock(c.earliest) < parseClock(c.latest), {
    message: 'earliest must be before latest',
  });

const serviceHealth = z.strictObject({
  enabled: z.boolean().default(true),
  /** Consecutive checks without a successful Google sync before alerting. */
  failedChecksBeforeAlert: z.number().int().min(2).max(144).default(6),
  /**
   * Set while the Google OAuth app is in "Testing" (refresh tokens expire after
   * 7 days) to get a reminder a day before access lapses. Null: no expiry known.
   */
  refreshTokenLifetimeDays: z.number().int().min(2).max(365).nullable().default(null),
  /** When false, service alerts raised overnight are held until waking hours. */
  notifyDuringSleepHours: z.boolean().default(false),
});

export const configSchema = z.strictObject({
  schedule: z
    .strictObject({
      /** Waking hours. Inactivity is only evaluated, and alerts only sent, inside them. */
      wakeTime: clockTime.default('07:00'),
      sleepTime: clockTime.default('23:00'),
    })
    .refine((c) => c.wakeTime !== c.sleepTime, { message: 'wakeTime and sleepTime must differ' })
    .prefault({}),
  rules: z
    .strictObject({
      deviceOffWrist: deviceOffWrist.prefault({}),
      inactivity: inactivity.prefault({}),
      sleep: sleep.prefault({}),
      restingHeartRate: restingHeartRate.prefault({}),
      hrv: hrv.prefault({}),
      morningBrief: morningBrief.prefault({}),
      serviceHealth: serviceHealth.prefault({}),
    })
    .prefault({}),
  notifications: z
    .strictObject({
      /** Delivery attempts per notification before it is marked failed. */
      maxAttempts: z.number().int().min(1).max(10).default(5),
      /** Safety valve: notifications created per rolling 24 hours. */
      maxPerDay: z.number().int().min(1).max(100).default(24),
    })
    .prefault({}),
  retention: z
    .strictObject({
      dailyMetricsDays: z.number().int().min(45).max(730).default(120),
      notificationDays: z.number().int().min(1).max(90).default(30),
      runDays: z.number().int().min(1).max(60).default(14),
    })
    .prefault({}),
});

export type PulseWatchConfig = z.infer<typeof configSchema>;
export type RulesConfig = PulseWatchConfig['rules'];

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Parses configuration overrides. Accepts an object (Wrangler JSON vars) or
 * a JSON string. Error messages list offending paths but never values.
 */
export function parseConfig(input: unknown): PulseWatchConfig {
  let value: unknown = input ?? {};
  if (typeof value === 'string') {
    try {
      value = value.trim() === '' ? {} : (JSON.parse(value) as unknown);
    } catch {
      throw new ConfigError('PULSEWATCH_CONFIG is not valid JSON');
    }
  }
  const result = configSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid PULSEWATCH_CONFIG: ${issues}`);
  }
  return result.data;
}

export const defaultConfig: PulseWatchConfig = parseConfig({});
