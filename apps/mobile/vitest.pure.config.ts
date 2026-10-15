import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Vitest config for the platform-independent modules.
 *
 * `lib/format.ts`, `lib/parse.ts` and the i18n catalogues have no React Native
 * dependency, so they run in plain Node — fast, and they work in CI without
 * installing the native toolchain. Component tests use the jest-expo preset in
 * `jest.config.js` instead, which is what provides the RN runtime mocks.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@platematch/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/format.test.ts', 'tests/parse.test.ts', 'tests/i18n.test.ts', 'tests/api.test.ts'],
  },
});
