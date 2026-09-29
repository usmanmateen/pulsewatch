import { parseConfig, type PulseWatchConfig } from '../config/schema';
import { formatClockMinutes } from '../domain/format';
import { minutesOfDay } from '../domain/time';
import type { EpochMs } from '../domain/types';
import type { GoogleCredentials, Settings } from '../env';
import { GoogleHealthClient } from '../google/client';
import { RefreshTokenAccessTokens } from '../google/oauth';
import { handleNotificationBatch } from '../notifications/consumer';
import { NtfyProvider } from '../notifications/ntfy';
import { silentLogger, type Logger } from '../observability/log';
import { runCheck, type CheckResult } from '../pipeline/check';
import { createGoogleHealthEmulator } from './google-emulator';
import { createNtfyEmulator, type EmulatedMessage } from './ntfy-emulator';
import { SimulatedQueue } from './queue';
import { CHECK_INTERVAL_MS, buildWorldSpec, scenarioStart, type Scenario } from './scenarios';
import { SyntheticWorld, hashString, seededRandom } from './world';

/** Placeholder credentials; the emulator's token endpoint accepts anything. */
export const DEMO_CREDENTIALS: GoogleCredentials = {
  clientId: 'demo-client-id',
  clientSecret: 'demo-client-secret',
  refreshToken: 'demo-refresh-token',
};

export const DEMO_NTFY = {
  baseUrl: 'https://ntfy.demo.invalid',
  topic: 'pulsewatch-demo-topic-0000',
} as const;

const TABLES = ['rule_state', 'daily_metrics', 'baselines', 'notifications', 'runs', 'ops'] as const;

export async function resetDatabase(db: D1Database): Promise<void> {
  await db.batch(TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));
}

export type ScenarioEvent =
  | { type: 'check'; at: EpochMs; clock: string; result: CheckResult }
  | { type: 'delivered'; at: EpochMs; clock: string; message: EmulatedMessage }
  | { type: 'cleared'; at: EpochMs; clock: string; sequenceId: string }
  | { type: 'rejected'; at: EpochMs; clock: string; status: number; code: number | null }
  | { type: 'retry_scheduled'; at: EpochMs; clock: string; id: string; delaySeconds: number }
  | { type: 'duplicate_ignored'; at: EpochMs; clock: string; count: number };

export interface ScenarioRun {
  scenario: Scenario;
  events: ScenarioEvent[];
  delivered: EmulatedMessage[];
  cleared: string[];
  rejected: number;
  duplicatesIgnored: number;
}

export interface RunScenarioOptions {
  db: D1Database;
  log?: Logger;
  config?: PulseWatchConfig;
}

export async function runScenario(scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioRun> {
  const { db } = options;
  const log = options.log ?? silentLogger;
  const config = options.config ?? parseConfig({});
  await resetDatabase(db);

  const spec = buildWorldSpec(scenario);
  const world = new SyntheticWorld(spec);
  const start = scenarioStart(scenario);
  let clock = start;
  const now = () => clock;
  const clockText = (at: EpochMs) => formatClockMinutes(minutesOfDay(at, spec.timeZone));

  const googleFetch = createGoogleHealthEmulator(world, now);
  const ntfy = createNtfyEmulator(now, scenario.ntfyFailures);
  const settings: Settings = {
    mode: 'demo',
    timeZone: spec.timeZone,
    config,
    notifyProvider: 'ntfy',
    ntfy: { baseUrl: DEMO_NTFY.baseUrl, topic: DEMO_NTFY.topic, token: null },
    telegram: { botToken: null, chatId: null },
    statusToken: null,
    google: null,
    demoScenario: scenario.id,
    demoAnchor: null,
  };
  const queue = new SimulatedQueue(now);
  const consumerDeps = {
    db,
    provider: new NtfyProvider(
      { baseUrl: DEMO_NTFY.baseUrl, topic: DEMO_NTFY.topic, token: null, fetch: ntfy.fetch },
      now,
    ),
    now,
    maxAttempts: config.notifications.maxAttempts,
    log,
    // Seeded so retry timings (and therefore the demo transcript) are reproducible.
    random: seededRandom(hashString(scenario.id)),
  };

  const events: ScenarioEvent[] = [];
  let duplicatesIgnored = 0;
  for (let i = 0; i < scenario.checks; i++) {
    clock = start + i * CHECK_INTERVAL_MS;
    // A fresh client per check mirrors a fresh Worker invocation.
    const health = new GoogleHealthClient({
      tokens: new RefreshTokenAccessTokens(DEMO_CREDENTIALS, googleFetch, now),
      fetch: googleFetch,
      log,
      sleep: () => Promise.resolve(),
    });
    const result = await runCheck(
      { db, queue, settings, health, credentialFingerprint: null, canClearNotifications: true, now, log },
      { kind: 'cron', scheduledTime: clock },
    );
    events.push({ type: 'check', at: clock, clock: clockText(clock), result });

    const seen = {
      delivered: ntfy.delivered.length,
      cleared: ntfy.cleared.length,
      rejected: ntfy.rejected.length,
    };
    const duplicatesBefore = await duplicateCount(db);
    const report = await queue.drain((batch) => handleNotificationBatch(batch, consumerDeps), {
      duplicate: scenario.duplicateQueueDelivery === true,
    });
    for (const rejection of ntfy.rejected.slice(seen.rejected)) {
      events.push({
        type: 'rejected',
        at: clock,
        clock: clockText(clock),
        status: rejection.status,
        code: rejection.code,
      });
    }
    for (const retry of report.retried) {
      events.push({
        type: 'retry_scheduled',
        at: clock,
        clock: clockText(clock),
        id: retry.id,
        delaySeconds: retry.delaySeconds,
      });
    }
    for (const message of ntfy.delivered.slice(seen.delivered)) {
      events.push({ type: 'delivered', at: clock, clock: clockText(clock), message });
    }
    for (const cleared of ntfy.cleared.slice(seen.cleared)) {
      events.push({ type: 'cleared', at: clock, clock: clockText(clock), sequenceId: cleared.sequenceId });
    }
    const duplicates = (await duplicateCount(db)) - duplicatesBefore;
    if (duplicates > 0) {
      duplicatesIgnored += duplicates;
      events.push({ type: 'duplicate_ignored', at: clock, clock: clockText(clock), count: duplicates });
    }
  }

  return {
    scenario,
    events,
    delivered: ntfy.delivered,
    cleared: ntfy.cleared.map((c) => c.sequenceId),
    rejected: ntfy.rejected.length,
    duplicatesIgnored,
  };
}

async function duplicateCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM ops WHERE key = 'queue.duplicate_deliveries_total'")
    .first<{ value: string }>();
  return row ? Number(row.value) : 0;
}
