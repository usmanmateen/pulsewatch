import { parseConfig, type PulseWatchConfig } from './config/schema';
import { isValidTimeZone } from './domain/time';
import type { QueueMessageBody } from './notifications/types';

/**
 * Bindings, variables and secrets available to the Worker. Declared by hand
 * (rather than generated) because secrets are optional at different stages:
 * the Google refresh token only exists after the one-off OAuth step.
 */
export interface WorkerEnv {
  DB: D1Database;
  NOTIFICATIONS: Queue<QueueMessageBody>;

  // Variables (wrangler.jsonc `vars`, overridable locally via .dev.vars)
  MODE?: string;
  TIME_ZONE?: string;
  NTFY_URL?: string;
  /** "telegram" or "ntfy" (default). */
  NOTIFY_PROVIDER?: string;
  PULSEWATCH_CONFIG?: unknown;
  DEMO_SCENARIO?: string;
  /** ISO timestamp at which a scripted demo scenario starts (optional). */
  DEMO_ANCHOR?: string;

  // Secrets (`wrangler secret put`, or .dev.vars locally)
  STATUS_TOKEN?: string;
  NTFY_TOPIC?: string;
  NTFY_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
}

export type Mode = 'live' | 'demo';
export type NotifyProvider = 'ntfy' | 'telegram';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface Settings {
  mode: Mode;
  timeZone: string;
  config: PulseWatchConfig;
  notifyProvider: NotifyProvider;
  ntfy: { baseUrl: string; topic: string | null; token: string | null };
  telegram: { botToken: string | null; chatId: string | null };
  statusToken: string | null;
  /** Null until the OAuth bootstrap has stored a refresh token. */
  google: GoogleCredentials | null;
  demoScenario: string;
  /** Start of the scripted demo scenario, if anchored; otherwise its usual clock times. */
  demoAnchor: number | null;
}

export class SettingsError extends Error {
  override readonly name = 'SettingsError';
}

/** ntfy topics double as a password on the public server, so require length. */
const NTFY_TOPIC_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MIN_STATUS_TOKEN_LENGTH = 32;
/** "<bot id>:<secret>", as issued by @BotFather. */
export const TELEGRAM_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_CHAT_ID_PATTERN = /^-?\d{1,20}$/;

function optionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseAnchor(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) throw new SettingsError('DEMO_ANCHOR must be an ISO 8601 timestamp');
  return at;
}

export function loadSettings(env: WorkerEnv): Settings {
  const mode = (env.MODE ?? 'live').trim();
  if (mode !== 'live' && mode !== 'demo') {
    throw new SettingsError('MODE must be "live" or "demo"');
  }

  const timeZone = (env.TIME_ZONE ?? 'UTC').trim();
  if (!isValidTimeZone(timeZone)) {
    throw new SettingsError('TIME_ZONE must be an IANA time zone such as Europe/London');
  }

  const baseUrl = (env.NTFY_URL ?? 'https://ntfy.sh').trim().replace(/\/+$/, '');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new SettingsError('NTFY_URL must be an absolute URL');
  }
  if (parsedUrl.protocol !== 'https:' && mode === 'live') {
    throw new SettingsError('NTFY_URL must use https in live mode');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new SettingsError('NTFY_URL must not contain credentials, a query or a fragment');
  }

  const topic = optionalSecret(env.NTFY_TOPIC);
  if (topic !== null && !NTFY_TOPIC_PATTERN.test(topic)) {
    throw new SettingsError(
      'NTFY_TOPIC must be 20-64 characters of letters, digits, "-" or "_" (it acts as a password)',
    );
  }

  const notifyProvider = (env.NOTIFY_PROVIDER ?? 'ntfy').trim() || 'ntfy';
  if (notifyProvider !== 'ntfy' && notifyProvider !== 'telegram') {
    throw new SettingsError('NOTIFY_PROVIDER must be "telegram" or "ntfy"');
  }
  const botToken = optionalSecret(env.TELEGRAM_BOT_TOKEN);
  if (botToken !== null && !TELEGRAM_TOKEN_PATTERN.test(botToken)) {
    throw new SettingsError('TELEGRAM_BOT_TOKEN does not look like a token from @BotFather');
  }
  const chatId = optionalSecret(env.TELEGRAM_CHAT_ID);
  if (chatId !== null && !TELEGRAM_CHAT_ID_PATTERN.test(chatId)) {
    throw new SettingsError('TELEGRAM_CHAT_ID must be a numeric Telegram chat id');
  }

  const statusToken = optionalSecret(env.STATUS_TOKEN);
  if (statusToken !== null && statusToken.length < MIN_STATUS_TOKEN_LENGTH) {
    throw new SettingsError(`STATUS_TOKEN must be at least ${MIN_STATUS_TOKEN_LENGTH} characters`);
  }

  const clientId = optionalSecret(env.GOOGLE_CLIENT_ID);
  const clientSecret = optionalSecret(env.GOOGLE_CLIENT_SECRET);
  const refreshToken = optionalSecret(env.GOOGLE_REFRESH_TOKEN);
  const google = clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;

  return {
    mode,
    timeZone,
    config: parseConfig(env.PULSEWATCH_CONFIG),
    notifyProvider,
    ntfy: { baseUrl, topic, token: optionalSecret(env.NTFY_TOKEN) },
    telegram: { botToken, chatId },
    statusToken,
    google,
    demoScenario: (env.DEMO_SCENARIO ?? 'daily-routine').trim() || 'daily-routine',
    demoAnchor: parseAnchor(env.DEMO_ANCHOR),
  };
}
