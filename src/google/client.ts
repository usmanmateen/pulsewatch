import { parseLocalDate } from '../domain/time';
import type {
  ActivityWindow,
  DailyValue,
  DeviceStatus,
  EpochMs,
  LocalDate,
  SleepSession,
} from '../domain/types';
import type { Logger } from '../observability/log';
import {
  GoogleApiError,
  discardBody,
  googleErrorMessage,
  googleErrorStatus,
  kindForStatus,
  kindForThrown,
  readJsonBounded,
  type FetchFn,
} from './http';
import {
  dailySteps,
  dailySummaries,
  latestHeartRateTime,
  mergeActivityWindows,
  pageItems,
  rollupWindows,
  selectTracker,
  sleepSessions,
  type DailySummaryMetric,
} from './normalise';
import { OAuthError, type AccessTokenSource } from './oauth';

export const GOOGLE_HEALTH_API = 'https://health.googleapis.com/v4/users/me';

/** Google and Fitbit trackers only — excludes phone-counted and manually logged data. */
export const WEARABLES_FAMILY = 'users/me/dataSourceFamilies/google-wearables';

/**
 * Partial-response masks. Besides cutting payload size (and Worker CPU),
 * they make data minimisation structural: heart-rate *values* and device MAC
 * addresses are never requested at all.
 */
export const FIELDS = {
  heartRateTime: 'dataPoints(heartRate(sampleTime(physicalTime))),nextPageToken',
  rollup: 'rollupDataPoints(startTime,endTime,steps(countSum),heartRate(beatsPerMinuteAvg)),nextPageToken',
  devices: 'pairedDevices(deviceVersion,deviceType,lastSyncTime,batteryLevel,batteryStatus),nextPageToken',
  sleep:
    'dataPoints(name,sleep(interval(startTime,endTime,startUtcOffset,endUtcOffset),metadata(mainSleep,nap,processed),summary(minutesAsleep,minutesInSleepPeriod))),nextPageToken',
  // DailyRollUpDataPointsResponse has no nextPageToken (a mask naming it is rejected).
  dailySteps: 'rollupDataPoints(civilStartTime(date),steps(countSum))',
  resting_hr: 'dataPoints(dailyRestingHeartRate(date,beatsPerMinute)),nextPageToken',
  hrv: 'dataPoints(dailyHeartRateVariability(date,averageHeartRateVariabilityMilliseconds)),nextPageToken',
  respiratory_rate: 'dataPoints(dailyRespiratoryRate(date,breathsPerMinute)),nextPageToken',
} as const;

/** Data type path segments (kebab-case) and filter prefixes (snake_case). */
const DAILY_TYPES: Record<DailySummaryMetric, { path: string; filterField: string }> = {
  resting_hr: { path: 'daily-resting-heart-rate', filterField: 'daily_resting_heart_rate.date' },
  hrv: { path: 'daily-heart-rate-variability', filterField: 'daily_heart_rate_variability.date' },
  respiratory_rate: { path: 'daily-respiratory-rate', filterField: 'daily_respiratory_rate.date' },
};

export interface ClientStats {
  calls: number;
  failures: number;
  skippedPoints: number;
}

export interface GoogleHealthClientOptions {
  tokens: AccessTokenSource;
  fetch: FetchFn;
  log: Logger;
  baseUrl?: string;
  /** Injected so tests do not wait for real back-off delays. */
  sleep?: (ms: number) => Promise<void>;
}

const iso = (at: EpochMs): string => new Date(at).toISOString();

function civil(date: LocalDate): { date: { year: number; month: number; day: number } } {
  return { date: parseLocalDate(date) };
}

/** Upper bound on sleep pages per fetch; the 60-day first-run backfill took five in production. */
export const SLEEP_MAX_PAGES = 12;

/** Request body for the daily step roll-up. Shared with the diagnostics so the two cannot drift. */
export function dailyStepsRequest(from: LocalDate, toExclusive: LocalDate): Record<string, unknown> {
  return { range: { start: civil(from), end: civil(toExclusive) }, windowSizeDays: 1 };
}

