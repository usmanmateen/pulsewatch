import * as z from 'zod';
import { formatDuration } from '../domain/format';
import { DAY_MS, MINUTE_MS } from '../domain/types';
import { isWakingHours } from './policy';
import type { HealthRule, NotificationIntent, RulesConfigSlice } from './types';

type ServiceHealthConfig = RulesConfigSlice<'serviceHealth'>;

/**
 * Self-monitoring. A health monitor that silently stops working gives false
 * reassurance, so lost authorisation, a sustained Google outage, or a
 * refresh token about to expire is itself worth one notification (and one only).
 */

const stateSchema = z.object({
  auth: z.object({ fingerprint: z.string().nullable(), notificationId: z.string() }).nullable(),
  outage: z.object({ startedAt: z.number(), notificationId: z.string() }).nullable(),
  /** Fingerprint of the credentials already warned about expiring. */
  expiryWarnedFor: z.string().nullable().default(null),
});
export type ServiceHealthState = z.infer<typeof stateSchema>;

export const serviceHealthRule: HealthRule<ServiceHealthConfig, ServiceHealthState> = {
  id: 'serviceHealth',
  name: 'PulseWatch service health',
  description: 'Warns when authorisation is lost or Google Health has been unreachable for a while.',
  severity: 'warning',
  stateSchema,
  initialState: () => ({ auth: null, outage: null, expiryWarnedFor: null }),
  selectConfig: (rules) => rules.serviceHealth,
  needs: () => [],

  evaluate({ now, timeZone, schedule, config, state, system }) {
    if (!config.enabled) return { state, status: 'disabled' };
    if (system.mode === 'demo') return { state, status: 'not_due', detail: 'demo_mode' };
    if (system.auth === 'not_configured') {
      return { state, status: 'insufficient_data', detail: 'awaiting_oauth' };
    }

    const next: ServiceHealthState = { ...state };
    const notifications: NotificationIntent[] = [];
    const resolved: string[] = [];
    const canNotify = config.notifyDuringSleepHours || isWakingHours(now, timeZone, schedule);

    const authBroken = system.auth === 'reauthorization_required' || system.auth === 'misconfigured';
    if (authBroken) {
      if (state.auth?.fingerprint !== system.credentialFingerprint && canNotify) {
        const id = `serviceHealth:auth:${system.credentialFingerprint ?? 'none'}`;
        notifications.push({
          id,
          ruleId: 'serviceHealth',
          severity: 'warning',
          title: 'PulseWatch needs re-authorising',
          body:
            system.auth === 'misconfigured'
              ? "Google rejected PulseWatch's OAuth client credentials, so health checks are paused. " +
                'Check the Google client ID and secret, then run `npm run oauth`.'
              : "Google no longer accepts PulseWatch's saved authorisation (it may have expired or been " +
                'revoked), so health checks are paused. Run `npm run oauth` to reconnect.',
          tags: ['warning'],
          ttlMinutes: 24 * 60,
        });
        next.auth = { fingerprint: system.credentialFingerprint, notificationId: id };
      }
    } else if (state.auth) {
      resolved.push(state.auth.notificationId);
      next.auth = null;
    }

    const outage = !authBroken && system.consecutiveFailedChecks >= config.failedChecksBeforeAlert;
    if (outage) {
      if (!state.outage && canNotify) {
        const id = `serviceHealth:outage:${now}`;
        notifications.push({
          id,
          ruleId: 'serviceHealth',
          severity: 'warning',
          title: "PulseWatch can't reach Google Health",
          body:
            `The last ${system.consecutiveFailedChecks} checks couldn't fetch data from Google Health, ` +
            'so wear reminders are paused. PulseWatch keeps retrying and will clear this when it recovers.',
          tags: ['warning'],
          ttlMinutes: 6 * 60,
        });
        next.outage = { startedAt: now, notificationId: id };
      }
    } else if (state.outage && system.consecutiveFailedChecks === 0) {
      resolved.push(state.outage.notificationId);
      next.outage = null;
    }

    // Testing-mode OAuth apps get 7-day refresh tokens: warn a day before.
    const lifetimeDays = config.refreshTokenLifetimeDays;
    const age = system.credentialAgeMs;
    const expiring =
      !authBroken &&
      lifetimeDays !== null &&
      age !== null &&
      system.credentialFingerprint !== null &&
      age >= (lifetimeDays - 1) * DAY_MS;
    if (expiring && state.expiryWarnedFor !== system.credentialFingerprint && canNotify) {
      const remaining = Math.max(0, lifetimeDays * DAY_MS - age);
      notifications.push({
        id: `serviceHealth:expiry:${system.credentialFingerprint}`,
        ruleId: 'serviceHealth',
        severity: 'warning',
        title: 'Google access expires soon',
        body:
          `PulseWatch's Google authorisation expires in about ${formatDuration(remaining / MINUTE_MS)} ` +
          `(the OAuth app is in Testing mode, where access lasts ${lifetimeDays} days). ` +
          'Run `npm run oauth` to renew it, or publish the app to production to stop this.',
        tags: ['hourglass'],
        ttlMinutes: 24 * 60,
      });
      next.expiryWarnedFor = system.credentialFingerprint;
    }

    const alerting = authBroken || outage || expiring;
    return {
      state: next,
      status: alerting ? 'alerting' : 'ok',
      detail: authBroken
        ? system.auth
        : outage
          ? 'google_unreachable'
          : expiring
            ? 'token_expiring'
            : 'healthy',
      notifications,
      resolved,
    };
  },
};
