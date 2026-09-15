import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'export-dialog.spec.ts', workers: 1, timeout: 30000,
  outputDir: '/tmp/poietra-export-dialog-e2e', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1000, height: 850 }, acceptDownloads: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm dev', cwd: '../..', url: 'http://127.0.0.1:5173/api/health', reuseExistingServer: true },
});
