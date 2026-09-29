import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/schema';
import { createGoogleHealthEmulator, type GoogleFault } from '../src/demo/google-emulator';
import { SimulatedQueue } from '../src/demo/queue';
import { DEMO_CREDENTIALS, resetDatabase } from '../src/demo/runner';
import { SCENARIOS, buildWorldSpec } from '../src/demo/scenarios';
import { SyntheticWorld, type WorldSpec } from '../src/demo/world';
import { MINUTE_MS, type EpochMs } from '../src/domain/types';
import type { GoogleCredentials, Settings } from '../src/env';
import { GoogleHealthClient } from '../src/google/client';
import type { FetchFn } from '../src/google/http';
import { RefreshTokenAccessTokens, credentialFingerprint } from '../src/google/oauth';
import { silentLogger } from '../src/observability/log';
import { runCheck, scopeForSlot, type CheckDependencies, type CheckScope } from '../src/pipeline/check';
import { at } from './helpers';

const baseScenario = SCENARIOS[0]!;

interface Harness {
  run(clock: string | EpochMs, kind?: 'cron' | 'manual', scope?: CheckScope): ReturnType<typeof runCheck>;
  queue: SimulatedQueue;
  calls: () => number;
  setCredentials(credentials: GoogleCredentials): void;
}

/** A live-mode pipeline talking to the Google emulator (optionally with injected faults). */
function harness(
  options: {
    world?: Partial<WorldSpec>;
    faults?: GoogleFault[];
    settings?: Partial<Settings>;
    config?: unknown;
    day?: string;
  } = {},
): Harness {
  const day = options.day ?? '2026-03-10';
  const spec: WorldSpec = { ...buildWorldSpec(baseScenario, day), ...options.world };
  let now = at('13:00', day);
  const clock = () => now;
  const emulator = createGoogleHealthEmulator(new SyntheticWorld(spec), clock, options.faults);
  let calls = 0;
  const countingFetch: FetchFn = (input, init) => {
    calls += 1;
    return emulator(input, init);
  };
  let credentials: GoogleCredentials = DEMO_CREDENTIALS;
  const settings: Settings = {
    mode: 'live',
    timeZone: 'Europe/London',
    config: parseConfig(options.config ?? {}),
    notifyProvider: 'ntfy',
    ntfy: { baseUrl: 'https://ntfy.invalid', topic: 'pulsewatch-test-topic-000000', token: null },
    telegram: { botToken: null, chatId: null },
    statusToken: null,
    google: credentials,
    demoScenario: 'normal-day',
    demoAnchor: null,
    ...options.settings,
  };
  const queue = new SimulatedQueue(clock);
  return {
    queue,
    calls: () => calls,
    setCredentials: (next) => {
      credentials = next;
    },
    async run(when, kind = 'cron', scope) {
      now = typeof when === 'number' ? when : at(when, day);
      const google = settings.google ? credentials : null;
      const deps: CheckDependencies = {
        db: env.DB,
        queue,
        settings: { ...settings, google },
        health: google
          ? new GoogleHealthClient({
              tokens: new RefreshTokenAccessTokens(google, countingFetch, clock),
              fetch: countingFetch,
              log: silentLogger,
              sleep: () => Promise.resolve(),
            })
          : null,
        credentialFingerprint: google ? await credentialFingerprint(google) : null,
        canClearNotifications: true,
        now: clock,
        log: silentLogger,
      };
      return runCheck(
        deps,
        kind === 'cron' ? { kind, scheduledTime: now, ...(scope ? { scope } : {}) } : { kind },
      );
    },
  };
}

const notifications = () =>
  env.DB.prepare('SELECT id, rule_id, status FROM notifications ORDER BY created_at').all<{
    id: string;
    rule_id: string;
    status: string;
  }>();
const op = async (key: string) =>
  (await env.DB.prepare('SELECT value FROM ops WHERE key = ?').bind(key).first<{ value: string }>())?.value ??
  null;
const ruleVersion = async (id: string) =>
  (
    await env.DB.prepare('SELECT version FROM rule_state WHERE rule_id = ?')
      .bind(id)
      .first<{ version: number }>()
  )?.version ?? null;

