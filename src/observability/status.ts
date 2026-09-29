import type { Settings } from '../env';
import { DAY_MS, MINUTE_MS, type EpochMs } from '../domain/types';
import { RULES } from '../rules/engine';
import { countDailyValues, loadBaselines } from '../storage/metrics';
import { OPS, OpsStore } from '../storage/ops';

/**
 * Operational status. Everything here is safe to show on a dashboard:
 * timestamps, states, counters and error codes — no heart rate, HRV, sleep
 * or step values, no tokens, no topic name.
 */

/** A check older than this means the cron trigger has stopped firing. */
export const HEALTHY_CHECK_AGE_MS = 25 * MINUTE_MS;

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString());

export async function publicHealth(
  db: D1Database,
  now: EpochMs,
): Promise<{ status: string; httpStatus: number }> {
  try {
    const row = await db
      .prepare('SELECT value FROM ops WHERE key = ?')
      .bind(OPS.lastCheckAt)
      .first<{ value: string }>();
    if (!row) return { status: 'starting', httpStatus: 200 };
    const healthy = now - Number(row.value) < HEALTHY_CHECK_AGE_MS;
    return { status: healthy ? 'ok' : 'degraded', httpStatus: healthy ? 200 : 503 };
  } catch {
    return { status: 'degraded', httpStatus: 503 };
  }
}

export async function operationalStatus(
  db: D1Database,
  settings: Settings,
  now: EpochMs,
): Promise<Record<string, unknown>> {
  const [ops, notificationCounts, runStats, recentRuns, dailyCounts, baselines] = await Promise.all([
    OpsStore.load(db),
    db
      .prepare('SELECT status, COUNT(*) AS n FROM notifications WHERE created_at >= ? GROUP BY status')
      .bind(now - 7 * DAY_MS)
      .all<{ status: string; n: number }>(),
    db
      .prepare(
        'SELECT outcome, COUNT(*) AS n, SUM(api_calls) AS calls, SUM(api_failures) AS failures ' +
          'FROM runs WHERE started_at >= ? GROUP BY outcome',
      )
      .bind(now - DAY_MS)
      .all<{ outcome: string; n: number; calls: number | null; failures: number | null }>(),
    db
      .prepare("SELECT rule_summary FROM runs WHERE outcome <> 'running' ORDER BY started_at DESC LIMIT 12")
      .all<{ rule_summary: string | null }>(),
    countDailyValues(db),
    loadBaselines(db),
  ]);

  const num = (key: Parameters<OpsStore['getNumber']>[0]) => ops.getNumber(key);
  const lastCheckAt = num(OPS.lastCheckAt);
  // Wear checks (every minute) evaluate only the off-wrist rule, so take each
  // rule's newest result from the recent runs; 12 always include a full check.
  const ruleSummary: Record<string, string> = {};
  for (const run of recentRuns.results) {
    try {
      const summary = run.rule_summary ? (JSON.parse(run.rule_summary) as Record<string, string>) : {};
      for (const [ruleId, result] of Object.entries(summary)) ruleSummary[ruleId] ??= result;
    } catch {
      // A malformed row is skipped; older rows still fill in.
    }
  }

  const runs24h = { total: 0, ok: 0, degraded: 0, failed: 0, apiCalls: 0, apiFailures: 0 };
  for (const row of runStats.results) {
    runs24h.total += row.n;
    if (row.outcome === 'ok' || row.outcome === 'degraded' || row.outcome === 'failed')
      runs24h[row.outcome] += row.n;
    runs24h.apiCalls += row.calls ?? 0;
    runs24h.apiFailures += row.failures ?? 0;
  }

  return {
    service: 'pulsewatch',
    mode: settings.mode,
    generatedAt: iso(now),
    scheduler: {
      lastCheckAt: iso(lastCheckAt),
      lastCheckOutcome: ops.get(OPS.lastCheckOutcome),
      healthy: lastCheckAt !== null && now - lastCheckAt < HEALTHY_CHECK_AGE_MS,
      runsLast24h: runs24h,
    },
    google: {
      auth:
        settings.mode === 'demo'
          ? 'demo'
          : settings.google
            ? (ops.get(OPS.authStatus) ?? 'unknown')
            : 'not_configured',
      lastSuccessfulSyncAt: iso(num(OPS.googleLastSuccessAt)),
      consecutiveFailedChecks: num(OPS.googleConsecutiveFailures) ?? 0,
      failuresTotal: num(OPS.googleFailuresTotal) ?? 0,
      lastError: ops.get(OPS.googleLastErrorCode),
      lastErrorAt: iso(num(OPS.googleLastErrorAt)),
      // When the current credentials were first used, and (in Testing mode) when they lapse.
      credentialsInUseSince: iso(num(OPS.authCurrentSince)),
      estimatedCredentialExpiry: (() => {
        const since = num(OPS.authCurrentSince);
        const days = settings.config.rules.serviceHealth.refreshTokenLifetimeDays;
        return since === null || days === null ? null : iso(since + days * DAY_MS);
      })(),
    },
    device: {
      lastSyncObservedAt: iso(num(OPS.deviceLastSyncAt)),
      batteryStatus: ops.get(OPS.deviceBatteryStatus),
      model: ops.get(OPS.deviceModel),
    },
    wearState: ruleSummary.deviceOffWrist ?? null,
    rules: RULES.map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: (rule.selectConfig(settings.config.rules) as { enabled: boolean }).enabled,
      lastResult: ruleSummary[rule.id] ?? null,
    })),
    notifications: {
      byStatusLast7Days: Object.fromEntries(notificationCounts.results.map((r) => [r.status, r.n])),
      sentTotal: num(OPS.notifySentTotal) ?? 0,
      failedTotal: num(OPS.notifyFailedTotal) ?? 0,
      retriesTotal: num(OPS.notifyRetriesTotal) ?? 0,
      rateLimitedTotal: num(OPS.notifyRateLimitedTotal) ?? 0,
      quotaExhaustedTotal: num(OPS.notifyQuotaExhaustedTotal) ?? 0,
      suppressedTotal: num(OPS.notifySuppressedTotal) ?? 0,
      lastSuccessAt: iso(num(OPS.notifyLastSuccessAt)),
      lastFailureAt: iso(num(OPS.notifyLastFailureAt)),
      lastFailureCode: ops.get(OPS.notifyLastFailureCode),
    },
    queue: {
      sendFailuresTotal: num(OPS.queueSendFailuresTotal) ?? 0,
      duplicateDeliveriesTotal: num(OPS.queueDuplicateDeliveriesTotal) ?? 0,
      invalidMessagesTotal: num(OPS.queueInvalidMessagesTotal) ?? 0,
    },
    dailySync: {
      lastAttemptAt: iso(num(OPS.dailyLastAttemptAt)),
      completeForDay: ops.get(OPS.dailyCompleteDay),
      backfilledAt: iso(num(OPS.dailyBackfilledAt)),
      storedDaysByMetric: dailyCounts,
    },
    // Readiness only: sample counts and dates, never the baseline values.
    baselines: Object.fromEntries(
      baselines.map((b) => [b.metric, { samples: b.samples, computedFor: b.computedFor }]),
    ),
    retention: settings.config.retention,
  };
}
