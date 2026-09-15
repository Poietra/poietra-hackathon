import { defineConfig } from '@playwright/test';

const baseURL = process.env.POIETRA_TEST_URL || 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['editor.spec.ts', 'canvas.spec.ts', 'ai*.spec.ts', 'project*.spec.ts', 'timeline.spec.ts', 'layers.spec.ts', 'structure.spec.ts', 'clipboard.spec.ts', 'keyboard.spec.ts', ...(process.env.POIETRA_TEST_URL ? [] : ['painter-preview.spec.ts'])],
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  use: { baseURL, viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: process.env.POIETRA_TEST_URL ? undefined : { command: 'pnpm dev', url: `${baseURL}/api/health`, reuseExistingServer: !process.env.CI },
});
