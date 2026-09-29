import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React components (renderer tests) use the automatic JSX runtime, like the app.
  esbuild: { jsx: 'automatic' },
  // The same alias the desktop renderer builds with.
  resolve: { alias: { '@shared': fileURLToPath(new URL('./apps/desktop/src/shared', import.meta.url)) } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
