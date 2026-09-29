import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Workspace packages ship TypeScript source, so they are bundled rather than externalized.
const workspace = ['@alchemist-coder/core', '@alchemist-coder/indexer', '@alchemist-coder/harness', '@alchemist-coder/providers-local', '@alchemist-coder/arena', '@alchemist-coder/extensions', '@alchemist-coder/archive', '@alchemist-coder/themes'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspace })],
    // Sandboxed preload scripts must be CommonJS.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
  },
});
