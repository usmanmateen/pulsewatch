import { addDays, localDate } from '../domain/time';
import { DAY_MS, HOUR_MS, MINUTE_MS, type EpochMs } from '../domain/types';
import { FIELDS, WEARABLES_FAMILY, dailyStepsRequest, type GoogleHealthClient } from './client';

/**
 * Contract checks against the live Google Health API: does each request the
 * pipeline depends on work, and does the response have the shape the code
 * assumes (ordering, window alignment, pagination, payload size)?
 *
 * Reports structure only — HTTP status, counts, booleans, byte sizes and
 * Google's validation message for rejected requests. It never returns health
 * values, timestamps of readings, or anything else from a response body.
 */

export interface ProbeReport {
  status: number;
  bytes: number;
  googleStatus?: string;
  detail?: string;
  [key: string]: unknown;
}

type Probe = Awaited<ReturnType<GoogleHealthClient['probe']>>;

const iso = (at: EpochMs): string => new Date(at).toISOString();

/** Walks at most this many sleep pages when measuring pagination. */
const SLEEP_PAGE_PROBE_LIMIT = 15;

function items(body: unknown, key: string): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') return [];
  const list = (body as Record<string, unknown>)[key];
  return Array.isArray(list)
    ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
}

function nextPageToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const token = (body as { nextPageToken?: unknown }).nextPageToken;
  return typeof token === 'string' && token !== '' ? token : null;
}

function base(probe: Probe): ProbeReport {
  return {
    status: probe.status,
    bytes: probe.bytes,
    ...(probe.googleStatus ? { googleStatus: probe.googleStatus } : {}),
    ...(probe.detail ? { detail: probe.detail } : {}),
  };
}

const get = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
    value,
  );

