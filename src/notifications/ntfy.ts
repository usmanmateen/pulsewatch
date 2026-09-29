import type { FetchFn } from '../google/http';
import type { Severity } from '../rules/types';
import type { DeliveryResult, NotificationProvider, OutgoingNotification } from './types';

/**
 * ntfy provider (https://docs.ntfy.sh/publish/).
 *
 * - Publishes JSON to the server root: HTTP headers cannot safely carry emoji
 *   or non-ASCII titles, JSON can.
 * - Sets `sequence_id` to the notification's stable id. A duplicate delivery
 *   (at-least-once queues) then *replaces* the notification on the phone
 *   instead of adding a second one, and resolution can clear it later.
 * - Distinguishes ntfy.sh's daily-quota 429 (code 42908) from ordinary rate
 *   limiting. On the free tier that quota is counted per IP, and Cloudflare
 *   Workers share egress IPs, so a later retry usually leaves from a
 *   different address and succeeds.
 */

export const NTFY_PRIORITY: Record<Severity, number> = { info: 2, notice: 3, warning: 4 };

/** Error code ntfy.sh returns when the per-visitor daily message quota is used up. */
const NTFY_DAILY_QUOTA_CODE = 42908;

export interface NtfyOptions {
  baseUrl: string;
  topic: string;
  token: string | null;
  fetch: FetchFn;
  /** Prepended to titles, e.g. "[DEMO] " so synthetic alerts are unmistakable. */
  titlePrefix?: string;
}

/** ntfy sequence ids allow letters, digits, '-' and '_' (max 64 chars). */
export function ntfySequenceId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '-');
  if (cleaned.length <= 64) return cleaned;
  // Keep the readable prefix and add a short, stable hash of the full id.
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${cleaned.slice(0, 55)}-${(hash >>> 0).toString(36)}`;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : undefined;
}

async function ntfyErrorCode(response: Response): Promise<number | null> {
  try {
    const text = (await response.text()).slice(0, 4096);
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'number') {
      return body.code;
    }
  } catch {
    // Not JSON; fall through.
  }
  return null;
}

async function classify(response: Response, now: number): Promise<DeliveryResult> {
  const status = response.status;
  if (status === 429) {
    const code = await ntfyErrorCode(response);
    return {
      outcome: 'retry',
      reason: code === NTFY_DAILY_QUOTA_CODE ? 'quota_exhausted' : 'rate_limited',
      retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After'), now),
      status,
    };
  }
  await response.body?.cancel().catch(() => undefined);
  if (status >= 500 || status === 408) return { outcome: 'retry', reason: 'server_error', status };
  if (status === 401 || status === 403) return { outcome: 'failed', reason: 'unauthorized', status };
  return { outcome: 'failed', reason: 'rejected', status };
}

function thrownResult(error: unknown): DeliveryResult {
  const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return { outcome: 'retry', reason: timeout ? 'timeout' : 'network' };
}

export class NtfyProvider implements NotificationProvider {
  readonly name = 'ntfy';

  constructor(
    private readonly options: NtfyOptions,
    private readonly now: () => number = Date.now,
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
    };
  }

  async send(notification: OutgoingNotification): Promise<DeliveryResult> {
    const sequenceId = ntfySequenceId(notification.id);
    try {
      const response = await this.options.fetch(`${this.options.baseUrl}/`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          topic: this.options.topic,
          title: `${this.options.titlePrefix ?? ''}${notification.title}`,
          message: notification.body,
          tags: notification.tags,
          priority: NTFY_PRIORITY[notification.severity],
          sequence_id: sequenceId,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { outcome: 'delivered', providerRef: sequenceId };
      }
      return await classify(response, this.now());
    } catch (error) {
      return thrownResult(error);
    }
  }

  async clear(providerRef: string): Promise<DeliveryResult> {
    const url = `${this.options.baseUrl}/${this.options.topic}/${encodeURIComponent(providerRef)}/clear`;
    try {
      const response = await this.options.fetch(url, {
        method: 'PUT',
        headers: this.headers(false),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { outcome: 'delivered', providerRef };
      }
      return await classify(response, this.now());
    } catch (error) {
      return thrownResult(error);
    }
  }
}

/**
 * Demo-only provider that prints notifications to the log. Never used in live
 * mode: live notification text contains personal health information.
 */
export class DemoConsoleProvider implements NotificationProvider {
  readonly name = 'console';

  send(notification: OutgoingNotification): Promise<DeliveryResult> {
    console.log(`[DEMO NOTIFICATION] ${notification.title}\n${notification.body}`);
    return Promise.resolve({ outcome: 'delivered', providerRef: ntfySequenceId(notification.id) });
  }

  clear(providerRef: string): Promise<DeliveryResult> {
    console.log(`[DEMO NOTIFICATION CLEARED] ${providerRef}`);
    return Promise.resolve({ outcome: 'delivered', providerRef });
  }
}
