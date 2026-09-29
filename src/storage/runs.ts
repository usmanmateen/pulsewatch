export type RunTrigger = 'cron' | 'manual' | 'demo';
export type RunOutcome = 'ok' | 'degraded' | 'failed' | 'skipped';

/**
 * Claims a run id. For cron runs the id is derived from the scheduled time,
 * so a duplicate delivery of the same trigger finds the row already present
 * and does nothing: exactly-once processing per cron slot.
 */
export async function beginRun(
  db: D1Database,
  id: string,
  trigger: RunTrigger,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO runs (id, trigger, started_at, outcome) VALUES (?, ?, ?, 'running') ON CONFLICT (id) DO NOTHING",
    )
    .bind(id, trigger, now)
    .run();
  return result.meta.changes === 1;
}

export interface RunSummary {
  outcome: RunOutcome;
  apiCalls: number;
  apiFailures: number;
  notifications: number;
  /** ruleId → status. Statuses only, never values. */
  rules: Record<string, string>;
}

export function finishRunStatement(
  db: D1Database,
  id: string,
  summary: RunSummary,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE runs SET finished_at = ?, outcome = ?, api_calls = ?, api_failures = ?, notifications = ?, ' +
        'rule_summary = ? WHERE id = ?',
    )
    .bind(
      now,
      summary.outcome,
      summary.apiCalls,
      summary.apiFailures,
      summary.notifications,
      JSON.stringify(summary.rules),
      id,
    );
}