export class GoogleHealthClient {
  readonly stats: ClientStats = { calls: 0, failures: 0, skippedPoints: 0 };
  /** Endpoints whose field mask Google has been seen to reject (per client, i.e. per invocation). */
  private readonly unmaskedPaths = new Set<string>();
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: GoogleHealthClientOptions) {
    this.baseUrl = options.baseUrl ?? GOOGLE_HEALTH_API;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Timestamp of the most recent heart-rate sample within the lookback, or
   * null if there is none. Relies on the documented newest-first ordering,
   * so a single-item page is enough.
   */
  async latestHeartRateAt(now: EpochMs, lookbackMs: number): Promise<EpochMs | null> {
    const body = await this.request('GET', 'dataTypes/heart-rate/dataPoints', {
      params: {
        filter: `heart_rate.sample_time.physical_time >= "${iso(now - lookbackMs)}"`,
        pageSize: '1',
      },
      fields: FIELDS.heartRateTime,
    });
    const { at, skipped } = latestHeartRateTime(body);
    this.stats.skippedPoints += skipped;
    return at;
  }

  /**
   * Fixed-width windows over [start, end) with step totals and whether any
   * heart rate was recorded. Two small rollup calls instead of thousands of
   * raw samples.
   */
  async activityWindows(start: EpochMs, end: EpochMs, windowMinutes: number): Promise<ActivityWindow[]> {
    const windowMs = windowMinutes * 60_000;
    const rollup = (dataType: string) =>
      this.request('POST', `dataTypes/${dataType}/dataPoints:rollUp`, {
        body: {
          range: { startTime: iso(start), endTime: iso(end) },
          windowSize: `${windowMinutes * 60}s`,
          dataSourceFamily: WEARABLES_FAMILY,
          pageSize: 1000,
        },
        fields: FIELDS.rollup,
      });
    const [stepsBody, heartRateBody] = await Promise.all([rollup('steps'), rollup('heart-rate')]);
    const steps = rollupWindows(pageItems(stepsBody, 'rollupDataPoints').items);
    const heartRate = rollupWindows(pageItems(heartRateBody, 'rollupDataPoints').items);
    this.stats.skippedPoints += steps.skipped + heartRate.skipped;
    return mergeActivityWindows(start, end, windowMs, steps.items, heartRate.items);
  }

  async pairedTracker(preferredModel?: string): Promise<DeviceStatus | null> {
    const body = await this.request('GET', 'pairedDevices', {
      params: { pageSize: '20' },
      fields: FIELDS.devices,
    });
    return selectTracker(body, preferredModel);
  }

  /**
   * Sleep sessions that ended within [endFrom, endTo). Sleep pages hold at
   * most 25 sessions and are often shorter (11 were returned for a 60-day
   * range), so the first-run backfill needs several pages.
   */
  async sleepSessions(endFrom: EpochMs, endTo: EpochMs): Promise<SleepSession[]> {
    const items = await this.listAll('dataTypes/sleep/dataPoints', 'dataPoints', {
      params: {
        filter: `sleep.interval.end_time >= "${iso(endFrom)}" AND sleep.interval.end_time < "${iso(endTo)}"`,
        pageSize: '25',
      },
      fields: FIELDS.sleep,
      maxPages: SLEEP_MAX_PAGES,
    });
    const sessions = sleepSessions(items);
    this.stats.skippedPoints += sessions.skipped;
    return sessions.items;
  }

  /** Daily summaries with a date in [from, toExclusive). */
  async dailyMetric(
    metric: DailySummaryMetric,
    from: LocalDate,
    toExclusive: LocalDate,
  ): Promise<DailyValue[]> {
    const type = DAILY_TYPES[metric];
    const items = await this.listAll(`dataTypes/${type.path}/dataPoints`, 'dataPoints', {
      params: {
        filter: `${type.filterField} >= "${from}" AND ${type.filterField} < "${toExclusive}"`,
        pageSize: '400',
      },
      fields: FIELDS[metric],
      maxPages: 3,
    });
    const values = dailySummaries(metric, items);
    this.stats.skippedPoints += values.skipped;
    return values.items;
  }

  /**
   * Total steps per local day in [from, toExclusive), all sources reconciled.
   * The response is a single page (up to 1,440 windows; the range limit is 90
   * days). Although the published schema lists `pageSize`, the live API
   * rejects any request that sets it with INVALID_ARGUMENT.
   */
  async dailySteps(from: LocalDate, toExclusive: LocalDate): Promise<DailyValue[]> {
    if (from >= toExclusive) return [];
    const body = await this.request('POST', 'dataTypes/steps/dataPoints:dailyRollUp', {
      body: dailyStepsRequest(from, toExclusive),
      fields: FIELDS.dailySteps,
    });
    const values = dailySteps(pageItems(body, 'rollupDataPoints').items);
    this.stats.skippedPoints += values.skipped;
    return values.items;
  }

  private async listAll(
    path: string,
    key: string,
    options: { params: Record<string, string>; fields: string; maxPages: number },
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < options.maxPages; page++) {
      const params: Record<string, string> = pageToken ? { ...options.params, pageToken } : options.params;
      const body = await this.request('GET', path, { params, fields: options.fields });
      const result = pageItems(body, key);
      items.push(...result.items);
      if (!result.nextPageToken) return items;
      if (seenTokens.has(result.nextPageToken)) throw new GoogleApiError('invalid_response');
      seenTokens.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    // A truncated window must never be mistaken for "no data".
    throw new GoogleApiError('invalid_response');
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { params?: Record<string, string>; body?: unknown; fields?: string },
  ): Promise<unknown> {
    let retriedAuth = false;
    let retriedTransient = false;
    let useMask = options.fields !== undefined && !this.unmaskedPaths.has(path);
    let maskRejected = false;

    for (;;) {
      const url = new URL(`${this.baseUrl}/${path}`);
      for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
      if (useMask && options.fields) url.searchParams.set('fields', options.fields);
      url.searchParams.set('prettyPrint', 'false');

      let response: Response;
      try {
        const token = await this.options.tokens.getAccessToken();
        this.stats.calls += 1;
        response = await this.options.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(10_000),
          redirect: 'manual',
        });
      } catch (error) {
        // Credential problems are reported separately from API health.
        if (error instanceof OAuthError) throw error;
        const kind = kindForThrown(error);
        if (!retriedTransient) {
          retriedTransient = true;
          await this.sleep(400);
          continue;
        }
        this.stats.failures += 1;
        throw new GoogleApiError(kind);
      }

      if (response.ok) {
        if (maskRejected) {
          // Only now is it certain the mask (not the request) was the problem.
          this.unmaskedPaths.add(path);
          this.options.log.warn('google.field_mask_rejected', { path });
        }
        return readJsonBounded(response);
      }

      let errorBody: unknown;
      try {
        errorBody = await readJsonBounded(response, 65_536);
      } catch {
        await discardBody(response);
      }
      const clientError = response.status >= 400 && response.status < 500;
      const error = new GoogleApiError(
        kindForStatus(response.status),
        response.status,
        googleErrorStatus(errorBody),
        clientError ? googleErrorMessage(errorBody) : undefined,
      );

      if (error.kind === 'unauthorized' && !retriedAuth) {
        retriedAuth = true;
        this.options.tokens.invalidate();
        continue;
      }
      if (error.kind === 'bad_request' && useMask) {
        // Could be the mask or the request itself: retry once without the mask to find out.
        useMask = false;
        maskRejected = true;
        continue;
      }
      if (error.retryable && !retriedTransient) {
        retriedTransient = true;
        await this.sleep(error.kind === 'rate_limited' ? 1_500 : 400);
        continue;
      }
      this.stats.failures += 1;
      if (error.kind === 'bad_request' || error.kind === 'forbidden' || error.kind === 'not_found') {
        this.options.log.warn('google.request_rejected', {
          path,
          status: error.status,
          googleStatus: error.googleStatus,
          detail: error.detail,
        });
      }
      throw error;
    }
  }

  /**
   * Diagnostics only: one authenticated request, never retried and never
   * thrown, so contract checks can report exactly what Google returned.
   */
  async probe(
    method: 'GET' | 'POST',
    path: string,
    options: { params?: Record<string, string>; body?: unknown; fields?: string } = {},
  ): Promise<{ status: number; bytes: number; body: unknown; googleStatus?: string; detail?: string }> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
    if (options.fields) url.searchParams.set('fields', options.fields);
    url.searchParams.set('prettyPrint', 'false');
    const token = await this.options.tokens.getAccessToken();
    this.stats.calls += 1;
    const response = await this.options.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    });
    const text = await response.text();
    let body: unknown = null;
    if (text.length <= 1_000_000) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return {
      status: response.status,
      bytes: text.length,
      body: response.ok ? body : null,
      googleStatus: response.ok ? undefined : googleErrorStatus(body),
      detail: response.ok ? undefined : googleErrorMessage(body),
    };
  }
}
