import { localDate } from '../domain/time';
import type { EpochMs } from '../domain/types';
import type { GoogleHealthClient } from '../google/client';
import { runGoogleDiagnostics, type ProbeReport } from '../google/diagnostics';
import { BACKFILL_DAYS, fetchDailyData } from './daily';

export interface DiagnosticsReport {
  contract: Record<string, ProbeReport>;
  backfillDryRun: {
    days: number;
    apiCalls: number;
    failures: string[];
    /** Number of days with a value, per metric. */
    daysWithData: Record<string, number>;
  };
}

/**
 * POST /admin/diagnostics: the API contract probes, then a dry run of the
 * first-sync fetch through the production code path. Nothing is stored, and
 * only counts and error codes are returned.
 */
export async function runDiagnostics(
  client: GoogleHealthClient,
  now: EpochMs,
  timeZone: string,
): Promise<DiagnosticsReport> {
  const contract = await runGoogleDiagnostics(client, now, timeZone, BACKFILL_DAYS);
  const callsBefore = client.stats.calls;
  const fetched = await fetchDailyData(client, localDate(now, timeZone), now, timeZone, BACKFILL_DAYS);
  const daysWithData: Record<string, number> = {};
  for (const value of fetched.values) daysWithData[value.metric] = (daysWithData[value.metric] ?? 0) + 1;
  return {
    contract,
    backfillDryRun: {
      days: BACKFILL_DAYS,
      apiCalls: client.stats.calls - callsBefore,
      failures: fetched.failures,
      daysWithData,
    },
  };
}
