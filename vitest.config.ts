import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Tests run inside workerd (the production Workers runtime) with a local D1
 * database migrated from the same SQL files that production uses.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only binding consumed by test/setup.ts.
          bindings: {
            TEST_MIGRATIONS: migrations,
            MODE: 'demo',
            STATUS_TOKEN: 'test-status-token-0123456789abcdef',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
    },
  };
});