const removedAt14 = { offWrist: [{ start: at('14:00'), end: at('23:59') }] };
const apiCalls = async (runId: string) =>
  (await env.DB.prepare('SELECT api_calls FROM runs WHERE id = ?').bind(runId).first<{ api_calls: number }>())
    ?.api_calls ?? null;

describe('scheduled check pipeline (D1)', () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  it('processes each cron slot exactly once, even when delivered twice (or concurrently)', async () => {
    const h = harness({ world: removedAt14 });
    for (const clock of ['14:00', '14:10', '14:20', '14:30']) await h.run(clock);
    const duplicate = await h.run('14:30');
    expect(duplicate).toMatchObject({ skipped: true, outcome: 'skipped' });

    const [a, b] = await Promise.all([h.run('14:40'), h.run('14:40')]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
    expect((await notifications()).results.filter((n) => n.rule_id === 'deviceOffWrist')).toHaveLength(1);
  });

  it('a manual check right after a cron check cannot fast-forward confirmation', async () => {
    const h = harness({ world: removedAt14 });
    for (const clock of ['14:00', '14:10', '14:20']) await h.run(clock);
    const cron = await h.run('14:30');
    expect(cron.rules.deviceOffWrist).toBe('pending:POSSIBLY_OFF_WRIST');
    const manual = await h.run(at('14:32'), 'manual');
    expect(manual.rules.deviceOffWrist).toBe('pending:POSSIBLY_OFF_WRIST');
    expect((await h.run('14:40')).rules.deviceOffWrist).toBe('alerting:CONFIRMED_OFF_WRIST');
  });

  it('runs a full check every tenth minute and wear checks in between', () => {
    expect(scopeForSlot(Date.parse('2026-03-10T14:00:00Z'))).toBe('full');
    expect(scopeForSlot(Date.parse('2026-03-10T14:30:00Z'))).toBe('full');
    expect(scopeForSlot(Date.parse('2026-03-10T14:01:00Z'))).toBe('wear');
    expect(scopeForSlot(Date.parse('2026-03-10T14:59:00Z'))).toBe('wear');
  });

  it('checks wear every minute: one API call while worn, alert at the sync that proves removal', async () => {
    const h = harness({
      world: removedAt14,
      config: { rules: { deviceOffWrist: { staleAfterMinutes: 5, confirmationChecks: 1 } } },
    });
    await h.run('13:50');
    // The tracker synced at 13:48, so heart rate is fresh: one call, off-wrist rule only.
    const worn = await h.run('13:51', 'cron', 'wear');
    expect(Object.keys(worn.rules)).toEqual(['deviceOffWrist']);
    expect(await apiCalls(worn.runId)).toBe(1);

    // Removed at 14:00. It syncs at 14:03 (too soon to prove anything) and 14:18.
    let alertedAt: string | null = null;
    for (let minute = 1; minute <= 25 && alertedAt === null; minute++) {
      const clock = `14:${String(minute).padStart(2, '0')}`;
      const result = await h.run(clock, 'cron', minute % 10 === 0 ? 'full' : 'wear');
      if (result.rules.deviceOffWrist === 'alerting:CONFIRMED_OFF_WRIST') alertedAt = clock;
      if (minute % 10 !== 0) expect(await apiCalls(result.runId)).toBeLessThanOrEqual(2);
    }
    expect(alertedAt).toBe('14:18');
    const alerts = (await notifications()).results.filter((n) => n.rule_id === 'deviceOffWrist');
    expect(alerts).toHaveLength(1);
  });

  it('counts Google failures per full check, so wear checks do not hasten the outage alert', async () => {
    const h = harness({ faults: [{ match: /^(GET|POST) \/v4\//, status: 503 }] });
    for (let minute = 1; minute <= 9; minute++) await h.run(at('13:00') + minute * MINUTE_MS, 'cron', 'wear');
    expect(await op('google.consecutive_failures')).toBe('0');
    await h.run('13:10', 'cron', 'full');
    expect(await op('google.consecutive_failures')).toBe('1');
  });

  it('a Google outage freezes wear state, counts failures and raises one service alert', async () => {
    const h = harness({
      world: removedAt14,
      faults: [{ match: /^(GET|POST) \/v4\//, status: 503 }],
    });
    // Healthy start, then the API goes down while the tracker is still worn.
    const healthy = harness({ world: removedAt14 });
    await healthy.run('13:00');
    const results = [];
    for (let i = 1; i <= 7; i++) results.push(await h.run(at('13:00') + i * 10 * MINUTE_MS));
    expect(results.every((r) => r.outcome === 'failed')).toBe(true);
    expect(results.every((r) => r.rules.deviceOffWrist === 'insufficient_data:heart_rate_unavailable')).toBe(
      true,
    );
    expect(await op('google.consecutive_failures')).toBe('7');
    const alerts = (await notifications()).results.filter((n) => n.rule_id === 'serviceHealth');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.id).toMatch(/^serviceHealth:outage:/);
  });

  it('an invalid_grant opens the auth circuit, alerts once, and recovers when credentials change', async () => {
    const h = harness({
      faults: [{ match: /^POST \/token$/, status: 400, body: '{"error":"invalid_grant"}', times: 1 }],
    });
    const first = await h.run('13:00');
    expect(first.rules.serviceHealth).toBe('alerting:reauthorization_required');
    expect(await op('auth.status')).toBe('reauthorization_required');

    const callsBefore = h.calls();
    const second = await h.run('13:10');
    expect(h.calls()).toBe(callsBefore); // circuit open: no Google traffic at all
    expect(second.rules.serviceHealth).toBe('alerting:reauthorization_required');
    expect((await notifications()).results.filter((n) => n.rule_id === 'serviceHealth')).toHaveLength(1);

    // `npm run oauth` stores a new refresh token → new fingerprint → retried.
    h.setCredentials({ ...DEMO_CREDENTIALS, refreshToken: 'fresh-token' });
    const resumed = await h.run('13:20');
    expect(h.calls()).toBeGreaterThan(callsBefore);
    expect(resumed.rules.serviceHealth).toBe('ok:healthy');
    expect(await op('auth.status')).toBe('ok');
    // The alert was never delivered here (no queue drain), so it is cancelled.
    const auth = (await notifications()).results.find((n) => n.rule_id === 'serviceHealth');
    expect(auth?.status).toBe('cancelled');
  });

  it('tracks when credentials were first used and warns before a Testing-mode token lapses', async () => {
    const h = harness({ config: { rules: { serviceHealth: { refreshTokenLifetimeDays: 7 } } } });
    await h.run('10:00');
    expect(await op('auth.current_since')).toBe(String(at('10:00')));
    // Same credentials six days and two hours later.
    const later = await h.run(at('12:00', '2026-03-16'));
    expect(later.rules.serviceHealth).toBe('alerting:token_expiring');
    const alerts = (await notifications()).results.filter((n) => n.id.startsWith('serviceHealth:expiry:'));
    expect(alerts).toHaveLength(1);
    // Renewal (new refresh token) resets the clock.
    h.setCredentials({ ...DEMO_CREDENTIALS, refreshToken: 'renewed-token' });
    await h.run(at('12:10', '2026-03-16'));
    expect(await op('auth.current_since')).toBe(String(at('12:10', '2026-03-16')));
  });

  it('runs safely before OAuth is configured', async () => {
    const h = harness({ settings: { google: null } });
    const result = await h.run('13:00');
    expect(h.calls()).toBe(0);
    expect(result.rules.serviceHealth).toBe('insufficient_data:awaiting_oauth');
    expect(result.rules.deviceOffWrist).toBe('insufficient_data:heart_rate_unavailable');
    expect(result.outcome).toBe('degraded');
  });

  it('without device access (scope not granted) it still works, but hedges', async () => {
    const h = harness({ world: removedAt14, faults: [{ match: /pairedDevices$/, status: 403 }] });
    const states: string[] = [];
    for (const clock of ['14:00', '14:10', '14:20', '14:30', '14:40'])
      states.push((await h.run(clock)).rules.deviceOffWrist!);
    expect(states.at(-1)).toBe('alerting:SYNC_STALE');
  });

  it('treats a malformed heart-rate response as missing data, not as "off wrist"', async () => {
    const h = harness({
      faults: [{ match: /heart-rate\/dataPoints$/, status: 200, body: '{"dataPoints": "nope"}' }],
    });
    const result = await h.run('13:00');
    expect(result.rules.deviceOffWrist).toBe('insufficient_data:heart_rate_unavailable');
    expect(result.outcome).toBe('degraded');
  });

  it('suppresses alerts beyond the daily safety budget', async () => {
    const h = harness({ world: removedAt14, config: { notifications: { maxPerDay: 1 } } });
    await env.DB.prepare(
      "INSERT INTO notifications (id, rule_id, kind, severity, status, next_attempt_at, created_at, expires_at) VALUES ('earlier', 'sleep', 'alert', 'notice', 'sent', 0, ?, ?)",
    )
      .bind(at('09:00'), at('10:00'))
      .run();
    for (const clock of ['14:00', '14:10', '14:20', '14:30', '14:40']) await h.run(clock);
    const offWrist = (await notifications()).results.find((n) => n.rule_id === 'deviceOffWrist');
    expect(offWrist?.status).toBe('suppressed');
    expect(await op('notify.suppressed_total')).toBe('1');
  });

  it('keeps D1 writes minimal in steady state', async () => {
    const h = harness();
    await h.run('13:00');
    await h.run('13:10');
    const version = await ruleVersion('deviceOffWrist');
    for (const clock of ['13:20', '13:30', '13:40']) await h.run(clock);
    // Wear state unchanged (NORMAL): its row is never rewritten.
    expect(await ruleVersion('deviceOffWrist')).toBe(version);
  });

  it('applies retention once per day', async () => {
    const h = harness();
    const old = at('13:00') - 40 * 24 * 60 * MINUTE_MS;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO notifications (id, rule_id, kind, severity, status, next_attempt_at, created_at, expires_at) VALUES ('old', 'sleep', 'alert', 'notice', 'sent', 0, ?, ?)",
      ).bind(old, old),
      env.DB.prepare(
        "INSERT INTO notifications (id, rule_id, kind, severity, payload, status, next_attempt_at, created_at, expires_at) VALUES ('stale', 'inactivity', 'alert', 'notice', '{}', 'pending', 0, ?, ?)",
      ).bind(at('12:00'), at('12:30')),
      env.DB.prepare(
        "INSERT INTO runs (id, trigger, started_at, outcome) VALUES ('ancient', 'cron', ?, 'ok')",
      ).bind(old),
      env.DB.prepare(
        "INSERT INTO daily_metrics (metric, day, value, updated_at) VALUES ('steps', '2025-01-01', 1, 0)",
      ),
    ]);
    await h.run('13:00');
    const ids = (await notifications()).results.map((n) => [n.id, n.status]);
    expect(ids).toContainEqual(['stale', 'expired']);
    expect(ids.map(([id]) => id)).not.toContain('old');
    expect(await env.DB.prepare("SELECT 1 FROM runs WHERE id = 'ancient'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM daily_metrics WHERE day = '2025-01-01'").first()).toBeNull();
    expect(await op('retention.last_day')).toBe('2026-03-10');
  });

  it('handles the spring-forward DST morning: brief dated correctly, sleep duration real', async () => {
    // The synthetic sleeper keeps the same real sleep length, so after the
    // clocks go forward they wake around 08:05 BST; the brief waits for them.
    const day = '2026-03-29';
    const h = harness({ day });
    const results = [];
    const clocks = [
      '07:20',
      '07:30',
      '07:40',
      '07:50',
      '08:00',
      '08:10',
      '08:20',
      '08:30',
      '08:40',
      '08:50',
      '09:00',
    ];
    for (const clock of clocks) results.push(await h.run(clock));
    expect(results[0]!.rules.morningBrief).toBe('not_due:before_window');
    expect(results[1]!.rules.morningBrief).toBe('pending:awaiting_data');
    const brief = (await notifications()).results.find((n) => n.rule_id === 'morningBrief');
    expect(brief?.id).toBe(`morningBrief:${day}`);
    const sleep = await env.DB.prepare(
      "SELECT value FROM daily_metrics WHERE metric = 'sleep_minutes' AND day = ?",
    )
      .bind(day)
      .first<{ value: number }>();
    expect(sleep?.value).toBeGreaterThan(380);
  });
});
