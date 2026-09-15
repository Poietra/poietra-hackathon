import { defineConfig } from '@playwright/test';
import effects from './effects.config';
export default defineConfig({
  ...effects, testMatch: 'effects-write.spec.ts', timeout: 180_000,
  outputDir: process.env.WRITE_RESULTS_DIR ?? '../../test-results/issue-5/regression',
  use: { ...effects.use, baseURL: 'http://127.0.0.1:5177', trace: 'off' },
  webServer: {
    command: 'corepack pnpm exec vite preview --outDir test-results/issue-5/build --host 127.0.0.1 --port 5177 --strictPort',
    cwd: '../..', url: 'http://127.0.0.1:5177/tests/e2e/fixtures/effects-write.html', reuseExistingServer: false, timeout: 60_000,
  },
});
