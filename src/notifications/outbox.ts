import { MINUTE_MS, type EpochMs } from '../domain/types';
import type { NotificationIntent, Severity } from '../rules/types';
import type { QueueMessageBody } from './types';

/**
 * Transactional outbox in D1. Rules' intents are inserted in the same batch
 * as rule state, so a notification exists if and only if the state that
 * produced it was committed. Delivery happens later via the queue.
 */

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'expired' | 'suppressed';
export const TERMINAL_STATUSES: ReadonlySet<OutboxStatus> = new Set([
  'sent',
  'failed',
  'cancelled',
  'expired',
  'suppressed',
]);

export interface OutboxRow {
  id: string;
  rule_id: string;
  kind: 'alert' | 'clear';
  severity: Severity;
  payload: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number;
  enqueued_at: number | null;
  last_error: string | null;
  provider_ref: string | null;
  created_at: number;
  expires_at: number;
  finished_at: number | null;
}

export interface AlertPayload {
  title: string;
  body: string;
  tags: string[];
}

export interface ClearPayload {
  targetId: string;
}

/** A queue message believed lost is re-sent after this long. */
export const REDISPATCH_AFTER_MS = 15 * MINUTE_MS;
const CLEAR_TTL_MS = 6 * 60 * MINUTE_MS;

export function insertIntentStatements(
  db: D1Database,
  intents: readonly NotificationIntent[],
  now: EpochMs,
  suppressedIds: ReadonlySet<string> = new Set(),
): D1PreparedStatement[] {
  return intents.map((intent) => {
    const suppressed = suppressedIds.has(intent.id);
    const payload: AlertPayload = { title: intent.title, body: intent.body, tags: intent.tags };
    return db
      .prepare(
        'INSERT INTO notifications (id, rule_id, kind, severity, payload, status, next_attempt_at, created_at, ' +
          "expires_at, finished_at) VALUES (?, ?, 'alert', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      )
      .bind(
        intent.id,
        intent.ruleId,
        intent.severity,
        suppressed ? null : JSON.stringify(payload),
        suppressed ? 'suppressed' : 'pending',
        now,
        now,
        now + intent.ttlMinutes * MINUTE_MS,
        suppressed ? now : null,
      );
  });
}

/** Alerts created in the trailing 24 hours (for the daily safety budget). */
export async function countAlertsSince(db: D1Database, since: EpochMs): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'alert' AND status <> 'suppressed' AND created_at >= ?",
    )
    .bind(since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The subject of these notifications has resolved (e.g. the tracker is back
 * on). Undelivered ones are cancelled; delivered ones get a "clear" message
 * so the phone notification disappears.
 */
export function resolveStatements(
  db: D1Database,
  ids: readonly string[],
  now: EpochMs,
  canClear: boolean,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const id of ids) {
    statements.push(
      db
        .prepare(
          "UPDATE notifications SET status = 'cancelled', payload = NULL, lease_token = NULL, finished_at = ? " +
            "WHERE id = ? AND status = 'pending'",
        )
        .bind(now, id),
    );
    if (canClear) {
      const payload: ClearPayload = { targetId: id };
      statements.push(
        db
          .prepare(
            'INSERT INTO notifications (id, rule_id, kind, severity, payload, status, next_attempt_at, created_at, expires_at) ' +
              "SELECT ?, rule_id, 'clear', 'info', ?, 'pending', ?, ?, ? FROM notifications " +
              "WHERE id = ? AND status = 'sent' AND provider_ref IS NOT NULL ON CONFLICT (id) DO NOTHING",
          )
          .bind(`${id}:clear`, JSON.stringify(payload), now, now, now + CLEAR_TTL_MS, id),
      );
    }
  }
  return statements;
}

/** Pending rows that are due and not already sitting in the queue. */
export async function selectDispatchable(db: D1Database, now: EpochMs, limit = 20): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT id FROM notifications WHERE status = 'pending' AND next_attempt_at <= ? AND expires_at > ? " +
        'AND (enqueued_at IS NULL OR enqueued_at <= ?) ORDER BY created_at LIMIT ?',
    )
    .bind(now, now, now - REDISPATCH_AFTER_MS, limit)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

