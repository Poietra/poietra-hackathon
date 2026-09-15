import { defineConfig } from '@playwright/test';
import effects from './effects.config';
export default defineConfig({ ...effects, testMatch: ['glow-initialization.spec.ts', 'glow-buffer.spec.ts'], outputDir: process.env.GLOW_RESULTS_DIR ?? '../../test-results/glow-initialization',
  use: { ...effects.use, baseURL: 'http://127.0.0.1:5189', trace: 'off' },
  webServer: { command: `corepack pnpm exec vite preview --outDir ${process.env.GLOW_BUILD_DIR ?? 'test-results/glow-initialization-build'} --host 127.0.0.1 --port 5189 --strictPort`, cwd: '../..', url: 'http://127.0.0.1:5189/tests/e2e/fixtures/glow-initialization.html', reuseExistingServer: false, timeout: 60_000 },
});
