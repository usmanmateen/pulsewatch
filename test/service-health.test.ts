import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS } from '../src/domain/types';
import { serviceHealthRule, type ServiceHealthState } from '../src/rules/service-health';
import { at, config, context, systemFacts } from './helpers';

const testingMode = { ...config.rules.serviceHealth, refreshTokenLifetimeDays: 7 };

const evaluate = (
  facts: Parameters<typeof systemFacts>[0],
  state: ServiceHealthState = serviceHealthRule.initialState(),
  ruleConfig: typeof config.rules.serviceHealth = testingMode,
  now = at('12:00'),
) => serviceHealthRule.evaluate(context(now, ruleConfig, state, { system: systemFacts(facts) }));

describe('service health: Testing-mode token expiry', () => {
  it('warns once, about a day before a 7-day token lapses', () => {
    expect(evaluate({ credentialAgeMs: 5 * DAY_MS }).notifications ?? []).toHaveLength(0);

    const warned = evaluate({ credentialAgeMs: 6 * DAY_MS + 2 * HOUR_MS });
    expect(warned).toMatchObject({ status: 'alerting', detail: 'token_expiring' });
    expect(warned.notifications?.[0]).toMatchObject({
      id: 'serviceHealth:expiry:abc',
      title: 'Google access expires soon',
    });
    expect(warned.notifications?.[0]?.body).toMatch(/expires in about 22h 00m/);
    expect(warned.notifications?.[0]?.body).toMatch(/npm run oauth/);

    const again = evaluate({ credentialAgeMs: 6 * DAY_MS + 5 * HOUR_MS }, warned.state);
    expect(again.notifications ?? []).toHaveLength(0);
  });

  it('re-arms for renewed credentials (new fingerprint)', () => {
    const warned = evaluate({ credentialAgeMs: 6.5 * DAY_MS });
    const renewed = evaluate({ credentialAgeMs: HOUR_MS, credentialFingerprint: 'def' }, warned.state);
    expect(renewed.notifications ?? []).toHaveLength(0);
    expect(renewed.detail).toBe('healthy');
    const later = evaluate({ credentialAgeMs: 6.5 * DAY_MS, credentialFingerprint: 'def' }, renewed.state);
    expect(later.notifications?.[0]?.id).toBe('serviceHealth:expiry:def');
  });

  it('stays quiet when no token lifetime is configured (published app)', () => {
    const outcome = evaluate({ credentialAgeMs: 60 * DAY_MS }, undefined, config.rules.serviceHealth);
    expect(outcome.notifications ?? []).toHaveLength(0);
    expect(outcome.detail).toBe('healthy');
  });

  it('waits for waking hours', () => {
    const night = evaluate({ credentialAgeMs: 6.5 * DAY_MS }, undefined, testingMode, at('02:00'));
    expect(night.notifications ?? []).toHaveLength(0);
    expect(night.state.expiryWarnedFor).toBeNull();
  });

  it('alerts overnight too when notifyDuringSleepHours is set', () => {
    const outage = { consecutiveFailedChecks: 6 };
    const held = evaluate(outage, undefined, config.rules.serviceHealth, at('02:00'));
    expect(held.notifications ?? []).toHaveLength(0);
    const overnight = { ...config.rules.serviceHealth, notifyDuringSleepHours: true };
    const sent = evaluate(outage, undefined, overnight, at('02:00'));
    expect(sent.notifications?.[0]?.title).toBe("PulseWatch can't reach Google Health");
  });

  it('prefers the re-authorisation alert once the token has actually been rejected', () => {
    const outcome = evaluate({ credentialAgeMs: 7.2 * DAY_MS, auth: 'reauthorization_required' });
    expect(outcome.detail).toBe('reauthorization_required');
    expect(outcome.notifications?.map((n) => n.title)).toEqual(['PulseWatch needs re-authorising']);
  });

  it('reads old persisted state that predates the expiry field', () => {
    const parsed = serviceHealthRule.stateSchema.safeParse({ auth: null, outage: null });
    expect(parsed.success && parsed.data.expiryWarnedFor).toBeNull();
  });
});
