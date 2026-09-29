import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React components (renderer tests) use the automatic JSX runtime, like the app.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
