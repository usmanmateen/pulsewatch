import { DEMO_CREDENTIALS } from './demo/runner';
import { createLiveDemoFetch } from './demo/live';
import type { EpochMs } from './domain/types';
import { loadSettings, type Settings, type WorkerEnv } from './env';
import { GoogleHealthClient } from './google/client';
import type { FetchFn } from './google/http';
import { RefreshTokenAccessTokens, credentialFingerprint, type AccessTokenCache } from './google/oauth';
import type { ConsumerDeps } from './notifications/consumer';
import { DemoConsoleProvider, NtfyProvider } from './notifications/ntfy';
import { TelegramProvider } from './notifications/telegram';
import type { DeliveryResult, NotificationProvider } from './notifications/types';
import { createLogger, type Logger } from './observability/log';
import type { CheckDependencies } from './pipeline/check';

/**
 * Wires the application together for one invocation. Mode only changes
 * where data comes from (Google vs the synthetic emulator) and where
 * notifications go; the pipeline itself is identical.
 */

/** Live mode without provider credentials: fail loudly (and visibly in /status) rather than drop silently. */
class UnconfiguredProvider implements NotificationProvider {
  readonly name = 'unconfigured';
  send(): Promise<DeliveryResult> {
    return Promise.resolve({ outcome: 'failed', reason: 'misconfigured' });
  }
}

export function createProvider(
  settings: Settings,
  fetchFn: FetchFn,
  now: () => EpochMs,
): NotificationProvider {
  const titlePrefix = settings.mode === 'demo' ? '[DEMO] ' : '';
  if (settings.notifyProvider === 'telegram') {
    const { botToken, chatId } = settings.telegram;
    if (botToken && chatId) return new TelegramProvider({ botToken, chatId, fetch: fetchFn, titlePrefix });
  } else if (settings.ntfy.topic) {
    const { baseUrl, topic, token } = settings.ntfy;
    return new NtfyProvider({ baseUrl, topic, token, fetch: fetchFn, titlePrefix }, now);
  }
  return settings.mode === 'demo' ? new DemoConsoleProvider() : new UnconfiguredProvider();
}

export interface Services {
  settings: Settings;
  log: Logger;
  check: CheckDependencies;
  consumer: ConsumerDeps;
}

/** Access tokens by credential fingerprint, kept for the life of the isolate. */
const tokenCaches = new Map<string, AccessTokenCache>();

export interface ServiceOverrides {
  now?: () => EpochMs;
  fetch?: FetchFn;
  log?: Logger;
}

export async function createServices(env: WorkerEnv, overrides: ServiceOverrides = {}): Promise<Services> {
  const settings = loadSettings(env);
  const now = overrides.now ?? Date.now;
  const fetchFn = overrides.fetch ?? ((input, init) => fetch(input, init));
  const log = overrides.log ?? createLogger({ service: 'pulsewatch', mode: settings.mode });

  let health: GoogleHealthClient | null = null;
  let fingerprint: string | null = null;
  if (settings.mode === 'demo') {
    const demoFetch = createLiveDemoFetch(settings.demoScenario, now, settings.timeZone, settings.demoAnchor);
    health = new GoogleHealthClient({
      tokens: new RefreshTokenAccessTokens(DEMO_CREDENTIALS, demoFetch, now),
      fetch: demoFetch,
      log,
    });
  } else if (settings.google) {
    fingerprint = await credentialFingerprint(settings.google);
    // Share the access token between invocations of a warm isolate (checks run
    // every minute), keyed by credentials so a replaced secret starts afresh.
    // Injected fetch/clock means a test: keep it isolated.
    let cache: AccessTokenCache | undefined;
    if (!overrides.fetch && !overrides.now) {
      cache = tokenCaches.get(fingerprint) ?? { value: null };
      tokenCaches.set(fingerprint, cache);
    }
    health = new GoogleHealthClient({
      tokens: new RefreshTokenAccessTokens(settings.google, fetchFn, now, cache),
      fetch: fetchFn,
      log,
    });
  }

  const provider = createProvider(settings, fetchFn, now);
  return {
    settings,
    log,
    check: {
      db: env.DB,
      queue: env.NOTIFICATIONS,
      settings,
      health,
      credentialFingerprint: fingerprint,
      canClearNotifications: typeof provider.clear === 'function',
      now,
      log,
    },
    consumer: {
      db: env.DB,
      provider,
      now,
      maxAttempts: settings.config.notifications.maxAttempts,
      log,
    },
  };
}
