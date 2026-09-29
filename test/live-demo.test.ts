import { describe, expect, it } from 'vitest';
import { createLiveDemoFetch } from '../src/demo/live';
import { DEMO_CREDENTIALS } from '../src/demo/runner';
import { HOUR_MS, MINUTE_MS } from '../src/domain/types';
import { SettingsError, loadSettings, type WorkerEnv } from '../src/env';
import { GoogleHealthClient } from '../src/google/client';
import { RefreshTokenAccessTokens } from '../src/google/oauth';
import { silentLogger } from '../src/observability/log';

describe('live demo (MODE=demo deployments)', () => {
  it('anchors a scripted scenario at DEMO_ANCHOR, whatever the time of day', async () => {
    // 07:05 London time; the scenario normally starts at 13:50 and removes the tracker at 14:00.
    const anchor = Date.parse('2026-09-27T06:05:00Z');
    let now = anchor + 60 * MINUTE_MS;
    const fetch = createLiveDemoFetch('wearable-removed-recovered', () => now, 'Europe/London', anchor);
    const client = new GoogleHealthClient({
      tokens: new RefreshTokenAccessTokens(DEMO_CREDENTIALS, fetch, () => now),
      fetch,
      log: silentLogger,
      sleep: () => Promise.resolve(),
    });

    // Removed at anchor + 10 min: the newest heart rate is from just before that.
    const whileOff = await client.latestHeartRateAt(now, 12 * HOUR_MS);
    expect(whileOff).toBeGreaterThan(anchor + 5 * MINUTE_MS);
    expect(whileOff).toBeLessThan(anchor + 10 * MINUTE_MS);
    const tracker = await client.pairedTracker();
    expect(tracker!.lastSyncAt).toBeGreaterThan(anchor + 45 * MINUTE_MS); // still syncing: strong evidence

    // Put back on at anchor + 75 min; after the next sync heart rate is fresh again.
    now = anchor + 100 * MINUTE_MS;
    expect(await client.latestHeartRateAt(now, 12 * HOUR_MS)).toBeGreaterThan(anchor + 75 * MINUTE_MS);
  });

  it('parses DEMO_ANCHOR and rejects nonsense', () => {
    const env = (value: string): WorkerEnv => ({
      DB: {} as D1Database,
      NOTIFICATIONS: {} as Queue,
      DEMO_ANCHOR: value,
    });
    expect(loadSettings(env('2026-09-27T06:05:00Z')).demoAnchor).toBe(Date.parse('2026-09-27T06:05:00Z'));
    expect(loadSettings(env('')).demoAnchor).toBeNull();
    expect(() => loadSettings(env('tomorrow-ish'))).toThrow(SettingsError);
  });
});
