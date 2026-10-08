import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Workspace packages ship TypeScript source, so they are bundled rather than externalized.
const workspace = ['@alchemist-coder/core', '@alchemist-coder/indexer', '@alchemist-coder/harness', '@alchemist-coder/providers-local', '@alchemist-coder/arena', '@alchemist-coder/extensions', '@alchemist-coder/archive', '@alchemist-coder/themes'];

// monaco-vim imports Monaco by its old file paths, which today's package no longer exports: they're
// pointed at the same files the app loads, so there's one Monaco.
const monacoVs = resolve(dirname(createRequire(import.meta.url).resolve('monaco-editor')), '..', '..', 'esm', 'vs');
const monacoForVim = [
  { find: /^monaco-editor\/esm\/vs\/(.+)$/, replacement: `${monacoVs}/$1.js` },
];

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
    resolve: { alias: [{ find: '@shared', replacement: resolve('src/shared') }, ...monacoForVim] },
    plugins: [react()],
  },
});
