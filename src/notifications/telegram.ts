import type { FetchFn } from '../google/http';
import type { DeliveryResult, NotificationProvider, OutgoingNotification } from './types';

/**
 * Telegram Bot API provider (https://core.telegram.org/bots/api).
 *
 * Messages go to one private chat with the user's own bot. Telegram does not
 * rate-limit by source IP the way ntfy.sh's free tier does, so Cloudflare's
 * shared egress addresses do not matter. Resolved alerts are removed with
 * deleteMessage (Telegram allows that for 48 hours after sending).
 *
 * The bot token is part of every request URL, so URLs are never logged and
 * failures surface only as reason codes.
 */

export const TELEGRAM_API = 'https://api.telegram.org';

/** The rules' ntfy-style tag names, rendered as emoji in front of the title. */
const TAG_EMOJI: Record<string, string> = {
  battery: '🔋',
  chart_with_downwards_trend: '📉',
  chart_with_upwards_trend: '📈',
  grey_question: '❔',
  heart: '❤️',
  hourglass: '⌛',
  sleeping: '😴',
  sunny: '☀️',
  walking: '🚶',
  warning: '⚠️',
  watch: '⌚',
  white_check_mark: '✅',
};

/** Telegram's limit is 4096 characters; PulseWatch messages are far shorter. */
const MAX_TEXT = 3500;

export interface TelegramOptions {
  botToken: string;
  chatId: string;
  fetch: FetchFn;
  apiBase?: string;
  /** Prepended to titles, e.g. "[DEMO] " so synthetic alerts are unmistakable. */
  titlePrefix?: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatTelegramMessage(notification: OutgoingNotification, titlePrefix = ''): string {
  const emoji = notification.tags.map((tag) => TAG_EMOJI[tag] ?? '').join('');
  const title = `${emoji ? `${emoji} ` : ''}${titlePrefix}${notification.title}`;
  const body =
    notification.body.length > MAX_TEXT ? `${notification.body.slice(0, MAX_TEXT)}…` : notification.body;
  return `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}`;
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: unknown };
}

async function readTelegram(response: Response): Promise<TelegramResponse> {
  try {
    const body = JSON.parse((await response.text()).slice(0, 65_536)) as unknown;
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function classify(status: number, body: TelegramResponse): DeliveryResult {
  if (status === 429) {
    const retryAfter = body.parameters?.retry_after;
    return {
      outcome: 'retry',
      reason: 'rate_limited',
      retryAfterSeconds: typeof retryAfter === 'number' ? retryAfter : undefined,
      status,
    };
  }
  if (status >= 500 || status === 408) return { outcome: 'retry', reason: 'server_error', status };
  // 401: bad token. 403: the bot was blocked. 404: Telegram's answer to a malformed token.
  if (status === 401 || status === 403) return { outcome: 'failed', reason: 'unauthorized', status };
  if (status === 404) return { outcome: 'failed', reason: 'misconfigured', status };
  return { outcome: 'failed', reason: 'rejected', status };
}

function thrownResult(error: unknown): DeliveryResult {
  const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return { outcome: 'retry', reason: timeout ? 'timeout' : 'network' };
}

export class TelegramProvider implements NotificationProvider {
  readonly name = 'telegram';

  constructor(private readonly options: TelegramOptions) {}

  private async call(method: string, payload: Record<string, unknown>): Promise<[number, TelegramResponse]> {
    const base = this.options.apiBase ?? TELEGRAM_API;
    const response = await this.options.fetch(`${base}/bot${this.options.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    return [response.status, await readTelegram(response)];
  }

  async send(notification: OutgoingNotification): Promise<DeliveryResult> {
    try {
      const [status, body] = await this.call('sendMessage', {
        chat_id: this.options.chatId,
        text: formatTelegramMessage(notification, this.options.titlePrefix),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        // Informational messages (like ntfy's low priority) arrive without a sound.
        disable_notification: notification.severity === 'info',
      });
      if (status === 200 && body.ok === true) {
        const messageId = (body.result as { message_id?: unknown } | undefined)?.message_id;
        return {
          outcome: 'delivered',
          providerRef: typeof messageId === 'number' ? String(messageId) : null,
        };
      }
      return classify(status, body);
    } catch (error) {
      return thrownResult(error);
    }
  }

  async clear(providerRef: string): Promise<DeliveryResult> {
    const messageId = Number(providerRef);
    if (!Number.isSafeInteger(messageId)) return { outcome: 'delivered', providerRef: null };
    try {
      const [status, body] = await this.call('deleteMessage', {
        chat_id: this.options.chatId,
        message_id: messageId,
      });
      // Already gone, or older than Telegram's 48-hour window: nothing left to clear.
      if ((status === 200 && body.ok === true) || status === 400) {
        return { outcome: 'delivered', providerRef };
      }
      return classify(status, body);
    } catch (error) {
      return thrownResult(error);
    }
  }
}
