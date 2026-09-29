import type { Severity } from '../rules/types';

/** Queue messages carry only an outbox id; content stays in D1. */
export interface QueueMessageBody {
  v: 1;
  id: string;
}

export interface OutgoingNotification {
  /** Stable id. Providers that support it use this to make re-sends idempotent. */
  id: string;
  title: string;
  body: string;
  tags: string[];
  severity: Severity;
}

export type RetryReason = 'rate_limited' | 'quota_exhausted' | 'server_error' | 'network' | 'timeout';
export type FailureReason = 'rejected' | 'unauthorized' | 'misconfigured';

export type DeliveryResult =
  | { outcome: 'delivered'; providerRef: string | null }
  | { outcome: 'retry'; reason: RetryReason; retryAfterSeconds?: number; status?: number }
  | { outcome: 'failed'; reason: FailureReason; status?: number };

/**
 * A delivery channel: ntfy and Telegram implement it; email,
 * web push etc. would implement the same two methods.
 */
export interface NotificationProvider {
  readonly name: string;
  send(notification: OutgoingNotification): Promise<DeliveryResult>;
  /** Optional: dismiss a delivered notification whose subject has resolved. */
  clear?(providerRef: string): Promise<DeliveryResult>;
}
