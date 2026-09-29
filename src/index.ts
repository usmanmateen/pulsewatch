import type { WorkerEnv } from './env';
import { json, route } from './http/router';
import { handleNotificationBatch } from './notifications/consumer';
import type { QueueMessageBody } from './notifications/types';
import { createLogger, errorCode } from './observability/log';
import { runCheck, scopeForSlot } from './pipeline/check';
import { runDiagnostics } from './pipeline/diagnostics';
import { createServices } from './services';

/**
 * PulseWatch Worker.
 *   scheduled — every minute: a wear check, and a full check every 10 minutes (Cron Trigger)
 *   queue     — notification delivery (Cloudflare Queues consumer)
 *   fetch     — /health, authenticated /status and admin actions
 */

/** Logs a sanitised error code, then rethrows so Cloudflare records the failure. */
async function reported<T>(handler: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    createLogger({ service: 'pulsewatch' }).error(`${handler}.unhandled`, { error: errorCode(error) });
    throw error;
  }
}

export default {
  async scheduled(controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    await reported('scheduled', async () => {
      const services = await createServices(env);
      await runCheck(services.check, {
        kind: 'cron',
        scheduledTime: controller.scheduledTime,
        scope: scopeForSlot(controller.scheduledTime),
      });
    });
  },

  async queue(batch: MessageBatch<QueueMessageBody>, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    await reported('queue', async () => {
      const services = await createServices(env);
      await handleNotificationBatch(batch, services.consumer);
    });
  },

  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    try {
      const services = await createServices(env);
      return await route(request, {
        db: env.DB,
        queue: env.NOTIFICATIONS,
        settings: services.settings,
        now: services.check.now,
        runManualCheck: () => runCheck(services.check, { kind: 'manual' }),
        runDiagnostics: () => {
          const client = services.check.health;
          return client
            ? runDiagnostics(client, services.check.now(), services.settings.timeZone)
            : Promise.resolve(null);
        },
      });
    } catch (error) {
      // Configuration problems are reported by name only; details stay in the logs.
      createLogger({ service: 'pulsewatch' }).error('http.unhandled', { error: errorCode(error) });
      return json({ error: 'internal_error', code: errorCode(error) }, 500);
    }
  },
} satisfies ExportedHandler<WorkerEnv, QueueMessageBody>;
