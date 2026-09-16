// Cold-cache lab measurement. Run separately from builds/tests on the same machine.
// POIETRA_PERF_URL=https://poietra.com POIETRA_PERF_OUTPUT=/tmp/home.json node scripts/measure-home.mjs
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const url = process.env.POIETRA_PERF_URL || 'http://127.0.0.1:5188';
const output = process.env.POIETRA_PERF_OUTPUT || 'test-results/home-performance.json';
const conditions = { viewport: { width: 390, height: 844 }, latencyMs: 150, downloadBytesPerSecond: 200000, cpuSlowdown: 4 };
const browser = await chromium.launch({ headless: true });
const samples = [];
try {
  for (const locale of ['en-US', 'ja-JP']) {
    const context = await browser.newContext({ locale, viewport: conditions.viewport, deviceScaleFactor: 1, isMobile: true });
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: conditions.latencyMs, downloadThroughput: conditions.downloadBytesPerSecond, uploadThroughput: 93750 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpuSlowdown });
      await page.addInitScript(() => {
        window.homeMetrics = { lcpMs: 0, cls: 0, longTaskBlockingMs: 0 };
        new PerformanceObserver(list => { for (const entry of list.getEntries()) { window.homeMetrics.lcpMs = entry.startTime; window.homeMetrics.lcpElement = entry.element?.tagName; } }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.homeMetrics.cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver(list => { for (const entry of list.getEntries()) window.homeMetrics.longTaskBlockingMs += Math.max(0, entry.duration - 50); }).observe({ type: 'longtask', buffered: true });
      });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.evaluate(() => document.fonts.ready);
      const sample = { locale, ...await page.evaluate(() => ({
        ...window.homeMetrics,
        fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
        ttfbMs: performance.getEntriesByType('navigation')[0].responseStart,
        resources: performance.getEntriesByType('resource').map(entry => ({ url: entry.name, transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize, startMs: entry.startTime, durationMs: entry.duration })),
      })) };
      samples.push(sample);
      console.log(JSON.stringify({ locale, lcpMs: sample.lcpMs, fcpMs: sample.fcpMs, cls: sample.cls, ttfbMs: sample.ttfbMs, longTaskBlockingMs: sample.longTaskBlockingMs, requests: sample.resources.length, resourceTransferBytes: sample.resources.reduce((sum, entry) => sum + entry.transferBytes, 0), fontRequests: sample.resources.filter(entry => /\.woff2?(?:\?|$)/.test(entry.url)).length }));
    } finally { await context.close(); }
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ url, measuredAt: new Date().toISOString(), conditions, samples }, null, 2));
} finally { await browser.close(); }
