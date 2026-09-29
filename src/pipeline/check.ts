import type { StoredBaseline } from '../rules/types';
import { localDate, minutesOfDay } from '../domain/time';
import { DAILY_METRICS, DAY_MS, HOUR_MS, MINUTE_MS, type DailyValue, type EpochMs } from '../domain/types';
import type { Settings } from '../env';
import type { GoogleHealthClient } from '../google/client';
import { GoogleApiError } from '../google/http';
import { OAuthError } from '../google/oauth';
import {
  countAlertsSince,
  dispatchPending,
  insertIntentStatements,
  resolveStatements,
  type NotificationQueue,
} from '../notifications/outbox';
import { errorCode, type Logger } from '../observability/log';
import { RULES, collectNeeds, evaluateRules } from '../rules/engine';
import { ACTIVITY_WINDOW_MINUTES } from '../rules/inactivity';
import { HEART_RATE_LOOKBACK_HOURS, deviceOffWristRule } from '../rules/off-wrist/rule';
import type {
  AnyHealthRule,
  AuthStatus,
  DailyView,
  DataRequirement,
  Observation,
  Observations,
} from '../rules/types';
import {
  loadBaselines,
  loadDailyValues,
  saveBaselinesStatement,
  upsertDailyValuesStatement,
} from '../storage/metrics';
import { OPS, OpsStore, incrementStatement, setStatement } from '../storage/ops';
import { applyRetention } from '../storage/retention';
import { loadRuleStates, saveRuleStateStatement } from '../storage/rule-state';
import { beginRun, finishRunStatement, type RunOutcome, type RunTrigger } from '../storage/runs';
import {
  BACKFILL_DAYS,
  REFRESH_DAYS,
  computeDailyBaselines,
  createDailyView,
  dailySyncDue,
  fetchDailyData,
  historyStart,
  isDailyComplete,
} from './daily';

export interface CheckDependencies {
  db: D1Database;
  queue: NotificationQueue;
  settings: Settings;
  /** Null in live mode until the OAuth bootstrap has stored credentials. */
  health: GoogleHealthClient | null;
  /** Hash of the configured Google credentials; detects a replaced secret. */
  credentialFingerprint: string | null;
  canClearNotifications: boolean;
  now: () => EpochMs;
  log: Logger;
  rules?: readonly AnyHealthRule[];
}

/**
 * full: every rule, the daily sync and retention (every 10 minutes, and manual runs).
 * wear: only the off-wrist rule, as cheaply as possible (the other minutes):
 * one API call while the tracker is worn, two once heart rate goes quiet.
 */
export type CheckScope = 'full' | 'wear';

export interface CheckTrigger {
  kind: RunTrigger;
  /** For cron runs: the scheduled time, which identifies the slot. */
  scheduledTime?: EpochMs;
  scope?: CheckScope;
}

/** Cron runs every minute; each tenth minute is a full check, the rest are wear checks. */
export function scopeForSlot(scheduledTime: EpochMs): CheckScope {
  return new Date(scheduledTime).getUTCMinutes() % 10 === 0 ? 'full' : 'wear';
}

export interface CheckResult {
  runId: string;
  skipped: boolean;
  outcome: RunOutcome;
  /** ruleId → "status[:detail]". Codes only, no health values. */
  rules: Record<string, string>;
  notificationsCreated: number;
  enqueued: number;
}

const NOT_REQUESTED = { status: 'not_requested' } as const;

/** Tracks Google API outcomes across the parallel fetches of one check. */
class FetchTracker {
  successes = 0;
  readonly failures: string[] = [];
  authError: OAuthError | null = null;

  success(): void {
    this.successes += 1;
  }

  failure(name: string, error: unknown): void {
    if (error instanceof OAuthError && error.kind !== 'transient') this.authError = error;
    this.failures.push(
      `${name}:${errorCode(error)}${error instanceof GoogleApiError && error.status ? `_${error.status}` : ''}`,
    );
  }
}

function resolveAuthStatus(settings: Settings, ops: OpsStore, fingerprint: string | null): AuthStatus {
  if (settings.mode === 'demo') return 'ok';
  if (!settings.google) return 'not_configured';
  const stored = ops.get(OPS.authStatus);
  // Circuit breaker: once Google rejects these exact credentials, stop calling
  // until the secret changes (the fingerprint then differs).
  if (
    (stored === 'reauthorization_required' || stored === 'misconfigured') &&
    ops.get(OPS.authFingerprint) === fingerprint
  ) {
    return stored;
  }
  return 'ok';
}

