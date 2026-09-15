import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'media-export.spec.ts', timeout: 120000, workers: 1,
  outputDir: '../../test-results/media-export', use: { baseURL: 'http://127.0.0.1:5173', headless: true, viewport: { width: 1280, height: 800 } },
  webServer: { command: 'pnpm dev', url: 'http://127.0.0.1:5173/api/health', reuseExistingServer: !process.env.CI },
});
