import type { PulseWatchConfig } from '../config/schema';
import { addDays } from '../domain/time';
import { DAY_MS, type LocalDate } from '../domain/types';

export interface RetentionResult {
  notificationsDeleted: number;
  notificationsExpired: number;
  runsDeleted: number;
  dailyValuesDeleted: number;
}

/**
 * Enforces the retention policy documented in docs/DATA.md. Runs once per
 * local day from the scheduled check.
 */
export async function applyRetention(
  db: D1Database,
  now: number,
  today: LocalDate,
  retention: PulseWatchConfig['retention'],
): Promise<RetentionResult> {
  const [expired, notifications, runs, daily] = await db.batch([
    // Undelivered notifications past their TTL: drop the content, keep the audit row.
    db
      .prepare(
        "UPDATE notifications SET status = 'expired', payload = NULL, lease_token = NULL, finished_at = ? " +
          "WHERE status IN ('pending', 'sending') AND expires_at <= ?",
      )
      .bind(now, now),
    db
      .prepare("DELETE FROM notifications WHERE created_at < ? AND status NOT IN ('pending', 'sending')")
      .bind(now - retention.notificationDays * DAY_MS),
    db.prepare('DELETE FROM runs WHERE started_at < ?').bind(now - retention.runDays * DAY_MS),
    db.prepare('DELETE FROM daily_metrics WHERE day < ?').bind(addDays(today, -retention.dailyMetricsDays)),
  ]);
  return {
    notificationsExpired: expired?.meta.changes ?? 0,
    notificationsDeleted: notifications?.meta.changes ?? 0,
    runsDeleted: runs?.meta.changes ?? 0,
    dailyValuesDeleted: daily?.meta.changes ?? 0,
  };
}
