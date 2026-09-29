import type { EpochMs } from '../domain/types';
import type { Settings } from '../env';
import { dispatchPending, insertIntentStatements, type NotificationQueue } from '../notifications/outbox';
import { operationalStatus, publicHealth } from '../observability/status';
import type { CheckResult } from '../pipeline/check';

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/**
 * Constant-time bearer token check. Both sides are hashed first so the
 * comparison is over equal-length digests regardless of input length.
 */
export async function isAuthorised(request: Request, expected: string | null): Promise<boolean> {
  if (!expected) return false;
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const encoder = new TextEncoder();
  const [given, wanted] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1]!.trim())),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(given, wanted);
}

export interface RouterDeps {
  db: D1Database;
  queue: NotificationQueue;
  settings: Settings;
  now: () => EpochMs;
  runManualCheck: () => Promise<CheckResult>;
  /** Google API contract checks (structure only); null when Google is not configured. */
  runDiagnostics: () => Promise<unknown>;
}

const unauthorised = () =>
  json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="pulsewatch"' });

export async function route(request: Request, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === '/health') {
    if (method !== 'GET' && method !== 'HEAD')
      return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    const health = await publicHealth(deps.db, deps.now());
    return json({ status: health.status }, health.httpStatus);
  }

  if (url.pathname === '/status') {
    if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    if (!(await isAuthorised(request, deps.settings.statusToken))) return unauthorised();
    return json(await operationalStatus(deps.db, deps.settings, deps.now()));
  }

  if (url.pathname === '/admin/diagnostics') {
    if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (!(await isAuthorised(request, deps.settings.statusToken))) return unauthorised();
    const report = await deps.runDiagnostics();
    return report === null ? json({ error: 'google_not_configured' }, 409) : json(report);
  }

  if (url.pathname === '/admin/check' || url.pathname === '/admin/test-notification') {
    if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (!(await isAuthorised(request, deps.settings.statusToken))) return unauthorised();

    if (url.pathname === '/admin/check') return json(await deps.runManualCheck());

    // End-to-end delivery test through the real outbox → queue → provider path.
    const now = deps.now();
    const id = `test:${now}`;
    await deps.db.batch(
      insertIntentStatements(
        deps.db,
        [
          {
            id,
            ruleId: 'serviceHealth',
            severity: 'info',
            title: 'PulseWatch test notification',
            body: 'If you can read this, the Worker → Queue → phone delivery path is working.',
            tags: ['white_check_mark'],
            ttlMinutes: 60,
          },
        ],
        now,
      ),
    );
    const dispatch = await dispatchPending(deps.db, deps.queue, now);
    return json({ id, enqueued: dispatch.enqueued, queueError: dispatch.queueError }, 202);
  }

  if (url.pathname === '/' && method === 'GET') {
    return json({ service: 'pulsewatch', endpoints: ['/health', '/status (auth)'] });
  }
  return json({ error: 'not_found' }, 404);
}
