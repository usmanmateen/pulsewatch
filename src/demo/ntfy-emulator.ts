import type { EpochMs } from '../domain/types';
import type { FetchFn } from '../google/http';

/**
 * Emulates the ntfy publish and clear endpoints. Records what a phone would
 * have received and can replay ntfy.sh's real quota rejection
 * (HTTP 429, code 42908) to demonstrate the retry path.
 */

export interface EmulatedMessage {
  at: EpochMs;
  topic: string;
  title: string;
  message: string;
  tags: string[];
  priority: number;
  sequenceId: string;
}

export interface NtfyEmulator {
  fetch: FetchFn;
  delivered: EmulatedMessage[];
  cleared: Array<{ at: EpochMs; sequenceId: string }>;
  rejected: Array<{ at: EpochMs; status: number; code: number | null }>;
}

export interface NtfyFailurePlan {
  /** Reject this many publish attempts before accepting. */
  rejectFirst: number;
  status: 429 | 500 | 503;
  /** ntfy error code; 42908 is the daily message quota. */
  code?: number;
}

export function createNtfyEmulator(now: () => EpochMs, failures?: NtfyFailurePlan): NtfyEmulator {
  let rejectionsLeft = failures?.rejectFirst ?? 0;
  const emulator: NtfyEmulator = {
    delivered: [],
    cleared: [],
    rejected: [],
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      const clear = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/(clear|read)$/.exec(url.pathname);
      if (clear && (method === 'PUT' || method === 'GET')) {
        emulator.cleared.push({ at: now(), sequenceId: clear[2]! });
        return Response.json({ event: 'message_clear' });
      }

      if (url.pathname !== '/' || method !== 'POST') return new Response('not found', { status: 404 });
      const body = await request.json<Record<string, unknown>>();
      const text = (value: unknown): string => (typeof value === 'string' ? value : '');

      if (rejectionsLeft > 0 && failures) {
        rejectionsLeft -= 1;
        emulator.rejected.push({ at: now(), status: failures.status, code: failures.code ?? null });
        const error =
          failures.code === 42908
            ? 'limit reached: daily message quota reached; increase your limits with a paid plan, see https://ntfy.sh'
            : 'service unavailable';
        return Response.json(
          { code: failures.code ?? failures.status * 100, http: failures.status, error },
          { status: failures.status },
        );
      }

      const message: EmulatedMessage = {
        at: now(),
        topic: text(body.topic),
        title: text(body.title),
        message: text(body.message),
        tags: Array.isArray(body.tags) ? body.tags.map(text) : [],
        priority: typeof body.priority === 'number' ? body.priority : 3,
        sequenceId: text(body.sequence_id),
      };
      emulator.delivered.push(message);
      return Response.json({
        id: `demo${emulator.delivered.length}`,
        time: Math.floor(now() / 1000),
        event: 'message',
      });
    },
  };
  return emulator;
}
