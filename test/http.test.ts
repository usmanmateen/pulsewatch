import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../src/demo/runner';
import worker from '../src/index';

const TOKEN = 'test-status-token-0123456789abcdef';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://pulsewatch.example${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = { Authorization: `Bearer ${TOKEN}` };

describe('HTTP endpoints', () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
  });

  it('/health is public, minimal and reflects scheduler liveness', async () => {
    let response = await call('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'starting' });

    await env.DB.prepare("INSERT INTO ops (key, value, updated_at) VALUES ('check.last_at', ?, 0)")
      .bind(String(Date.now() - 60 * 60_000))
      .run();
    response = await call('/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded' });
  });

  it('/status requires the bearer token', async () => {
    expect((await call('/status')).status).toBe(401);
    const wrong = await call('/status', { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('WWW-Authenticate')).toMatch(/Bearer/);
    expect((await call('/status', { headers: auth })).status).toBe(200);
  });

  it('/status exposes operational data only — never health values', async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: '*/10 * * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // Distinctive synthetic values that must not leak.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO daily_metrics (metric, day, value, updated_at) VALUES ('resting_hr', '2026-03-10', 61.37, 0), ('hrv', '2026-03-10', 47.93, 0)",
      ),
      env.DB.prepare(
        "INSERT OR REPLACE INTO baselines (metric, computed_for, window_start, window_end, samples, transform, mean, median, std_dev, mad, center, spread, computed_at) VALUES ('resting_hr', '2026-03-10', '2026-02-06', '2026-03-07', 28, 'none', 57.77, 57.61, 1.93, 0.87, 57.61, 1.29, 0)",
      ),
    ]);

    const response = await call('/status', { headers: auth });
    const text = await response.text();
    const status = JSON.parse(text);
    expect(status).toMatchObject({ service: 'pulsewatch', mode: 'demo', scheduler: { healthy: true } });
    expect(status.baselines.resting_hr).toEqual({ samples: 28, computedFor: '2026-03-10' });
    expect(status.rules).toHaveLength(7);
    for (const leaked of ['61.37', '47.93', '57.77', '57.61', 'bpm', 'refresh', 'topic']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('sets security headers and rejects wrong methods and unknown paths', async () => {
    const health = await call('/health');
    expect(health.headers.get('Cache-Control')).toBe('no-store');
    expect(health.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(health.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect((await call('/health', { method: 'POST' })).status).toBe(405);
    expect((await call('/status', { method: 'DELETE', headers: auth })).status).toBe(405);
    expect((await call('/nope')).status).toBe(404);
  });

  it('admin actions require the token; the test notification goes through outbox and queue', async () => {
    expect((await call('/admin/test-notification', { method: 'POST' })).status).toBe(401);
    const response = await call('/admin/test-notification', { method: 'POST', headers: auth });
    expect(response.status).toBe(202);
    const body = await response.json<{ id: string; enqueued: number }>();
    expect(body.enqueued).toBe(1);
    const row = await env.DB.prepare('SELECT status FROM notifications WHERE id = ?').bind(body.id).first();
    expect(row).not.toBeNull();
  });

  it('a manual check runs the pipeline and returns codes, not values', async () => {
    const response = await call('/admin/check', { method: 'POST', headers: auth });
    expect(response.status).toBe(200);
    const result = await response.json<{ skipped: boolean; rules: Record<string, string> }>();
    expect(result.skipped).toBe(false);
    expect(Object.keys(result.rules)).toContain('deviceOffWrist');
  });
});
