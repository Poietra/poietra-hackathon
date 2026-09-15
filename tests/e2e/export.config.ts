import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export default defineConfig({
  testDir: '.',
  testMatch: 'export.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: '../../test-results/export',
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1100 },
    baseURL: 'http://127.0.0.1:5174',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? (existsSync(windowsChrome) ? windowsChrome : undefined),
    },
  },
  webServer: {
    command: process.env.EXPORT_PREVIEW
      ? 'corepack pnpm exec vite preview --outDir test-results/export-build --host 127.0.0.1 --port 5174 --strictPort'
      : 'corepack pnpm exec vite --host 127.0.0.1 --port 5174 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:5174/tests/e2e/fixtures/export.html',
    reuseExistingServer: !process.env.CI && !process.env.EXPORT_PREVIEW,
    timeout: 60_000,
  },
});
