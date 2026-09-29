import type { EpochMs } from '../domain/types';
import { errorCode, type Logger } from '../observability/log';
import { OPS, incrementStatement, setStatement } from '../storage/ops';
import { retryDelaySeconds } from './backoff';
import {
  TERMINAL_STATUSES,
  claimNotification,
  completeStatement,
  expireStatement,
  providerRefFor,
  type AlertPayload,
  type ClearPayload,
  type OutboxRow,
} from './outbox';
import type { DeliveryResult, NotificationProvider, QueueMessageBody } from './types';

/** Long enough for one provider call (10 s timeout) plus D1 round trips. */
const LEASE_MS = 60_000;

export interface ConsumerDeps {
  db: D1Database;
  provider: NotificationProvider;
  now: () => EpochMs;
  maxAttempts: number;
  log: Logger;
  random?: () => number;
}

export type MessageAction =
  { action: 'ack'; reason: string } | { action: 'retry'; delaySeconds: number; reason: string };

export function parseQueueMessage(body: unknown): QueueMessageBody | null {
  if (!body || typeof body !== 'object') return null;
  const { v, id } = body as Record<string, unknown>;
  if (v !== 1 || typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  return { v, id };
}

const secondsUntil = (at: EpochMs, now: EpochMs): number => Math.max(1, Math.ceil((at - now) / 1000));

async function deliver(row: OutboxRow, deps: ConsumerDeps): Promise<DeliveryResult> {
  if (row.kind === 'clear') {
    const { targetId } = JSON.parse(row.payload ?? '{}') as ClearPayload;
    const ref = await providerRefFor(deps.db, targetId);
    // Nothing to clear, or a provider without clearing: that is fine, not a failure.
    if (!ref || !deps.provider.clear) return { outcome: 'delivered', providerRef: null };
    return deps.provider.clear(ref);
  }
  const payload = JSON.parse(row.payload ?? 'null') as AlertPayload | null;
  if (!payload) return { outcome: 'failed', reason: 'rejected' };
  return deps.provider.send({
    id: row.id,
    title: payload.title,
    body: payload.body,
    tags: payload.tags,
    severity: row.severity,
  });
}

/**
 * Processes one queue message. Safe under duplicate and concurrent delivery:
 * the D1 row, not the queue message, is the source of truth.
 */
export async function processNotificationMessage(body: unknown, deps: ConsumerDeps): Promise<MessageAction> {
  const { db, log } = deps;
  const message = parseQueueMessage(body);
  if (!message) {
    await incrementStatement(db, OPS.queueInvalidMessagesTotal, deps.now()).run();
    return { action: 'ack', reason: 'invalid_message' };
  }

  const now = deps.now();
  const claim = await claimNotification(db, message.id, now, LEASE_MS);
  if (!claim.claimed) {
    const row = claim.row;
    if (!row) return { action: 'ack', reason: 'unknown_id' };
    if (TERMINAL_STATUSES.has(row.status)) {
      await incrementStatement(db, OPS.queueDuplicateDeliveriesTotal, now).run();
      return { action: 'ack', reason: `already_${row.status}` };
    }
    if (row.expires_at <= now) {
      await expireStatement(db, row.id, now).run();
      return { action: 'ack', reason: 'expired' };
    }
    if (row.status === 'pending') {
      return { action: 'retry', delaySeconds: secondsUntil(row.next_attempt_at, now), reason: 'not_due' };
    }
    return { action: 'retry', delaySeconds: secondsUntil(row.lease_until, now), reason: 'leased' };
  }

  const { row, leaseToken } = claim;
  let result: DeliveryResult;
  try {
    result = await deliver(row, deps);
  } catch (error) {
    log.warn('notification.provider_threw', { id: row.id, error: errorCode(error) });
    result = { outcome: 'retry', reason: 'network' };
  }

  const finishedAt = deps.now();
  if (result.outcome === 'delivered') {
    await db.batch([
      completeStatement(db, row.id, leaseToken, {
        status: 'sent',
        providerRef: result.providerRef,
        now: finishedAt,
      }),
      incrementStatement(db, OPS.notifySentTotal, finishedAt),
      setStatement(db, OPS.notifyLastSuccessAt, finishedAt, finishedAt),
    ]);
    log.info('notification.delivered', {
      id: row.id,
      rule: row.rule_id,
      kind: row.kind,
      attempt: row.attempts,
    });
    return { action: 'ack', reason: 'delivered' };
  }

  const code = `${deps.provider.name}_${result.reason}${result.status ? `_${result.status}` : ''}`;
  if (result.outcome === 'retry' && row.attempts < deps.maxAttempts) {
    const delaySeconds = retryDelaySeconds(
      row.attempts,
      result.reason,
      result.retryAfterSeconds,
      deps.random,
    );
    const counters = [incrementStatement(db, OPS.notifyRetriesTotal, finishedAt)];
    if (result.reason === 'rate_limited')
      counters.push(incrementStatement(db, OPS.notifyRateLimitedTotal, finishedAt));
    if (result.reason === 'quota_exhausted') {
      counters.push(incrementStatement(db, OPS.notifyQuotaExhaustedTotal, finishedAt));
    }
    await db.batch([
      completeStatement(db, row.id, leaseToken, {
        status: 'pending',
        nextAttemptAt: finishedAt + delaySeconds * 1000,
        error: code,
      }),
      ...counters,
    ]);
    log.warn('notification.retry_scheduled', {
      id: row.id,
      attempt: row.attempts,
      reason: code,
      delaySeconds,
    });
    return { action: 'retry', delaySeconds, reason: code };
  }

  const finalCode = result.outcome === 'retry' ? `max_attempts:${code}` : code;
  await db.batch([
    completeStatement(db, row.id, leaseToken, { status: 'failed', error: finalCode, now: finishedAt }),
    incrementStatement(db, OPS.notifyFailedTotal, finishedAt),
    setStatement(db, OPS.notifyLastFailureAt, finishedAt, finishedAt),
    setStatement(db, OPS.notifyLastFailureCode, finalCode, finishedAt),
  ]);
  log.error('notification.failed', { id: row.id, attempt: row.attempts, reason: finalCode });
  return { action: 'ack', reason: finalCode };
}

/** The Cloudflare Queues consumer. Acks or retries each message individually. */
export async function handleNotificationBatch(batch: MessageBatch, deps: ConsumerDeps): Promise<void> {
  for (const message of batch.messages) {
    try {
      const action = await processNotificationMessage(message.body, deps);
      if (action.action === 'ack') message.ack();
      else message.retry({ delaySeconds: action.delaySeconds });
    } catch (error) {
      // Infrastructure trouble (e.g. D1 briefly unavailable): let the queue redeliver.
      deps.log.error('notification.consumer_error', { error: errorCode(error), attempts: message.attempts });
      message.retry({ delaySeconds: 60 });
    }
  }
}
