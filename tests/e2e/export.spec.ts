import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type {} from './fixtures/export';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/export.html');
  await page.waitForFunction(() => Boolean(window.exportFixture));
});

for (const format of ['mp4', 'webm'] as const) {
  test(`downloads and decodes a 102-frame ${format.toUpperCase()} with Japanese text and mathematics`, async ({ page }, testInfo) => {
    const capabilities = await page.evaluate(() => window.exportFixture.capabilities());
    expect(capabilities[format], `${format} must be supported in the Chrome acceptance environment`).toBe(true);
    const downloadPromise = page.waitForEvent('download');
    const report = await page.evaluate(format => window.exportFixture.export(format, true), format);
    const download = await downloadPromise;
    const videoPath = testInfo.outputPath(`poietra-demo.${format}`);
    await download.saveAs(videoPath);
    await testInfo.attach(`exported-${format}`, { path: videoPath, contentType: `video/${format}` });
    const reportPath = testInfo.outputPath('media-verification.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('media-verification', { path: reportPath, contentType: 'application/json' });

    expect(report.width).toBe(1280);
    expect(report.height).toBe(720);
    expect(report.packetCount).toBe(102);
    expect(report.duration).toBeCloseTo(3.4, 3);
    expect(report.durationMs).toBe(3400);
    expect(report.extension).toBe(format);
    expect(report.mimeType).toContain(format);
    expect(report.bytes).toBeGreaterThan(10_000);
    expect(report.mutationApplied).toBe(true);
    expect(report.timestamps[0]).toBe(0);
    report.timestamps.forEach((timestamp, index) => expect(timestamp).toBeCloseTo(index / 30, 3));
    expect(report.progress.at(-1)).toBe(1);
    report.progress.forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(index === 0 ? 0 : report.progress[index - 1]);
      expect(value).toBeLessThanOrEqual(1);
    });
    for (const region of [report.japanese, report.equation]) {
      expect(region.expectedInk).toBeGreaterThan(200);
      expect(region.actualInk).toBeGreaterThan(region.expectedInk * 0.8);
      expect(region.actualInk).toBeLessThan(region.expectedInk * 1.25);
      expect(region.meanAbsoluteError).toBeLessThan(12);
    }
    expect(report.background[0]).toBeLessThan(20);
    expect(report.background[1]).toBeLessThan(20);
    expect(report.background[2]).toBeLessThan(20);
    const screenshot = testInfo.outputPath(`preview-and-decoded-${format}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('preview-and-decoded-frame', { path: screenshot, contentType: 'image/png' });
  });
}

test('keeps IDs unique when previews share one document', async ({ page }) => {
  const ids = await page.evaluate(() => window.exportFixture.duplicateIds());
  expect(ids.generatedIdCount).toBeGreaterThan(0);
  expect(ids.duplicates).toEqual([]);
  const fontCss = await page.locator('#preview svg style').textContent();
  expect(fontCss).toContain('Poietra Noto Sans JP');
  expect(fontCss).toContain('data:font/woff2;base64,');
  const fonts = await page.evaluate(async () => {
    await document.fonts.load('40px "Poietra Noto Sans JP"', 'みんなで');
    return {
      japaneseLoaded: [...document.fonts].some(face => face.family === 'Poietra Noto Sans JP' && face.status === 'loaded'),
      interLoaded: [...document.fonts].some(face => face.family === 'Poietra Inter' && face.status === 'loaded'),
      japaneseUsable: document.fonts.check('40px "Poietra Noto Sans JP"', 'みんなで'),
    };
  });
  expect(fonts).toEqual({ japaneseLoaded: true, interLoaded: true, japaneseUsable: true });
  await expect(page.locator('#preview [data-object-id="japanese"]')).toBeVisible();
  await expect(page.locator('#preview [data-object-id="equation"]')).toBeVisible();
});

test('supports cancellation before starting and while encoding', async ({ page }) => {
  const capabilities = await page.evaluate(() => window.exportFixture.capabilities());
  const format: 'mp4' | 'webm' = capabilities.mp4 ? 'mp4' : 'webm';
  let downloads = 0;
  page.on('download', () => downloads++);
  for (const preAborted of [true, false]) {
    const cancellation = await page.evaluate(({ format, preAborted }: { format: 'mp4' | 'webm'; preAborted: boolean }) => window.exportFixture.cancel(format, preAborted), { format, preAborted });
    expect(cancellation.rejected).toBe(true);
    expect(cancellation.name).toBe('AbortError');
    if (!preAborted) {
      expect(cancellation.lastProgress).toBeGreaterThan(0);
      expect(cancellation.lastProgress).toBeLessThan(1);
    }
  }
  expect(downloads).toBe(0);
});

test('reports unavailable WebCodecs without presenting a successful export', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'VideoEncoder', { configurable: true, value: undefined });
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.exportFixture));
  const capabilities = await page.evaluate(() => window.exportFixture.capabilities());
  expect(capabilities.mp4).toBe(false);
  expect(capabilities.webm).toBe(false);
  expect(capabilities.reason?.length).toBeGreaterThan(10);
  const result = await page.evaluate(() => window.exportFixture.unsupportedExport());
  expect(result.rejected).toBe(true);
  expect(result.message.length).toBeGreaterThan(10);
});
