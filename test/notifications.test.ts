import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../src/demo/runner';
import { retryDelaySeconds } from '../src/notifications/backoff';
import { processNotificationMessage, type ConsumerDeps } from '../src/notifications/consumer';
import { NtfyProvider, ntfySequenceId } from '../src/notifications/ntfy';
import {
  claimNotification,
  dispatchPending,
  insertIntentStatements,
  resolveStatements,
  type NotificationQueue,
  type OutboxRow,
} from '../src/notifications/outbox';
import type { DeliveryResult, NotificationProvider, OutgoingNotification } from '../src/notifications/types';
import { silentLogger } from '../src/observability/log';
import type { NotificationIntent } from '../src/rules/types';
import { fakeFetch, minutes } from './helpers';

const notification: OutgoingNotification = {
  id: 'deviceOffWrist:ep-1',
  title: 'Fitbit reminder',
  body: 'No heart-rate data…',
  tags: ['watch'],
  severity: 'warning',
};

describe('ntfy provider', () => {
  const provider = (handler: Parameters<typeof fakeFetch>[0], token: string | null = null) => {
    const fake = fakeFetch(handler);
    return {
      ...fake,
      ntfy: new NtfyProvider({
        baseUrl: 'https://ntfy.sh',
        topic: 'topic-abcdefghijklmnopqrstu',
        token,
        fetch: fake.fetch,
      }),
    };
  };

  it('publishes JSON to the server root with priority, tags and a sequence id', async () => {
    const { ntfy, requests } = provider(() => Response.json({ id: 'm1' }), 'tk_secret');
    expect(await ntfy.send(notification)).toEqual({
      outcome: 'delivered',
      providerRef: 'deviceOffWrist-ep-1',
    });
    expect(requests[0]!.url.toString()).toBe('https://ntfy.sh/');
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer tk_secret');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      topic: 'topic-abcdefghijklmnopqrstu',
      title: 'Fitbit reminder',
      message: 'No heart-rate data…',
      tags: ['watch'],
      priority: 4,
      sequence_id: 'deviceOffWrist-ep-1',
    });
  });

  it('distinguishes the ntfy.sh daily quota (42908) from ordinary rate limiting', async () => {
    const quota = provider(() =>
      Response.json(
        { code: 42908, http: 429, error: 'limit reached: daily message quota reached' },
        { status: 429 },
      ),
    );
    expect(await quota.ntfy.send(notification)).toMatchObject({
      outcome: 'retry',
      reason: 'quota_exhausted',
      status: 429,
    });
    const limited = provider(
      () => new Response('{"code":42901}', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    expect(await limited.ntfy.send(notification)).toMatchObject({
      outcome: 'retry',
      reason: 'rate_limited',
      retryAfterSeconds: 30,
    });
  });

  it.each([
    [500, { outcome: 'retry', reason: 'server_error' }],
    [408, { outcome: 'retry', reason: 'server_error' }],
    [401, { outcome: 'failed', reason: 'unauthorized' }],
    [403, { outcome: 'failed', reason: 'unauthorized' }],
    [400, { outcome: 'failed', reason: 'rejected' }],
  ])('maps HTTP %i', async (status, expected) => {
    expect(await provider(() => new Response('', { status })).ntfy.send(notification)).toMatchObject(
      expected,
    );
  });

  it('retries network failures and timeouts', async () => {
    expect(await provider(() => Promise.reject(new TypeError('down'))).ntfy.send(notification)).toMatchObject(
      {
        reason: 'network',
      },
    );
    expect(
      await provider(() => Promise.reject(new DOMException('t', 'TimeoutError'))).ntfy.send(notification),
    ).toMatchObject({ reason: 'timeout' });
  });

  it('clears a delivered notification via its sequence id', async () => {
    const { ntfy, requests } = provider(() => Response.json({ event: 'message_clear' }));
    expect(await ntfy.clear('deviceOffWrist-ep-1')).toMatchObject({ outcome: 'delivered' });
    expect(requests[0]!.method).toBe('PUT');
    expect(requests[0]!.url.pathname).toBe('/topic-abcdefghijklmnopqrstu/deviceOffWrist-ep-1/clear');
  });

  it('sanitises and bounds sequence ids', () => {
    expect(ntfySequenceId('sleep:2026-03-10')).toBe('sleep-2026-03-10');
    const long = ntfySequenceId(`x:${'y'.repeat(100)}`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ntfySequenceId(`x:${'y'.repeat(100)}`)).toBe(long);
  });
});

