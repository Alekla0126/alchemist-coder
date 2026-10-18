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
    // Tests that run real git commands take well over 5 s on GitHub's Windows runners now and then.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
