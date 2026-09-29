import { describe, expect, it } from 'vitest';
import { SettingsError, loadSettings, type WorkerEnv } from '../src/env';
import { TelegramProvider, escapeHtml, formatTelegramMessage } from '../src/notifications/telegram';
import type { OutgoingNotification } from '../src/notifications/types';
import { createProvider } from '../src/services';
import { fakeFetch } from './helpers';

// Obviously fake values in the shapes Telegram uses.
const TOKEN = '123456789:TEST-token-not-real-000000000000000';
const CHAT = '100000001';

const notification: OutgoingNotification = {
  id: 'deviceOffWrist:ep-1',
  title: 'Fitbit reminder',
  body: 'No heart-rate data for 42 minutes.',
  tags: ['watch'],
  severity: 'warning',
};

const telegram = (handler: Parameters<typeof fakeFetch>[0]) => {
  const fake = fakeFetch(handler);
  return { ...fake, provider: new TelegramProvider({ botToken: TOKEN, chatId: CHAT, fetch: fake.fetch }) };
};

const ok = (result: unknown) => Response.json({ ok: true, result });
const error = (status: number, description: string, extra: Record<string, unknown> = {}) =>
  Response.json({ ok: false, error_code: status, description, ...extra }, { status });

describe('Telegram provider', () => {
  it('sends an HTML message to the configured chat and keeps the message id for clearing', async () => {
    const { provider, requests } = telegram(() => ok({ message_id: 42 }));
    expect(await provider.send(notification)).toEqual({ outcome: 'delivered', providerRef: '42' });
    expect(requests[0]!.url.toString()).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      chat_id: CHAT,
      text: '<b>⌚ Fitbit reminder</b>\nNo heart-rate data for 42 minutes.',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: false,
    });
  });

  it('escapes HTML, adds emoji and prefixes, and sends informational messages silently', async () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(
      formatTelegramMessage(
        { ...notification, title: 'Sleep <short>', tags: ['sleeping', 'unknown'] },
        '[DEMO] ',
      ),
    ).toBe('<b>😴 [DEMO] Sleep &lt;short&gt;</b>\nNo heart-rate data for 42 minutes.');

    const { provider, requests } = telegram(() => ok({ message_id: 7 }));
    await provider.send({ ...notification, severity: 'info' });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ disable_notification: true });
  });

  it('honours Telegram rate limits and retries server and network failures', async () => {
    const limited = telegram(() => error(429, 'Too Many Requests', { parameters: { retry_after: 7 } }));
    expect(await limited.provider.send(notification)).toEqual({
      outcome: 'retry',
      reason: 'rate_limited',
      retryAfterSeconds: 7,
      status: 429,
    });
    expect(await telegram(() => error(502, 'Bad Gateway')).provider.send(notification)).toMatchObject({
      outcome: 'retry',
      reason: 'server_error',
    });
    const offline = telegram(() => Promise.reject(new TypeError('fetch failed')));
    expect(await offline.provider.send(notification)).toEqual({ outcome: 'retry', reason: 'network' });
    const slow = telegram(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    expect(await slow.provider.send(notification)).toEqual({ outcome: 'retry', reason: 'timeout' });
  });

  it('fails permanently on credential and request errors, without exposing the token', async () => {
    const cases: Array<[Response, string]> = [
      [error(401, 'Unauthorized'), 'unauthorized'],
      [error(403, 'Forbidden: bot was blocked by the user'), 'unauthorized'],
      [error(404, 'Not Found'), 'misconfigured'],
      [error(400, 'Bad Request: chat not found'), 'rejected'],
    ];
    for (const [response, reason] of cases) {
      const result = await telegram(() => response.clone()).provider.send(notification);
      expect(result).toMatchObject({ outcome: 'failed', reason });
      expect(JSON.stringify(result)).not.toContain(TOKEN.split(':')[1]);
    }
  });

  it('clears a resolved alert by deleting its message, tolerating one that is already gone', async () => {
    const { provider, requests } = telegram(() => ok(true));
    expect(await provider.clear('42')).toEqual({ outcome: 'delivered', providerRef: '42' });
    expect(requests[0]!.url.pathname).toBe(`/bot${TOKEN}/deleteMessage`);
    expect(JSON.parse(requests[0]!.body)).toEqual({ chat_id: CHAT, message_id: 42 });

    const gone = telegram(() => error(400, 'Bad Request: message to delete not found'));
    expect(await gone.provider.clear('42')).toMatchObject({ outcome: 'delivered' });
    const limited = telegram(() => error(429, 'Too Many Requests', { parameters: { retry_after: 3 } }));
    expect(await limited.provider.clear('42')).toMatchObject({ outcome: 'retry', reason: 'rate_limited' });
    // A reference that is not a Telegram message id has nothing to clear.
    const unused = telegram(() => ok(true));
    expect(await unused.provider.clear('deviceOffWrist-ep-1')).toMatchObject({ outcome: 'delivered' });
    expect(unused.requests).toHaveLength(0);
  });
});

describe('notification provider selection', () => {
  const env = (vars: Partial<WorkerEnv> = {}): WorkerEnv => ({
    DB: {} as D1Database,
    NOTIFICATIONS: {} as Queue,
    ...vars,
  });
  const noFetch = () => Promise.reject(new Error('no network in this test'));

  it('uses Telegram when selected and configured, and never falls back silently', () => {
    const configured = loadSettings(
      env({ NOTIFY_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT }),
    );
    expect(createProvider(configured, noFetch, Date.now).name).toBe('telegram');
    // Selected but missing credentials: fail visibly rather than use ntfy behind the user's back.
    const missing = loadSettings(
      env({ NOTIFY_PROVIDER: 'telegram', NTFY_TOPIC: 'topic-abcdefghijklmnopqrstu' }),
    );
    expect(createProvider(missing, noFetch, Date.now).name).toBe('unconfigured');
    // ntfy remains the default provider.
    const ntfy = loadSettings(env({ NTFY_TOPIC: 'topic-abcdefghijklmnopqrstu' }));
    expect(createProvider(ntfy, noFetch, Date.now).name).toBe('ntfy');
  });

  it('validates the provider name and the shape of Telegram credentials', () => {
    expect(() => loadSettings(env({ NOTIFY_PROVIDER: 'pager' }))).toThrow(SettingsError);
    expect(() => loadSettings(env({ TELEGRAM_BOT_TOKEN: 'not-a-token' }))).toThrow(/BotFather/);
    expect(() => loadSettings(env({ TELEGRAM_CHAT_ID: '@someone' }))).toThrow(/numeric/);
    expect(loadSettings(env({ TELEGRAM_CHAT_ID: '-100123' })).telegram.chatId).toBe('-100123');
  });
});