/** Activity windows cover the inactivity threshold plus an hour, aligned to 5-minute boundaries. */
export function activityRange(now: EpochMs, thresholdMinutes: number): { start: EpochMs; end: EpochMs } {
  const windowMs = ACTIVITY_WINDOW_MINUTES * MINUTE_MS;
  const end = Math.floor(now / windowMs) * windowMs;
  const spanWindows = Math.ceil((thresholdMinutes + 60) / ACTIVITY_WINDOW_MINUTES);
  return { start: end - spanWindows * windowMs, end };
}

function mergeDaily(stored: readonly DailyValue[], fresh: readonly DailyValue[]): DailyValue[] {
  const byKey = new Map(stored.map((v) => [`${v.metric}|${v.day}`, v]));
  for (const value of fresh) byKey.set(`${value.metric}|${value.day}`, value);
  return [...byKey.values()];
}

export async function runCheck(deps: CheckDependencies, trigger: CheckTrigger): Promise<CheckResult> {
  const { db, settings } = deps;
  const scope = trigger.scope ?? 'full';
  const rules = (deps.rules ?? RULES).filter((rule) => scope === 'full' || rule.id === deviceOffWristRule.id);
  const now = deps.now();
  const runId =
    trigger.kind === 'cron'
      ? `cron:${trigger.scheduledTime ?? now}`
      : `${trigger.kind}:${now}:${crypto.randomUUID().slice(0, 8)}`;
  const log = deps.log.child({ run: runId });

  if (!(await beginRun(db, runId, trigger.kind, now))) {
    log.info('check.duplicate_skipped');
    return { runId, skipped: true, outcome: 'skipped', rules: {}, notificationsCreated: 0, enqueued: 0 };
  }

  const [ops, storedStates] = await Promise.all([OpsStore.load(db), loadRuleStates(db)]);
  const states = new Map([...storedStates].map(([id, stored]) => [id, stored.state]));
  const { config, timeZone } = settings;
  const today = localDate(now, timeZone);

  let auth = resolveAuthStatus(settings, ops, deps.credentialFingerprint);
  const health = auth === 'ok' ? deps.health : null;
  const tracker = new FetchTracker();

  // 1. Fetch only what the enabled rules need right now.
  const needs = collectNeeds(rules, config, states, now, timeZone);
  const observe = async <T>(
    need: DataRequirement,
    name: string,
    fetch: (client: GoogleHealthClient) => Promise<T>,
  ): Promise<Observation<T>> => {
    if (!needs.has(need)) return NOT_REQUESTED;
    if (!health) return { status: 'unavailable', reason: auth };
    try {
      const value = await fetch(health);
      tracker.success();
      return { status: 'ok', value };
    } catch (error) {
      tracker.failure(name, error);
      return { status: 'unavailable', reason: errorCode(error) };
    }
  };
  const activityWindow = activityRange(now, config.rules.inactivity.thresholdMinutes);
  const fetchHeartRate = () =>
    observe('heartRate', 'heart_rate', async (client) => ({
      latestAt: await client.latestHeartRateAt(now, HEART_RATE_LOOKBACK_HOURS * HOUR_MS),
    }));
  const fetchDevice = () => observe('device', 'device', (client) => client.pairedTracker());
  let heartRate: Observations['heartRate'];
  let device: Observations['device'];
  let activity: Observations['activity'] = NOT_REQUESTED;
  if (scope === 'wear') {
    // Recent heart rate means worn: the device (sync time, battery) only
    // matters once it goes quiet.
    heartRate = await fetchHeartRate();
    const staleAfter = config.rules.deviceOffWrist.staleAfterMinutes * MINUTE_MS;
    const worn =
      heartRate.status === 'ok' &&
      heartRate.value.latestAt !== null &&
      now - heartRate.value.latestAt < staleAfter;
    device = worn ? NOT_REQUESTED : await fetchDevice();
  } else {
    [heartRate, device, activity] = await Promise.all([
      fetchHeartRate(),
      fetchDevice(),
      observe('activity', 'activity', (client) =>
        client.activityWindows(activityWindow.start, activityWindow.end, ACTIVITY_WINDOW_MINUTES),
      ),
    ]);
  }
  const observations: Observations = { heartRate, device, activity };

  // 2. Daily sync: backfill once, then refresh until last night's data lands.
  let fetchedDaily: DailyValue[] = [];
  let dailySynced = false;
  let dailyComplete = ops.get(OPS.dailyCompleteDay) === today;
  const backfilled = ops.get(OPS.dailyBackfilledAt) !== null;
  if (
    scope === 'full' &&
    health &&
    tracker.authError === null &&
    dailySyncDue({
      now,
      today,
      minuteOfDay: minutesOfDay(now, timeZone),
      config,
      completeDay: ops.get(OPS.dailyCompleteDay),
      lastAttemptAt: ops.getNumber(OPS.dailyLastAttemptAt),
      backfilled,
    })
  ) {
    const result = await fetchDailyData(
      health,
      today,
      now,
      timeZone,
      backfilled ? REFRESH_DAYS : BACKFILL_DAYS,
    );
    ops.set(OPS.dailyLastAttemptAt, now);
    for (let i = 0; i < result.successes; i++) tracker.success();
    for (const failure of result.failures) tracker.failures.push(failure);
    if (result.successes > 0) {
      fetchedDaily = result.values;
      dailySynced = true;
      if (!backfilled && result.failures.length === 0) ops.set(OPS.dailyBackfilledAt, now);
    }
    if (isDailyComplete(result.values, today)) {
      dailyComplete = true;
      ops.set(OPS.dailyCompleteDay, today);
    }
  }

  // 3. Daily view, only when a daily rule needs it or new daily data arrived.
  let daily: DailyView | null = null;
  let baselinesToSave: StoredBaseline[] = [];
  if (needs.has('daily') || dailySynced) {
    const [stored, storedBaselines] = await Promise.all([
      loadDailyValues(db, DAILY_METRICS, historyStart(today, config)),
      loadBaselines(db),
    ]);
    const values = mergeDaily(stored, fetchedDaily);
    let baselines = storedBaselines;
    if (dailySynced) {
      baselinesToSave = computeDailyBaselines(values, today, config);
      const fresh = new Set(baselinesToSave.map((b) => b.metric));
      baselines = [...baselinesToSave, ...storedBaselines.filter((b) => !fresh.has(b.metric))];
    }
    daily = createDailyView(today, values, baselines, dailyComplete);
  }

  // 4. Authorisation and Google health bookkeeping.
  if (tracker.authError) {
    auth =
      tracker.authError.kind === 'reauthorization_required' ? 'reauthorization_required' : 'misconfigured';
    ops.set(OPS.authStatus, auth);
    ops.set(OPS.authFingerprint, deps.credentialFingerprint ?? '');
    log.error('auth.rejected', { kind: tracker.authError.kind });
  } else if (health && tracker.successes > 0 && settings.mode === 'live') {
    ops.set(OPS.authStatus, 'ok');
  }
  const attempted = tracker.successes + tracker.failures.length > 0;
  let consecutiveFailures = ops.getNumber(OPS.googleConsecutiveFailures) ?? 0;
  if (attempted) {
    if (tracker.successes > 0) {
      consecutiveFailures = 0;
      ops.set(OPS.googleLastSuccessAt, now);
    } else if (scope === 'full') {
      // Counted per full check (every 10 minutes), so the outage alert keeps
      // its meaning although wear checks run every minute.
      consecutiveFailures += 1;
    }
    ops.set(OPS.googleConsecutiveFailures, consecutiveFailures);
  }
  if (tracker.failures.length > 0) {
    ops.set(OPS.googleLastErrorCode, tracker.failures[0]!);
    ops.set(OPS.googleLastErrorAt, now);
    ops.increment(OPS.googleFailuresTotal, tracker.failures.length);
    log.warn('google.fetch_failed', { failures: tracker.failures.join(','), count: tracker.failures.length });
  }
  // Remember when the current credentials first appeared, to anticipate a
  // Testing-mode refresh token expiring.
  if (deps.credentialFingerprint && ops.get(OPS.authCurrentFingerprint) !== deps.credentialFingerprint) {
    ops.set(OPS.authCurrentFingerprint, deps.credentialFingerprint);
    ops.set(OPS.authCurrentSince, now);
  }
  const credentialSince = deps.credentialFingerprint ? ops.getNumber(OPS.authCurrentSince) : null;
  if (device.status === 'ok' && device.value) {
    if (device.value.lastSyncAt !== null) ops.set(OPS.deviceLastSyncAt, device.value.lastSyncAt);
    if (device.value.batteryStatus) ops.set(OPS.deviceBatteryStatus, device.value.batteryStatus);
    if (device.value.model) ops.set(OPS.deviceModel, device.value.model);
  }

  // 5. Rules.
  const evaluation = evaluateRules(rules, {
    now,
    timeZone,
    config,
    observations,
    daily,
    system: {
      mode: settings.mode,
      auth,
      credentialFingerprint: deps.credentialFingerprint,
      consecutiveFailedChecks: consecutiveFailures,
      lastSuccessfulSyncAt: ops.getNumber(OPS.googleLastSuccessAt),
      credentialAgeMs: credentialSince === null ? null : now - credentialSince,
    },
    states,
    log,
  });

  // 6. Safety valve against a runaway rule: cap alerts per rolling day.
  const intents = evaluation.notifications;
  const suppressed = new Set<string>();
  if (intents.length > 0) {
    const recent = await countAlertsSince(db, now - DAY_MS);
    const allowance = Math.max(0, config.notifications.maxPerDay - recent);
    for (const intent of intents.slice(allowance)) suppressed.add(intent.id);
    if (suppressed.size > 0) {
      ops.increment(OPS.notifySuppressedTotal, suppressed.size);
      log.warn('notification.budget_exceeded', { suppressed: suppressed.size });
    }
  }

  const failedCompletely = attempted && tracker.successes === 0;
  const outcome: RunOutcome = failedCompletely
    ? 'failed'
    : tracker.failures.length > 0 || auth !== 'ok'
      ? 'degraded'
      : 'ok';
  const ruleSummary = Object.fromEntries(
    evaluation.evaluations.map((e) => [e.ruleId, e.detail ? `${e.status}:${e.detail}` : e.status]),
  );
  ops.set(OPS.lastCheckAt, now);
  ops.set(OPS.lastCheckOutcome, outcome);

  // 7. Commit state, outbox and bookkeeping in one D1 transaction.
  const changed = evaluation.evaluations.filter((e) => e.changed);
  const statements = [
    ...changed.map((e) =>
      saveRuleStateStatement(db, e.ruleId, e.state, storedStates.get(e.ruleId)?.version ?? null, now),
    ),
    ...insertIntentStatements(db, intents, now, suppressed),
    ...resolveStatements(db, evaluation.resolved, now, deps.canClearNotifications),
    upsertDailyValuesStatement(db, fetchedDaily, now),
    saveBaselinesStatement(db, baselinesToSave, now),
    ...ops.statements(db, now),
    finishRunStatement(
      db,
      runId,
      {
        outcome,
        apiCalls: deps.health?.stats.calls ?? 0,
        apiFailures: tracker.failures.length,
        notifications: intents.length - suppressed.size,
        rules: ruleSummary,
      },
      now,
    ),
  ].filter((statement): statement is D1PreparedStatement => statement !== null);
  const results = await db.batch(statements);
  const conflicts = changed.filter((_, i) => (results[i]?.meta.changes ?? 1) === 0).map((e) => e.ruleId);
  if (conflicts.length > 0) log.warn('rule.state_conflict', { rules: conflicts.join(',') });

  // 8. Hand new notifications to the queue (and re-send any lost messages).
  const dispatch = await dispatchPending(db, deps.queue, now);
  if (dispatch.queueError) {
    await incrementStatement(db, OPS.queueSendFailuresTotal, now).run();
    log.error('queue.send_failed');
  }

  // 9. Retention, once per local day (full checks only).
  if (scope === 'full' && ops.get(OPS.retentionLastDay) !== today) {
    try {
      const removed = await applyRetention(db, now, today, config.retention);
      await setStatement(db, OPS.retentionLastDay, today, now).run();
      log.info('retention.applied', { ...removed });
    } catch (error) {
      log.error('retention.failed', { error: errorCode(error) });
    }
  }

  log.info('check.completed', {
    trigger: trigger.kind,
    scope,
    outcome,
    apiCalls: deps.health?.stats.calls ?? 0,
    apiFailures: tracker.failures.length,
    dailySynced,
    notifications: intents.length - suppressed.size,
    enqueued: dispatch.enqueued,
    wear: evaluation.evaluations.find((e) => e.ruleId === 'deviceOffWrist')?.detail ?? null,
  });

  return {
    runId,
    skipped: false,
    outcome,
    rules: ruleSummary,
    notificationsCreated: intents.length - suppressed.size,
    enqueued: dispatch.enqueued,
  };
}
