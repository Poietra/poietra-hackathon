import { expect, test } from '@playwright/test';
import type {} from './fixtures/glow-buffer';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/glow-buffer.html');
  await page.waitForFunction(() => Boolean(window.glowBufferFixture));
});

test('Glow output matches fresh buffers without excess allocation during aspect changes', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.glowBufferFixture.bufferSequence());
  await testInfo.attach('glow-buffer-sequence', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  for (const sample of report.samples) {
    expect(sample.after).toEqual({ width: sample.width, height: sample.height });
    expect(sample.writes).toHaveLength(Number(sample.width !== sample.before.width) + Number(sample.height !== sample.before.height));
    const maximumArea = Math.max(sample.before.width * sample.before.height, sample.width * sample.height);
    for (const write of sample.writes) expect(write.width * write.height).toBeLessThanOrEqual(maximumArea);
    for (const comparison of sample.comparisons) {
      expect(comparison.differentChannels).toBe(0);
      expect(comparison.maximumError).toBe(0);
      expect(comparison.alphaEnergy).toBeGreaterThan(0);
      if (comparison.source) expect(comparison.source.differentChannels).toBe(0);
    }
  }
  expect(report.disposedExtent).toEqual({ width: 0, height: 0 });
  expect(report.afterDispose.liveGpuResources).toBe(report.baseline.liveGpuResources);
  expect(report.afterSecondDispose.liveGpuResources).toBe(report.baseline.liveGpuResources);
  expect(report.disposedRenderError).toContain('disposed');
});

test('invalid extents leave the renderer usable and device limits trigger SVG fallback', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.glowBufferFixture.invalidExtentFallback());
  await testInfo.attach('glow-buffer-fallback', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.rejected).toHaveLength(5);
  expect(report.writesAfterInvalidExtents).toHaveLength(0);
  expect(report.validAfterErrors.differentChannels).toBe(0);
  expect(report.before).toBe('webgl2');
  expect(report.after).toBe('canvas2d');
  expect(report.center).toEqual([255, 255, 255, 255]);
  expect(report.released.liveGpuResources).toBe(report.baseline.liveGpuResources);
});
