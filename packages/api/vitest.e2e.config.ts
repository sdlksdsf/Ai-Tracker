import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** End-to-end suite: boots the real Fastify app against a test database. */
export default defineConfig({
  resolve: {
    alias: {
      '@platematch/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    sequence: { concurrent: false },
  },
});
