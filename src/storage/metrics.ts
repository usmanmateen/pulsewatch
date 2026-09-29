import type { DailyMetric, DailyValue, LocalDate } from '../domain/types';
import type { StoredBaseline } from '../rules/types';

/**
 * Upserts daily values in one statement (a 60-day backfill is still a single
 * query), skipping rows whose value is unchanged so repeated syncs of the
 * same day cost reads but not writes.
 */
export function upsertDailyValuesStatement(
  db: D1Database,
  values: readonly DailyValue[],
  now: number,
): D1PreparedStatement | null {
  if (values.length === 0) return null;
  const rows = values.map((v) => [v.metric, v.day, v.value]);
  return db
    .prepare(
      'INSERT INTO daily_metrics (metric, day, value, updated_at) ' +
        "SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'), ? " +
        'FROM json_each(?) AS j WHERE true ' +
        'ON CONFLICT (metric, day) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at ' +
        'WHERE daily_metrics.value <> excluded.value',
    )
    .bind(now, JSON.stringify(rows));
}

export async function loadDailyValues(
  db: D1Database,
  metrics: readonly DailyMetric[],
  fromDay: LocalDate,
): Promise<DailyValue[]> {
  if (metrics.length === 0) return [];
  const placeholders = metrics.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT metric, day, value FROM daily_metrics WHERE metric IN (${placeholders}) AND day >= ? ORDER BY day`,
    )
    .bind(...metrics, fromDay)
    .all<DailyValue>();
  return results;
}

export async function countDailyValues(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare('SELECT metric, COUNT(*) AS days FROM daily_metrics GROUP BY metric')
    .all<{ metric: string; days: number }>();
  return Object.fromEntries(results.map((row) => [row.metric, row.days]));
}

interface BaselineRow {
  metric: DailyMetric;
  computed_for: string;
  window_start: string;
  window_end: string;
  samples: number;
  transform: 'none' | 'log';
  mean: number;
  median: number;
  std_dev: number;
  mad: number;
  center: number;
  spread: number;
}

export function saveBaselinesStatement(
  db: D1Database,
  baselines: readonly StoredBaseline[],
  now: number,
): D1PreparedStatement | null {
  if (baselines.length === 0) return null;
  const field = (name: string) => `json_extract(j.value, '$.${name}')`;
  return db
    .prepare(
      'INSERT INTO baselines (metric, computed_for, window_start, window_end, samples, transform, mean, median, ' +
        `std_dev, mad, center, spread, computed_at) SELECT ${field('metric')}, ${field('computedFor')}, ` +
        `${field('windowStart')}, ${field('windowEnd')}, ${field('samples')}, ${field('transform')}, ` +
        `${field('mean')}, ${field('median')}, ${field('standardDeviation')}, ${field('mad')}, ` +
        `${field('center')}, ${field('spread')}, ? FROM json_each(?) AS j WHERE true ` +
        'ON CONFLICT (metric) DO UPDATE SET computed_for = excluded.computed_for, window_start = excluded.window_start, ' +
        'window_end = excluded.window_end, samples = excluded.samples, transform = excluded.transform, ' +
        'mean = excluded.mean, median = excluded.median, std_dev = excluded.std_dev, mad = excluded.mad, ' +
        'center = excluded.center, spread = excluded.spread, computed_at = excluded.computed_at',
    )
    .bind(now, JSON.stringify(baselines));
}

export async function loadBaselines(db: D1Database): Promise<StoredBaseline[]> {
  const { results } = await db.prepare('SELECT * FROM baselines').all<BaselineRow>();
  return results.map((row) => ({
    metric: row.metric,
    computedFor: row.computed_for,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    samples: row.samples,
    transform: row.transform,
    mean: row.mean,
    median: row.median,
    standardDeviation: row.std_dev,
    mad: row.mad,
    center: row.center,
    spread: row.spread,
  }));
}
