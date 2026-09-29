import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { runScenario, type ScenarioRun } from '../src/demo/runner';
import { SCENARIOS, findScenario } from '../src/demo/scenarios';
import { createLogger, type LogLevel } from '../src/observability/log';

/**
 * End-to-end: synthetic Google Health API → real client/normaliser → rules →
 * D1 outbox → simulated queue → real consumer → emulated ntfy.
 */

async function run(id: string, logs?: string[]): Promise<ScenarioRun> {
  const scenario = findScenario(id);
  if (!scenario) throw new Error(`unknown scenario ${id}`);
  const log = logs ? createLogger({}, (_level: LogLevel, line: string) => logs.push(line)) : undefined;
  return runScenario(scenario, { db: env.DB, ...(log ? { log } : {}) });
}

const wearStates = (run: ScenarioRun): string[] =>
  run.events.flatMap((e) => (e.type === 'check' ? [e.result.rules.deviceOffWrist ?? ''] : []));

const titles = (run: ScenarioRun): string[] => run.delivered.map((m) => m.title);

describe('demo scenarios (full pipeline)', () => {
  it.each(SCENARIOS.map((s) => [s.id, s]))(
    '%s delivers exactly the expected notifications',
    async (id, scenario) => {
      const result = await run(id);
      const rulesNotified = result.delivered.map((m) => m.sequenceId.split('-')[0]);
      expect(rulesNotified.sort()).toEqual([...scenario.expectNotifications].sort());
    },
  );

  it('wearable removed: confirms after two stale checks and notifies once', async () => {
    const result = await run('wearable-removed');
    const states = wearStates(result);
    expect(states.some((s) => s.includes('POSSIBLY_OFF_WRIST'))).toBe(true);
    expect(states.filter((s) => s.includes('CONFIRMED_OFF_WRIST')).length).toBeGreaterThan(2);
    expect(titles(result)).toEqual(['Fitbit reminder']);
    expect(result.delivered[0]!.message).toMatch(/No heart-rate data has been recorded for \d+ minutes/);
    expect(result.delivered[0]!.message).toMatch(/Fitbit Air synced/);
  });

  it('wearable removed then recovered: clears the phone notification on recovery', async () => {
    const result = await run('wearable-removed-recovered');
    const states = wearStates(result);
    expect(states.some((s) => s.startsWith('ok:RECOVERED'))).toBe(true);
    expect(states.at(-1)).toBe('ok:NORMAL');
    expect(result.cleared).toEqual([result.delivered[0]!.sequenceId]);
  });

  it('stale sync: does not claim the tracker is off the wrist', async () => {
    const result = await run('stale-sync');
    expect(wearStates(result).some((s) => s.includes('CONFIRMED_OFF_WRIST'))).toBe(false);
    expect(titles(result)).toEqual(['Fitbit not syncing']);
    expect(result.delivered[0]!.message).toMatch(/can't tell whether you're wearing it/);
  });

  it('low battery: prefers a battery explanation', async () => {
    const result = await run('low-battery');
    expect(wearStates(result).some((s) => s.includes('BATTERY_LOW'))).toBe(true);
    expect(titles(result)).toEqual(['Fitbit battery may be flat']);
    expect(result.delivered[0]!.message).toMatch(/9% battery/);
  });

  it('empty battery: says it needs charging', async () => {
    const result = await run('empty-battery');
    expect(wearStates(result).some((s) => s.includes('BATTERY_EMPTY'))).toBe(true);
    expect(titles(result)).toEqual(['Fitbit needs charging']);
  });

  it('notification retry: survives ntfy quota 429s and delivers once', async () => {
    const result = await run('notification-retry');
    expect(result.rejected).toBe(2);
    expect(result.events.filter((e) => e.type === 'retry_scheduled')).toHaveLength(2);
    expect(titles(result)).toEqual(['Fitbit reminder']);
  });

  it('duplicate queue delivery: provider called once, duplicate acknowledged', async () => {
    const result = await run('duplicate-queue-delivery');
    expect(result.delivered).toHaveLength(1);
    expect(result.duplicatesIgnored).toBeGreaterThanOrEqual(1);
  });

  it('never writes health values into logs', async () => {
    const logs: string[] = [];
    const result = await run('short-sleep', logs);
    expect(result.delivered.length).toBeGreaterThan(0);
    const joined = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(joined).not.toMatch(/\b\d+h \d{2}m\b/); // durations such as "4h 55m"
    expect(joined).not.toMatch(/bpm|breaths|steps:/i);
    for (const message of result.delivered) expect(joined).not.toContain(message.message);
  });
});
