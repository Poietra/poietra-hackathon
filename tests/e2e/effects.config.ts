import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({
  testDir: '.', testMatch: 'effects.spec.ts', timeout: 180_000,
  expect: { timeout: 15_000 }, workers: 1, fullyParallel: false,
  outputDir: '../../test-results/effects', reporter: [['list']],
  use: {
    browserName: 'chromium', headless: true, viewport: { width: 1440, height: 960 },
    baseURL: 'http://127.0.0.1:5175', acceptDownloads: true, trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.CHROME_PATH ?? (existsSync(windowsChrome) ? windowsChrome : undefined) },
  },
  webServer: {
    command: process.env.EFFECTS_PREVIEW
      ? 'corepack pnpm exec vite preview --outDir test-results/effects-build --host 127.0.0.1 --port 5175 --strictPort'
      : 'corepack pnpm exec vite --host 127.0.0.1 --port 5175 --strictPort',
    cwd: '../..', url: 'http://127.0.0.1:5175/tests/e2e/fixtures/effects.html',
    reuseExistingServer: !process.env.CI && !process.env.EFFECTS_PREVIEW, timeout: 60_000,
  },
});