describe('retry backoff', () => {
  const noJitter = () => 0.5;
  it('grows exponentially and caps at 30 minutes', () => {
    expect([1, 2, 3, 4].map((a) => retryDelaySeconds(a, 'server_error', undefined, noJitter))).toEqual([
      30, 60, 120, 240,
    ]);
    expect(retryDelaySeconds(12, 'server_error', undefined, noJitter)).toBe(1800);
  });

  it('spaces quota rejections out and honours Retry-After', () => {
    expect(retryDelaySeconds(1, 'quota_exhausted', undefined, noJitter)).toBe(900);
    expect(retryDelaySeconds(1, 'rate_limited', 300, noJitter)).toBe(300);
    expect(retryDelaySeconds(1, 'rate_limited', 999_999, noJitter)).toBe(3600);
  });

  it('keeps jitter within ±20%', () => {
    expect(retryDelaySeconds(3, 'network', undefined, () => 0)).toBe(96);
    expect(retryDelaySeconds(3, 'network', undefined, () => 1)).toBe(144);
  });
});

// ---------------------------------------------------------------------------
// Outbox + consumer against a real (local) D1 database.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 2, 10, 14, 0);
const intent = (overrides: Partial<NotificationIntent> = {}): NotificationIntent => ({
  id: 'deviceOffWrist:ep-1',
  ruleId: 'deviceOffWrist',
  severity: 'warning',
  title: 'Fitbit reminder',
  body: 'No heart-rate data…',
  tags: ['watch'],
  ttlMinutes: 180,
  ...overrides,
});

class ScriptedProvider implements NotificationProvider {
  readonly name = 'scripted';
  sent: OutgoingNotification[] = [];
  cleared: string[] = [];
  constructor(private readonly results: DeliveryResult[] = []) {}
  send(n: OutgoingNotification): Promise<DeliveryResult> {
    this.sent.push(n);
    return Promise.resolve(this.results.shift() ?? { outcome: 'delivered', providerRef: `ref-${n.id}` });
  }
  clear(ref: string): Promise<DeliveryResult> {
    this.cleared.push(ref);
    return Promise.resolve({ outcome: 'delivered', providerRef: ref });
  }
}

const row = (id = 'deviceOffWrist:ep-1') =>
  env.DB.prepare('SELECT * FROM notifications WHERE id = ?').bind(id).first<OutboxRow>();
const opsValue = async (key: string) =>
  (await env.DB.prepare('SELECT value FROM ops WHERE key = ?').bind(key).first<{ value: string }>())?.value ??
  null;

function consumer(
  provider: NotificationProvider,
  now: () => number = () => NOW,
  maxAttempts = 5,
): ConsumerDeps {
  return { db: env.DB, provider, now, maxAttempts, log: silentLogger, random: () => 0.5 };
}

