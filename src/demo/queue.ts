import type { EpochMs } from '../domain/types';
import type { NotificationQueue } from '../notifications/outbox';
import type { QueueMessageBody } from '../notifications/types';

/**
 * In-process stand-in for a Cloudflare Queue, driven by a simulated clock.
 * Implements the semantics the consumer relies on — per-message ack/retry,
 * retry delays, attempt counts — and can deliver a message twice to
 * demonstrate at-least-once delivery.
 */

interface QueuedMessage {
  id: string;
  body: QueueMessageBody;
  visibleAt: EpochMs;
  attempts: number;
  enqueuedAt: EpochMs;
}

export interface DrainReport {
  delivered: number;
  acked: number;
  retried: Array<{ id: string; delaySeconds: number }>;
}

export class SimulatedQueue implements NotificationQueue {
  private messages: QueuedMessage[] = [];
  private sequence = 0;

  constructor(private readonly now: () => EpochMs) {}

  get size(): number {
    return this.messages.length;
  }

  sendBatch(batch: Iterable<MessageSendRequest<QueueMessageBody>>): Promise<QueueSendBatchResponse> {
    for (const request of batch) {
      this.sequence += 1;
      this.messages.push({
        id: `msg-${this.sequence}`,
        body: request.body,
        visibleAt: this.now() + (request.delaySeconds ?? 0) * 1000,
        attempts: 1,
        enqueuedAt: this.now(),
      });
    }
    return Promise.resolve({
      metadata: { metrics: { backlogCount: this.messages.length, backlogBytes: 0 } },
    });
  }

  /**
   * Delivers every visible message to `consumer` as a batch. With
   * `duplicate`, each message is delivered twice in the same batch, as an
   * at-least-once queue occasionally does.
   */
  async drain(
    consumer: (batch: MessageBatch) => Promise<void>,
    options: { duplicate?: boolean } = {},
  ): Promise<DrainReport> {
    const now = this.now();
    const visible = this.messages.filter((m) => m.visibleAt <= now);
    if (visible.length === 0) return { delivered: 0, acked: 0, retried: [] };

    const outcome = new Map<QueuedMessage, { acked: boolean; delaySeconds?: number }>();
    const deliveries = options.duplicate ? visible.flatMap((m) => [m, m]) : visible;
    const messages = deliveries.map((queued) => ({
      id: queued.id,
      timestamp: new Date(queued.enqueuedAt),
      body: queued.body,
      attempts: queued.attempts,
      ack: () => {
        outcome.set(queued, { acked: true });
      },
      retry: (retryOptions?: QueueRetryOptions) => {
        if (!outcome.get(queued)?.acked)
          outcome.set(queued, { acked: false, delaySeconds: retryOptions?.delaySeconds ?? 0 });
      },
    }));
    const batch = {
      queue: 'pulsewatch-notifications',
      messages,
      ackAll: () => {
        messages.forEach((m) => {
          m.ack();
        });
      },
      retryAll: (retryOptions?: QueueRetryOptions) => {
        messages.forEach((m) => {
          m.retry(retryOptions);
        });
      },
    } as unknown as MessageBatch;

    await consumer(batch);

    const report: DrainReport = { delivered: deliveries.length, acked: 0, retried: [] };
    for (const queued of visible) {
      const result = outcome.get(queued);
      if (result?.acked) {
        report.acked += 1;
        this.messages = this.messages.filter((m) => m !== queued);
      } else {
        const delaySeconds = result?.delaySeconds ?? 0;
        queued.visibleAt = now + delaySeconds * 1000;
        queued.attempts += 1;
        report.retried.push({ id: queued.body.id, delaySeconds });
      }
    }
    return report;
  }
}
