import type { PulseWatchConfig } from '../config/schema';
import type { EpochMs } from '../domain/types';
import { errorCode, type Logger } from '../observability/log';
import { inactivityRule } from './inactivity';
import { morningBriefRule } from './morning-brief';
import { deviceOffWristRule } from './off-wrist/rule';
import { serviceHealthRule } from './service-health';
import { sleepRule } from './sleep';
import { hrvRule, restingHeartRateRule } from './trend';
import type {
  AnyHealthRule,
  DailyView,
  DataRequirement,
  NotificationIntent,
  Observations,
  RuleId,
  RuleStatus,
  SystemFacts,
} from './types';

/** Evaluation order matters only for readability of logs; rules are independent. */
export const RULES: readonly AnyHealthRule[] = [
  deviceOffWristRule,
  inactivityRule,
  sleepRule,
  restingHeartRateRule,
  hrvRule,
  morningBriefRule,
  serviceHealthRule,
];

/** JSON with sorted keys, so state comparisons ignore property order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return inner;
  });
}

/** Parses persisted state; an unknown or outdated shape falls back to the initial state. */
export function loadRuleState(rule: AnyHealthRule, raw: unknown, log?: Logger): unknown {
  if (raw === undefined) return rule.initialState();
  const parsed = rule.stateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  log?.warn('rule.state_reset', { rule: rule.id });
  return rule.initialState();
}

export function collectNeeds(
  rules: readonly AnyHealthRule[],
  config: PulseWatchConfig,
  states: ReadonlyMap<string, unknown>,
  now: EpochMs,
  timeZone: string,
): Set<DataRequirement> {
  const needs = new Set<DataRequirement>();
  for (const rule of rules) {
    const ruleConfig: unknown = rule.selectConfig(config.rules);
    const state = loadRuleState(rule, states.get(rule.id));
    for (const need of rule.needs({ now, timeZone, schedule: config.schedule, config: ruleConfig, state })) {
      needs.add(need);
    }
  }
  return needs;
}

export interface RuleEvaluation {
  ruleId: RuleId;
  status: RuleStatus;
  detail: string | null;
  state: unknown;
  changed: boolean;
}

export interface EngineInput {
  now: EpochMs;
  timeZone: string;
  config: PulseWatchConfig;
  observations: Observations;
  daily: DailyView | null;
  system: SystemFacts;
  /** Raw persisted state per rule id. */
  states: ReadonlyMap<string, unknown>;
  log: Logger;
}

export interface EngineResult {
  evaluations: RuleEvaluation[];
  notifications: NotificationIntent[];
  resolved: string[];
}

export function evaluateRules(rules: readonly AnyHealthRule[], input: EngineInput): EngineResult {
  const evaluations: RuleEvaluation[] = [];
  const notifications: NotificationIntent[] = [];
  const resolved: string[] = [];

  for (const rule of rules) {
    const raw = input.states.get(rule.id);
    const previous = loadRuleState(rule, raw, input.log);
    const baselineJson = stableStringify(raw === undefined ? rule.initialState() : previous);
    const ruleConfig: unknown = rule.selectConfig(input.config.rules);
    try {
      const outcome = rule.evaluate({
        now: input.now,
        timeZone: input.timeZone,
        schedule: input.config.schedule,
        config: ruleConfig,
        state: previous,
        observations: input.observations,
        daily: input.daily,
        system: input.system,
      });
      notifications.push(...(outcome.notifications ?? []));
      resolved.push(...(outcome.resolved ?? []));
      evaluations.push({
        ruleId: rule.id,
        status: outcome.status,
        detail: outcome.detail ?? null,
        state: outcome.state,
        changed: stableStringify(outcome.state) !== baselineJson,
      });
    } catch (error) {
      // One broken rule must not stop the others (or corrupt its own state).
      input.log.error('rule.failed', { rule: rule.id, error: errorCode(error) });
      evaluations.push({
        ruleId: rule.id,
        status: 'error',
        detail: errorCode(error),
        state: previous,
        changed: false,
      });
    }
  }
  return { evaluations, notifications, resolved };
}
