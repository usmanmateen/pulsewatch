import type { z } from 'zod';
import type { DailyPoint } from '../baseline/stats';
import type { PulseWatchConfig, RulesConfig } from '../config/schema';
import type { ActivityWindow, DailyMetric, DeviceStatus, EpochMs, LocalDate } from '../domain/types';
import type { Mode } from '../env';
import type { Baseline } from '../baseline/baseline';

export type RuleId =
  'deviceOffWrist' | 'inactivity' | 'sleep' | 'restingHeartRate' | 'hrv' | 'morningBrief' | 'serviceHealth';

export type Severity = 'info' | 'notice' | 'warning';

/**
 * What a rule wants delivered. Rules never talk to a provider; the pipeline
 * persists intents in the D1 outbox and the queue consumer delivers them.
 */
export interface NotificationIntent {
  /** Deterministic: the same event always produces the same id (the dedup key). */
  id: string;
  ruleId: RuleId;
  severity: Severity;
  title: string;
  body: string;
  /** Emoji shortcodes; ntfy renders them in front of the title. */
  tags: string[];
  /** An undelivered notification is dropped once it is this old. */
  ttlMinutes: number;
}

export type RuleStatus =
  'ok' | 'pending' | 'alerting' | 'insufficient_data' | 'not_due' | 'disabled' | 'error';

export interface RuleOutcome<S> {
  state: S;
  status: RuleStatus;
  /** Short machine-readable detail for /status and logs. Never a health value. */
  detail?: string;
  notifications?: NotificationIntent[];
  /**
   * Notification ids whose subject has resolved. Undelivered ones are
   * cancelled; delivered ones are cleared from the phone where supported.
   */
  resolved?: string[];
}

/** Result of fetching one kind of data this check. */
export type Observation<T> =
  { status: 'ok'; value: T } | { status: 'unavailable'; reason: string } | { status: 'not_requested' };

export interface Observations {
  /** Timestamp of the newest heart-rate sample (null: none in the lookback window). */
  heartRate: Observation<{ latestAt: EpochMs | null }>;
  /** The paired tracker (null: none paired). */
  device: Observation<DeviceStatus | null>;
  activity: Observation<ActivityWindow[]>;
}

export interface StoredBaseline extends Baseline {
  metric: DailyMetric;
  computedFor: LocalDate;
}

/** Daily aggregates and baselines, loaded from D1 only when a daily rule needs them. */
export interface DailyView {
  today: LocalDate;
  /** Whether today's daily sync has captured last night's data. */
  syncComplete: boolean;
  series(metric: DailyMetric): DailyPoint[];
  value(metric: DailyMetric, day: LocalDate): number | null;
  baseline(metric: DailyMetric): StoredBaseline | null;
  baselineSamples(metric: DailyMetric): number;
}

export type AuthStatus = 'ok' | 'not_configured' | 'reauthorization_required' | 'misconfigured';

/** Facts about PulseWatch itself, for the self-monitoring rule. */
export interface SystemFacts {
  mode: Mode;
  auth: AuthStatus;
  credentialFingerprint: string | null;
  consecutiveFailedChecks: number;
  lastSuccessfulSyncAt: EpochMs | null;
  /** How long the current Google credentials have been in use (null if unknown). */
  credentialAgeMs: number | null;
}

export type DataRequirement = 'heartRate' | 'device' | 'activity' | 'daily';

export type RulesConfigSlice<K extends keyof RulesConfig> = RulesConfig[K];

export type Schedule = PulseWatchConfig['schedule'];

export interface RuleContext<C, S> {
  now: EpochMs;
  timeZone: string;
  schedule: Schedule;
  config: C;
  state: S;
  observations: Observations;
  daily: DailyView | null;
  system: SystemFacts;
}

export interface NeedsInput<C, S> {
  now: EpochMs;
  timeZone: string;
  schedule: Schedule;
  config: C;
  state: S;
}

export interface HealthRule<C extends { enabled: boolean }, S> {
  readonly id: RuleId;
  readonly name: string;
  readonly description: string;
  readonly severity: Severity;
  /** Validates persisted state; a schema mismatch resets to `initialState`. */
  readonly stateSchema: z.ZodType<S>;
  initialState(): S;
  selectConfig(rules: RulesConfig): C;
  /** Data this check must fetch for the rule. Keeps the 10-minute job lean. */
  needs(input: NeedsInput<C, S>): readonly DataRequirement[];
  /** Pure: no I/O, no clock reads, no randomness. */
  evaluate(context: RuleContext<C, S>): RuleOutcome<S>;
}

// Rules have different config/state types; the registry stores them erased.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHealthRule = HealthRule<any, any>;
