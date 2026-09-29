import { addDays, localDate, utcOffsetMinutes, zonedTimeToEpoch } from '../domain/time';
import { MINUTE_MS, type BatteryStatus, type EpochMs, type LocalDate } from '../domain/types';

/**
 * A deterministic synthetic wearer. Everything is computed from the spec
 * and a seed, so the same scenario always produces the same data — and none
 * of it is anyone's real health information.
 */

export interface Interval {
  start: EpochMs;
  end: EpochMs;
}

export interface Profile {
  restingHr: number;
  hrvMs: number;
  respiratoryRate: number;
  sleepMinutes: number;
  /** Minutes relative to local midnight of the wake-up day (negative = before midnight). */
  bedtimeMinutes: number;
  dailySteps: number;
}

export type OverridableMetric = 'resting_hr' | 'hrv' | 'respiratory_rate' | 'sleep_minutes';

export interface WorldSpec {
  timeZone: string;
  seed: number;
  deviceModel: string;
  /** The simulated "today". */
  today: LocalDate;
  historyDays: number;
  profile: Profile;
  /** metric → (day offset from today → value). */
  dailyOverrides: Partial<Record<OverridableMetric, Record<number, number>>>;
  offWrist: Interval[];
  syncOutages: Interval[];
  sedentary: Interval[];
  /** Deliberate walks (~100 steps/min), e.g. the movement break ending a still period. */
  walks?: Interval[];
  /** Piecewise-linear battery level; the tracker is dead while it is 0. */
  battery: Array<{ at: EpochMs; level: number }>;
  syncIntervalMinutes: number;
  /** Delay between waking up and Google finishing sleep processing. */
  sleepProcessingMinutes: number;
}

export const DEFAULT_PROFILE: Profile = {
  restingHr: 57,
  hrvMs: 52,
  respiratoryRate: 14.6,
  sleepMinutes: 438,
  bedtimeMinutes: -55,
  dailySteps: 9200,
};

/** FNV-1a string hash → 32-bit seed. */
export function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, good enough for synthetic data. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const within = (t: EpochMs, intervals: readonly Interval[]): boolean =>
  intervals.some((interval) => t >= interval.start && t < interval.end);

export interface SyntheticSleep {
  day: LocalDate;
  start: EpochMs;
  end: EpochMs;
  startOffsetMinutes: number;
  endOffsetMinutes: number;
  minutesAsleep: number;
  minutesInPeriod: number;
}

export class SyntheticWorld {
  constructor(readonly spec: WorldSpec) {}

  /** Deterministic noise in [-1, 1] for a key. */
  noise(key: string): number {
    return seededRandom(hashString(`${this.spec.seed}:${key}`))() * 2 - 1;
  }

  dayOffset(day: LocalDate): number {
    const a = Date.parse(`${this.spec.today}T12:00:00Z`);
    const b = Date.parse(`${day}T12:00:00Z`);
    return Math.round((b - a) / 86_400_000);
  }

  private override(metric: OverridableMetric, day: LocalDate): number | undefined {
    return this.spec.dailyOverrides[metric]?.[this.dayOffset(day)];
  }

  batteryAt(t: EpochMs): number {
    const points = this.spec.battery;
    if (points.length === 0) return 80;
    if (t <= points[0]!.at) return points[0]!.level;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      if (t <= b.at) return a.level + ((b.level - a.level) * (t - a.at)) / (b.at - a.at);
    }
    return points.at(-1)!.level;
  }

  static batteryStatus(level: number): BatteryStatus {
    if (level <= 5) return 'EMPTY';
    if (level <= 20) return 'LOW';
    if (level <= 60) return 'MEDIUM';
    return 'HIGH';
  }

  isDead(t: EpochMs): boolean {
    return this.batteryAt(t) <= 0;
  }

  isWorn(t: EpochMs): boolean {
    return !this.isDead(t) && !within(t, this.spec.offWrist);
  }

  /** The tracker's most recent sync at or before `t`. */
  lastSyncAt(t: EpochMs): EpochMs | null {
    const interval = this.spec.syncIntervalMinutes * MINUTE_MS;
    const phase = 3 * MINUTE_MS;
    let candidate = Math.floor((t - phase) / interval) * interval + phase;
    for (let i = 0; i < 400; i++, candidate -= interval) {
      if (candidate > t) continue;
      if (!within(candidate, this.spec.syncOutages) && !this.isDead(candidate)) return candidate;
    }
    return null;
  }

  sleepFor(day: LocalDate): SyntheticSleep {
    const tz = this.spec.timeZone;
    const minutesAsleep = Math.round(
      this.override('sleep_minutes', day) ?? this.spec.profile.sleepMinutes + this.noise(`sleep:${day}`) * 25,
    );
    const bedtime = Math.round(this.spec.profile.bedtimeMinutes + this.noise(`bed:${day}`) * 20);
    const minutesInPeriod = minutesAsleep + 30 + Math.round(Math.abs(this.noise(`awake:${day}`)) * 15);
    const start = zonedTimeToEpoch(day, bedtime, tz);
    const end = start + minutesInPeriod * MINUTE_MS;
    return {
      day,
      start,
      end,
      startOffsetMinutes: utcOffsetMinutes(start, tz),
      endOffsetMinutes: utcOffsetMinutes(end, tz),
      minutesAsleep,
      minutesInPeriod,
    };
  }

  isAsleep(t: EpochMs): boolean {
    const day = localDate(t, this.spec.timeZone);
    for (const d of [day, addDays(day, 1)]) {
      const sleep = this.sleepFor(d);
      if (t >= sleep.start && t < sleep.end) return true;
    }
    return false;
  }

  /** Whether Google would have processed the sleep ending on `day` by `now`. */
  sleepProcessed(day: LocalDate, now: EpochMs): boolean {
    const sleep = this.sleepFor(day);
    const visibleUntil = this.lastSyncAt(now) ?? 0;
    return sleep.end <= visibleUntil && sleep.end + this.spec.sleepProcessingMinutes * MINUTE_MS <= now;
  }

  dailyValue(metric: 'resting_hr' | 'hrv' | 'respiratory_rate', day: LocalDate): number {
    const value = this.override(metric, day);
    if (value !== undefined) return value;
    const n = this.noise(`${metric}:${day}`);
    const p = this.spec.profile;
    if (metric === 'resting_hr') return Math.round(p.restingHr + n * 1.6);
    if (metric === 'hrv') return Math.round(p.hrvMs * Math.exp(n * 0.1) * 10) / 10;
    return Math.round((p.respiratoryRate + n * 0.35) * 10) / 10;
  }

  dailySteps(day: LocalDate): number {
    return Math.max(0, Math.round(this.spec.profile.dailySteps + this.noise(`steps:${day}`) * 1600));
  }

  /** Steps in the minute starting at `t`. A short walk every 50 minutes while awake. */
  stepsInMinute(t: EpochMs): number {
    if (!this.isWorn(t) || this.isAsleep(t)) return 0;
    const fidget = Math.floor((this.noise(`fidget:${Math.floor(t / MINUTE_MS)}`) + 1) * 3);
    if (within(t, this.spec.walks ?? [])) return 98 + fidget;
    if (within(t, this.spec.sedentary)) return Math.min(fidget, 2);
    const minuteOfCycle = Math.floor(t / MINUTE_MS) % 50;
    return minuteOfCycle < 6 ? 92 + fidget * 2 : fidget;
  }
}
