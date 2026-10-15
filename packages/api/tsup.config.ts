import { defineConfig } from 'tsup';

/**
 * tsup bundles the API and the BullMQ worker into standalone ESM files.
 * Dependencies stay external (they are installed in production), workspace
 * sources (`@platematch/shared`) are inlined so the image only needs `dist/`.
 */
export default defineConfig({
  entry: {
    server: 'src/server.ts',
    worker: 'src/worker.ts',
    migrate: 'src/db/migrate.ts',
    seed: 'src/db/seed.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  dts: false,
  outDir: 'dist',
  // Workspace packages are resolved by tsup's bundler; everything else is external.
  noExternal: [/@platematch\/shared/],
  esbuildOptions(options) {
    options.outbase = 'src';
  },
  env: {
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  },
});
