import { describe, expect, it } from 'vitest';
import { createGoogleHealthEmulator } from '../src/demo/google-emulator';
import { DEMO_CREDENTIALS } from '../src/demo/runner';
import { SCENARIOS, buildWorldSpec } from '../src/demo/scenarios';
import { SyntheticWorld } from '../src/demo/world';
import { GoogleHealthClient } from '../src/google/client';
import { RefreshTokenAccessTokens } from '../src/google/oauth';
import { silentLogger } from '../src/observability/log';
import { runDiagnostics } from '../src/pipeline/diagnostics';
import { at } from './helpers';

describe('Google API diagnostics', () => {
  it('reports request success and response structure, never values', async () => {
    const now = at('14:00');
    const fetch = createGoogleHealthEmulator(new SyntheticWorld(buildWorldSpec(SCENARIOS[0]!)), () => now);
    const client = new GoogleHealthClient({
      tokens: new RefreshTokenAccessTokens(DEMO_CREDENTIALS, fetch, () => now),
      fetch,
      log: silentLogger,
      sleep: () => Promise.resolve(),
    });
    const { contract, backfillDryRun } = await runDiagnostics(client, now, 'Europe/London');

    expect(contract.heartRateList).toMatchObject({ status: 200, newestFirst: null, items: 1 });
    expect(contract.heartRateRollup).toMatchObject({ status: 200, windowsRequested: 12 });
    expect(contract.heartRateRollup!.windowsOnGrid).toBe(contract.heartRateRollup!.windowsReturned);
    expect(contract.pairedDevices).toMatchObject({ status: 200, trackers: 1, withLastSyncTime: 1 });
    expect(contract.sleep3Days).toMatchObject({ status: 200 });
    // The emulator, like the live API, returns short sleep pages.
    expect(contract.sleepBackfillPages).toMatchObject({ status: 200, complete: true });
    expect(contract.sleepBackfillPages!.pages).toBeGreaterThan(4);
    expect(contract.dailySteps).toMatchObject({ status: 200, daysRequested: 59, items: 59 });

    expect(backfillDryRun.failures).toEqual([]);
    expect(backfillDryRun.daysWithData).toMatchObject({ steps: 59, resting_hr: 60 });
    expect(backfillDryRun.daysWithData.sleep_minutes).toBeGreaterThan(50);

    const text = JSON.stringify({ contract, backfillDryRun });
    // Structure only: no readings, timestamps or device identifiers.
    expect(text).not.toMatch(
      /beatsPerMinute|countSum|minutesAsleep|physicalTime|02:00:00:00:00:01|\d{4}-\d{2}-\d{2}/,
    );
  });
});
