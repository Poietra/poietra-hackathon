import { defineConfig } from 'vite';

// Build the real renderer/exporter independently while the editor UI is developed.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'test-results/export-build',
    rollupOptions: { input: 'tests/e2e/fixtures/export.html' },
  },
});
