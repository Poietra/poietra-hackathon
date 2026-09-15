import { defineConfig } from 'vite';
export default defineConfig({ build: { target: 'es2022', outDir: 'test-results/issue-5/build', rollupOptions: { input: 'tests/e2e/fixtures/effects-write.html' } } });
