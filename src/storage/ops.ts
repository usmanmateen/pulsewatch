/**
 * Small operational key/value store (heartbeats, counters, sync bookkeeping).
 * Writes are staged and only keys whose value actually changed are written,
 * keeping D1 row writes proportional to what happened.
 */

export const OPS = {
  lastCheckAt: 'check.last_at',
  lastCheckOutcome: 'check.last_outcome',
  googleLastSuccessAt: 'google.last_success_at',
  googleConsecutiveFailures: 'google.consecutive_failures',
  googleLastErrorCode: 'google.last_error',
  googleLastErrorAt: 'google.last_error_at',
  googleFailuresTotal: 'google.failures_total',
  deviceLastSyncAt: 'device.last_sync_at',
  deviceBatteryStatus: 'device.battery_status',
  deviceModel: 'device.model',
  authStatus: 'auth.status',
  authFingerprint: 'auth.fingerprint',
  authMissingScopes: 'auth.missing_scopes',
  /** Fingerprint of the credentials currently configured, and when they were first seen. */
  authCurrentFingerprint: 'auth.current_fingerprint',
  authCurrentSince: 'auth.current_since',
  dailyLastAttemptAt: 'daily.last_attempt_at',
  dailyCompleteDay: 'daily.complete_day',
  dailyBackfilledAt: 'daily.backfilled_at',
  retentionLastDay: 'retention.last_day',
  notifySentTotal: 'notify.sent_total',
  notifyFailedTotal: 'notify.failed_total',
  notifyRetriesTotal: 'notify.retries_total',
  notifyRateLimitedTotal: 'notify.rate_limited_total',
  notifyQuotaExhaustedTotal: 'notify.quota_exhausted_total',
  notifyLastSuccessAt: 'notify.last_success_at',
  notifyLastFailureAt: 'notify.last_failure_at',
  notifyLastFailureCode: 'notify.last_failure_code',
  notifySuppressedTotal: 'notify.suppressed_total',
  queueSendFailuresTotal: 'queue.send_failures_total',
  queueDuplicateDeliveriesTotal: 'queue.duplicate_deliveries_total',
  queueInvalidMessagesTotal: 'queue.invalid_messages_total',
} as const;

export type OpsKey = (typeof OPS)[keyof typeof OPS];

export class OpsStore {
  private readonly pending = new Map<string, string>();

  constructor(private readonly values: Map<string, string>) {}

  static async load(db: D1Database): Promise<OpsStore> {
    const { results } = await db.prepare('SELECT key, value FROM ops').all<{ key: string; value: string }>();
    return new OpsStore(new Map(results.map((row) => [row.key, row.value])));
  }

  get(key: OpsKey): string | null {
    return this.pending.get(key) ?? this.values.get(key) ?? null;
  }

  getNumber(key: OpsKey): number | null {
    const value = this.get(key);
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  set(key: OpsKey, value: string | number): void {
    const text = String(value);
    if (this.values.get(key) === text) this.pending.delete(key);
    else this.pending.set(key, text);
  }

  increment(key: OpsKey, by = 1): void {
    this.set(key, (this.getNumber(key) ?? 0) + by);
  }

  get changedKeys(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * All staged changes as one statement. D1 queries count towards the free
   * plan's 50-per-invocation limit, so rows are passed as a single JSON array
   * and expanded with json_each.
   */
  statements(db: D1Database, now: number): D1PreparedStatement[] {
    if (this.pending.size === 0) return [];
    return [
      db
        .prepare(
          'INSERT INTO ops (key, value, updated_at) ' +
            "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), ? FROM json_each(?) AS j WHERE true " +
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .bind(now, JSON.stringify([...this.pending])),
    ];
  }

  /** All values (committed plus staged), for the status endpoint. */
  snapshot(): Map<string, string> {
    return new Map([...this.values, ...this.pending]);
  }
}

/**
 * Atomic counter increments / timestamps, used by the queue consumer where
 * several invocations may update the same counters.
 */
export function incrementStatement(db: D1Database, key: OpsKey, now: number, by = 1): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO ops (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(ops.value AS INTEGER) + ? AS TEXT), updated_at = excluded.updated_at',
    )
    .bind(key, String(by), now, by);
}

export function setStatement(
  db: D1Database,
  key: OpsKey,
  value: string | number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO ops (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .bind(key, String(value), now);
}
