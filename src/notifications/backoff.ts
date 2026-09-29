import type { RetryReason } from './types';

/**
 * Retry delay for a failed delivery attempt (1-based). Exponential from 30 s,
 * capped at 30 min, honouring Retry-After, with ±20% jitter so retries do not
 * synchronise.
 *
 * ntfy.sh's daily-quota rejection gets a 15-minute floor: the quota is per
 * egress IP, and spacing attempts out gives the Worker a chance to leave from
 * a different shared Cloudflare address.
 */
export function retryDelaySeconds(
  attempt: number,
  reason: RetryReason,
  retryAfterSeconds: number | undefined,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(30 * 2 ** Math.max(0, attempt - 1), 1800);
  const floor = reason === 'quota_exhausted' ? 900 : reason === 'rate_limited' ? 60 : 0;
  const requested = Math.min(retryAfterSeconds ?? 0, 3600);
  const delay = Math.max(exponential, floor, requested);
  const jitter = delay * 0.2 * (random() * 2 - 1);
  // Queues accept delays up to 24 hours.
  return Math.min(86_400, Math.max(5, Math.round(delay + jitter)));
}