export type NotificationQueue = Pick<Queue<QueueMessageBody>, 'sendBatch'>;

export async function dispatchPending(
  db: D1Database,
  queue: NotificationQueue,
  now: EpochMs,
): Promise<{ enqueued: number; queueError: boolean }> {
  const ids = await selectDispatchable(db, now);
  if (ids.length === 0) return { enqueued: 0, queueError: false };
  try {
    await queue.sendBatch(ids.map((id) => ({ body: { v: 1, id } satisfies QueueMessageBody })));
  } catch {
    return { enqueued: 0, queueError: true };
  }
  const placeholders = ids.map(() => '?').join(', ');
  await db
    .prepare(`UPDATE notifications SET enqueued_at = ? WHERE id IN (${placeholders})`)
    .bind(now, ...ids)
    .run();
  return { enqueued: ids.length, queueError: false };
}

export type ClaimResult =
  { claimed: true; row: OutboxRow; leaseToken: string } | { claimed: false; row: OutboxRow | null };

/**
 * Takes a time-limited lease on a notification. Only one consumer can hold
 * it, so concurrent or duplicate queue deliveries cannot double-send.
 */
export async function claimNotification(
  db: D1Database,
  id: string,
  now: EpochMs,
  leaseMs: number,
): Promise<ClaimResult> {
  const leaseToken = crypto.randomUUID();
  const row = await db
    .prepare(
      "UPDATE notifications SET status = 'sending', lease_token = ?, lease_until = ?, attempts = attempts + 1 " +
        'WHERE id = ? AND expires_at > ? AND ' +
        "((status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until <= ?)) RETURNING *",
    )
    .bind(leaseToken, now + leaseMs, id, now, now, now)
    .first<OutboxRow>();
  if (row) return { claimed: true, row, leaseToken };
  const current = await db.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first<OutboxRow>();
  return { claimed: false, row: current };
}

export async function providerRefFor(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT provider_ref FROM notifications WHERE id = ?')
    .bind(id)
    .first<{ provider_ref: string | null }>();
  return row?.provider_ref ?? null;
}

/** Status updates are fenced by the lease token: a stale holder cannot overwrite. */
export function completeStatement(
  db: D1Database,
  id: string,
  leaseToken: string,
  update:
    | { status: 'sent'; providerRef: string | null; now: EpochMs }
    | { status: 'pending'; nextAttemptAt: EpochMs; error: string }
    | { status: 'failed'; error: string; now: EpochMs },
): D1PreparedStatement {
  switch (update.status) {
    case 'sent':
      return db
        .prepare(
          "UPDATE notifications SET status = 'sent', payload = NULL, provider_ref = ?, last_error = NULL, " +
            'lease_token = NULL, lease_until = 0, finished_at = ? WHERE id = ? AND lease_token = ?',
        )
        .bind(update.providerRef, update.now, id, leaseToken);
    case 'pending':
      // enqueued_at is moved to the retry time so the redispatcher does not duplicate it.
      return db
        .prepare(
          "UPDATE notifications SET status = 'pending', next_attempt_at = ?, enqueued_at = ?, last_error = ?, " +
            'lease_token = NULL, lease_until = 0 WHERE id = ? AND lease_token = ?',
        )
        .bind(update.nextAttemptAt, update.nextAttemptAt, update.error, id, leaseToken);
    case 'failed':
      return db
        .prepare(
          "UPDATE notifications SET status = 'failed', payload = NULL, last_error = ?, lease_token = NULL, " +
            'lease_until = 0, finished_at = ? WHERE id = ? AND lease_token = ?',
        )
        .bind(update.error, update.now, id, leaseToken);
  }
}

export function expireStatement(db: D1Database, id: string, now: EpochMs): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE notifications SET status = 'expired', payload = NULL, lease_token = NULL, finished_at = ? " +
        "WHERE id = ? AND status IN ('pending', 'sending') AND expires_at <= ?",
    )
    .bind(now, id, now);
}
