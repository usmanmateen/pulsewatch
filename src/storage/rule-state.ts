export interface StoredRuleState {
  state: unknown;
  version: number;
}

export async function loadRuleStates(db: D1Database): Promise<Map<string, StoredRuleState>> {
  const { results } = await db
    .prepare('SELECT rule_id, state, version FROM rule_state')
    .all<{ rule_id: string; state: string; version: number }>();
  const states = new Map<string, StoredRuleState>();
  for (const row of results) {
    try {
      states.set(row.rule_id, { state: JSON.parse(row.state) as unknown, version: row.version });
    } catch {
      // Unreadable JSON: treat as absent; the rule restarts from its initial state.
    }
  }
  return states;
}

/**
 * Compare-and-swap write. If another run updated the rule in between, this
 * statement changes nothing and that run's newer state wins.
 */
export function saveRuleStateStatement(
  db: D1Database,
  ruleId: string,
  state: unknown,
  previousVersion: number | null,
  now: number,
): D1PreparedStatement {
  const json = JSON.stringify(state);
  if (previousVersion === null) {
    return db
      .prepare(
        'INSERT INTO rule_state (rule_id, state, version, updated_at) VALUES (?, ?, 1, ?) ' +
          'ON CONFLICT (rule_id) DO NOTHING',
      )
      .bind(ruleId, json, now);
  }
  return db
    .prepare(
      'UPDATE rule_state SET state = ?, version = version + 1, updated_at = ? WHERE rule_id = ? AND version = ?',
    )
    .bind(json, now, ruleId, previousVersion);
}
