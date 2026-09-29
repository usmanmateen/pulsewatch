import type { D1Migration } from 'cloudflare:test';
import type { WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Defined in vitest.config.ts; applied by test/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