describe('outbox and queue consumer (D1)', () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  it('inserts each intent once: the id is the deduplication key', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    await env.DB.batch(
      insertIntentStatements(env.DB, [intent({ body: 'different text' })], NOW + minutes(10)),
    );
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect(JSON.parse((await row())!.payload!)).toMatchObject({ body: 'No heart-rate data…' });
  });

  it('delivers, records the provider reference and erases the content', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const provider = new ScriptedProvider();
    expect(await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider))).toEqual(
      {
        action: 'ack',
        reason: 'delivered',
      },
    );
    expect(await row()).toMatchObject({
      status: 'sent',
      payload: null,
      provider_ref: 'ref-deviceOffWrist:ep-1',
      attempts: 1,
    });
    expect(await opsValue('notify.sent_total')).toBe('1');
  });

  it('acknowledges a duplicate delivery without sending again', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const provider = new ScriptedProvider();
    await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider));
    const second = await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider));
    expect(second).toEqual({ action: 'ack', reason: 'already_sent' });
    expect(provider.sent).toHaveLength(1);
    expect(await opsValue('queue.duplicate_deliveries_total')).toBe('1');
  });

  it('lets only one of two concurrent consumers hold the lease', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const [a, b] = await Promise.all([
      claimNotification(env.DB, 'deviceOffWrist:ep-1', NOW, 60_000),
      claimNotification(env.DB, 'deviceOffWrist:ep-1', NOW, 60_000),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    // The loser is told to come back when the lease ends.
    const provider = new ScriptedProvider();
    expect(
      await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider)),
    ).toMatchObject({
      action: 'retry',
      reason: 'leased',
    });
    expect(provider.sent).toHaveLength(0);
  });

  it('retries a 429 with backoff, keeps the content, and does not let the redispatcher duplicate it', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const provider = new ScriptedProvider([{ outcome: 'retry', reason: 'quota_exhausted', status: 429 }]);
    const action = await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider));
    expect(action).toMatchObject({ action: 'retry', delaySeconds: 900 });
    expect(await row()).toMatchObject({
      status: 'pending',
      attempts: 1,
      next_attempt_at: NOW + 900_000,
      last_error: 'scripted_quota_exhausted_429',
    });
    expect((await row())!.payload).not.toBeNull();
    expect(await opsValue('notify.quota_exhausted_total')).toBe('1');

    const queue: NotificationQueue & { sent: number } = {
      sent: 0,
      sendBatch(batch) {
        this.sent += [...batch].length;
        return Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      },
    };
    await dispatchPending(env.DB, queue, NOW + minutes(10));
    expect(queue.sent).toBe(0);
    // Still pending long after its retry time: the queue message was lost, so re-send.
    await dispatchPending(env.DB, queue, NOW + minutes(40));
    expect(queue.sent).toBe(1);
  });

  it('gives up after the maximum attempts — no infinite retry loop', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const provider = new ScriptedProvider(
      Array.from({ length: 10 }, () => ({
        outcome: 'retry' as const,
        reason: 'server_error' as const,
        status: 503,
      })),
    );
    let now = NOW;
    let action;
    for (let attempt = 0; attempt < 5; attempt++) {
      action = await processNotificationMessage(
        { v: 1, id: 'deviceOffWrist:ep-1' },
        consumer(provider, () => now, 3),
      );
      if (action.action === 'retry') now += action.delaySeconds * 1000;
    }
    expect(provider.sent).toHaveLength(3);
    expect(action).toMatchObject({ action: 'ack' });
    expect(await row()).toMatchObject({
      status: 'failed',
      payload: null,
      last_error: 'max_attempts:scripted_server_error_503',
    });
    expect(await opsValue('notify.failed_total')).toBe('1');
  });

  it('fails permanent errors immediately', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const provider = new ScriptedProvider([{ outcome: 'failed', reason: 'unauthorized', status: 403 }]);
    expect(
      await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider)),
    ).toMatchObject({ action: 'ack' });
    expect(await row()).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('drops notifications that outlived their TTL instead of sending stale alerts', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent({ ttlMinutes: 30 })], NOW));
    const provider = new ScriptedProvider();
    expect(
      await processNotificationMessage(
        { v: 1, id: 'deviceOffWrist:ep-1' },
        consumer(provider, () => NOW + minutes(31)),
      ),
    ).toEqual({
      action: 'ack',
      reason: 'expired',
    });
    expect(provider.sent).toHaveLength(0);
    expect(await row()).toMatchObject({ status: 'expired', payload: null });
  });

  it('acknowledges malformed and unknown messages', async () => {
    const provider = new ScriptedProvider();
    expect(await processNotificationMessage({ id: 5 }, consumer(provider))).toMatchObject({
      reason: 'invalid_message',
    });
    expect(await processNotificationMessage({ v: 1, id: 'missing' }, consumer(provider))).toMatchObject({
      reason: 'unknown_id',
    });
    expect(await opsValue('queue.invalid_messages_total')).toBe('1');
  });

  it('on resolution: cancels undelivered alerts and clears delivered ones', async () => {
    await env.DB.batch(
      insertIntentStatements(env.DB, [intent(), intent({ id: 'inactivity:1', ruleId: 'inactivity' })], NOW),
    );
    const provider = new ScriptedProvider();
    await processNotificationMessage({ v: 1, id: 'deviceOffWrist:ep-1' }, consumer(provider));

    await env.DB.batch(
      resolveStatements(env.DB, ['deviceOffWrist:ep-1', 'inactivity:1'], NOW + minutes(30), true),
    );
    expect(await row('inactivity:1')).toMatchObject({ status: 'cancelled', payload: null });
    expect(await row('inactivity:1:clear')).toBeNull();

    const clear = await row('deviceOffWrist:ep-1:clear');
    expect(clear).toMatchObject({ kind: 'clear', status: 'pending' });
    await processNotificationMessage(
      { v: 1, id: 'deviceOffWrist:ep-1:clear' },
      consumer(provider, () => NOW + minutes(31)),
    );
    expect(provider.cleared).toEqual(['ref-deviceOffWrist:ep-1']);
  });

  it('reports queue send failures instead of losing the notification', async () => {
    await env.DB.batch(insertIntentStatements(env.DB, [intent()], NOW));
    const broken: NotificationQueue = { sendBatch: () => Promise.reject(new Error('queue unavailable')) };
    expect(await dispatchPending(env.DB, broken, NOW)).toEqual({ enqueued: 0, queueError: true });
    expect(await row()).toMatchObject({ status: 'pending', enqueued_at: null });
  });
});