export async function runGoogleDiagnostics(
  client: GoogleHealthClient,
  now: EpochMs,
  timeZone: string,
  backfillDays: number,
): Promise<Record<string, ProbeReport>> {
  const report: Record<string, ProbeReport> = {};
  const today = localDate(now, timeZone);

  // Newest-first ordering is what lets the off-wrist check fetch a single item.
  const hr = await client.probe('GET', 'dataTypes/heart-rate/dataPoints', {
    params: { filter: `heart_rate.sample_time.physical_time >= "${iso(now - 6 * HOUR_MS)}"`, pageSize: '10' },
    fields: FIELDS.heartRateTime,
  });
  const times = items(hr.body, 'dataPoints')
    .map((p) => Date.parse(String(get(p, 'heartRate', 'sampleTime', 'physicalTime'))))
    .filter(Number.isFinite);
  report.heartRateList = {
    ...base(hr),
    items: times.length,
    newestFirst: times.length < 2 ? null : times.every((t, i) => i === 0 || times[i - 1]! >= t),
    hasNextPage: nextPageToken(hr.body) !== null,
  };

  // Rollups: are empty windows omitted, and do windows sit on the requested grid?
  const windowMs = 5 * MINUTE_MS;
  const windowEnd = Math.floor(now / windowMs) * windowMs;
  const windowStart = windowEnd - 12 * windowMs;
  for (const [name, dataType, key] of [
    ['heartRateRollup', 'heart-rate', 'heartRate'],
    ['stepsRollup', 'steps', 'steps'],
  ] as const) {
    const probe = await client.probe('POST', `dataTypes/${dataType}/dataPoints:rollUp`, {
      body: {
        range: { startTime: iso(windowStart), endTime: iso(windowEnd) },
        windowSize: `${windowMs / 1000}s`,
        dataSourceFamily: WEARABLES_FAMILY,
        pageSize: 1000,
      },
      fields: FIELDS.rollup,
    });
    const windows = items(probe.body, 'rollupDataPoints');
    report[name] = {
      ...base(probe),
      windowsRequested: 12,
      windowsReturned: windows.length,
      windowsWithValue: windows.filter((w) => get(w, key) !== undefined).length,
      windowsOnGrid: windows.filter((w) => {
        const start = Date.parse(String(w.startTime));
        return (start - windowStart) % windowMs === 0 && Date.parse(String(w.endTime)) - start === windowMs;
      }).length,
    };
  }

  const devices = await client.probe('GET', 'pairedDevices', {
    params: { pageSize: '20' },
    fields: FIELDS.devices,
  });
  const deviceList = items(devices.body, 'pairedDevices');
  report.pairedDevices = {
    ...base(devices),
    items: deviceList.length,
    trackers: deviceList.filter((d) => d.deviceType === 'TRACKER').length,
    withLastSyncTime: deviceList.filter((d) => typeof d.lastSyncTime === 'string').length,
    withBatteryLevel: deviceList.filter((d) => typeof d.batteryLevel === 'number').length,
    batteryStatusFormats: [...new Set(deviceList.map((d) => typeof d.batteryStatus))],
    macAddressReturned: deviceList.some((d) => 'macAddress' in d),
  };

  // Sleep: the recent window used by routine syncs, then every page of the backfill window.
  const sleepFilter = (days: number) =>
    `sleep.interval.end_time >= "${iso(now - days * DAY_MS)}" AND sleep.interval.end_time < "${iso(now + MINUTE_MS)}"`;
  const sleepRecent = await client.probe('GET', 'dataTypes/sleep/dataPoints', {
    params: { filter: sleepFilter(3), pageSize: '25' },
    fields: FIELDS.sleep,
  });
  const sleeps = items(sleepRecent.body, 'dataPoints');
  report.sleep3Days = {
    ...base(sleepRecent),
    items: sleeps.length,
    processed: sleeps.filter((s) => get(s, 'sleep', 'metadata', 'processed') === true).length,
    withSummary: sleeps.filter((s) => get(s, 'sleep', 'summary', 'minutesAsleep') !== undefined).length,
  };

  const itemsPerPage: number[] = [];
  let sleepPage: Probe;
  let pageToken: string | null = null;
  do {
    sleepPage = await client.probe('GET', 'dataTypes/sleep/dataPoints', {
      params: { filter: sleepFilter(backfillDays + 1), pageSize: '25', ...(pageToken ? { pageToken } : {}) },
      fields: FIELDS.sleep,
    });
    itemsPerPage.push(items(sleepPage.body, 'dataPoints').length);
    pageToken = sleepPage.status === 200 ? nextPageToken(sleepPage.body) : null;
  } while (pageToken && itemsPerPage.length < SLEEP_PAGE_PROBE_LIMIT);
  report.sleepBackfillPages = {
    ...base(sleepPage),
    pages: itemsPerPage.length,
    itemsPerPage,
    complete: sleepPage.status === 200 && pageToken === null,
  };

  // Wear coverage: what the off-wrist check can see. Which sources write heart
  // rate, and which 5-minute windows have any. Relative minutes only; the mask
  // never requests heart-rate values.
  const since = windowEnd - 36 * windowMs;
  const provenanceRequest = {
    params: { filter: `heart_rate.sample_time.physical_time >= "${iso(since)}"`, pageSize: '10000' },
    fields:
      'dataPoints(heartRate(sampleTime(physicalTime)),dataSource(recordingMethod,platform,' +
      'device(formFactor,displayName),application(packageName))),nextPageToken',
  };
  let provenance = await client.probe('GET', 'dataTypes/heart-rate/dataPoints', provenanceRequest);
  const provenanceMasked = provenance.status !== 400;
  if (!provenanceMasked) {
    provenance = await client.probe('GET', 'dataTypes/heart-rate/dataPoints', {
      params: provenanceRequest.params,
    });
  }
  const timeline = Array.from({ length: 36 }, () => '.');
  const bySource = new Map<string, { samples: number; newest: number }>();
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : '-');
  for (const point of items(provenance.body, 'dataPoints')) {
    const at = Date.parse(String(get(point, 'heartRate', 'sampleTime', 'physicalTime')));
    if (!Number.isFinite(at)) continue;
    const source = [
      text(get(point, 'dataSource', 'device', 'formFactor')),
      text(get(point, 'dataSource', 'device', 'displayName')),
      text(get(point, 'dataSource', 'platform')),
      text(get(point, 'dataSource', 'recordingMethod')),
      text(get(point, 'dataSource', 'application', 'packageName')),
    ].join(' | ');
    const entry = bySource.get(source) ?? { samples: 0, newest: 0 };
    entry.samples += 1;
    entry.newest = Math.max(entry.newest, at);
    bySource.set(source, entry);
    const slot = Math.floor((at - since) / windowMs);
    if (slot >= 0 && slot < timeline.length) timeline[slot] = '#';
  }
  report.heartRateLast3Hours = {
    ...base(provenance),
    masked: provenanceMasked,
    hasNextPage: nextPageToken(provenance.body) !== null,
    // One character per 5 minutes, oldest first: '#' = at least one sample.
    timeline: timeline.join(''),
    sources: [...bySource].map(([source, entry]) => ({
      source,
      samples: entry.samples,
      newestMinutesAgo: Math.round((now - entry.newest) / MINUTE_MS),
    })),
  };

  const dayStart = windowEnd - 288 * windowMs;
  const hrDay = await client.probe('POST', 'dataTypes/heart-rate/dataPoints:rollUp', {
    body: {
      range: { startTime: iso(dayStart), endTime: iso(windowEnd) },
      windowSize: `${windowMs / 1000}s`,
      dataSourceFamily: WEARABLES_FAMILY,
      pageSize: 1000,
    },
    fields: FIELDS.rollup,
  });
  const covered = new Set(
    items(hrDay.body, 'rollupDataPoints')
      .filter((w) => get(w, 'heartRate') !== undefined)
      .map((w) => Date.parse(String(w.startTime))),
  );
  const gaps: Array<{ endedMinutesAgo: number; minutes: number }> = [];
  let emptyRun = 0;
  for (let start = dayStart; start <= windowEnd; start += windowMs) {
    if (start < windowEnd && !covered.has(start)) {
      emptyRun += 1;
      continue;
    }
    if (emptyRun >= 3) {
      gaps.push({ endedMinutesAgo: Math.round((now - start) / MINUTE_MS), minutes: emptyRun * 5 });
    }
    emptyRun = 0;
  }
  report.heartRateGaps24Hours = {
    ...base(hrDay),
    windows: 288,
    windowsWithHeartRate: covered.size,
    // Gaps of 15 minutes or more; endedMinutesAgo 0-5 means still ongoing.
    gaps,
  };

  // Reading density per 15 minutes over 24 hours. Sparse stray readings from
  // an unworn tracker still look like "recent data" to a latest-sample check.
  const bucketMs = 3 * windowMs;
  const densityStart = windowEnd - 96 * bucketMs;
  const perBucket = Array.from({ length: 96 }, () => 0);
  let densityPage: Probe;
  let densityToken: string | null = null;
  let densityPages = 0;
  do {
    densityPage = await client.probe('GET', 'dataTypes/heart-rate/dataPoints', {
      params: {
        filter: `heart_rate.sample_time.physical_time >= "${iso(densityStart)}"`,
        pageSize: '10000',
        ...(densityToken ? { pageToken: densityToken } : {}),
      },
      fields: FIELDS.heartRateTime,
    });
    densityPages += 1;
    for (const point of items(densityPage.body, 'dataPoints')) {
      const at = Date.parse(String(get(point, 'heartRate', 'sampleTime', 'physicalTime')));
      const bucket = Math.floor((at - densityStart) / bucketMs);
      if (bucket >= 0 && bucket < perBucket.length) perBucket[bucket] = perBucket[bucket]! + 1;
    }
    densityToken = densityPage.status === 200 ? nextPageToken(densityPage.body) : null;
  } while (densityToken && densityPages < 8);
  report.heartRateDensity24Hours = {
    ...base(densityPage),
    pages: densityPages,
    complete: densityToken === null,
    bucketMinutes: 15,
    firstBucketStartedMinutesAgo: Math.round((now - densityStart) / MINUTE_MS),
    samplesPerBucket: perBucket,
  };

  // The exact request the pipeline sends (shared builder), over the backfill span.
  const steps = await client.probe('POST', 'dataTypes/steps/dataPoints:dailyRollUp', {
    body: dailyStepsRequest(addDays(today, 1 - backfillDays), today),
    fields: FIELDS.dailySteps,
  });
  const stepDays = items(steps.body, 'rollupDataPoints');
  report.dailySteps = {
    ...base(steps),
    daysRequested: backfillDays - 1,
    items: stepDays.length,
    // Days returned without a total: "no data" rather than a measured zero.
    withoutValue: stepDays.filter((d) => get(d, 'steps', 'countSum') === undefined).length,
    zeroValue: stepDays.filter((d) => String(get(d, 'steps', 'countSum')) === '0').length,
    hasNextPage: nextPageToken(steps.body) !== null,
  };

  return report;
}
