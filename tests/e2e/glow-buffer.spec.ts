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

for (const kind of ['incomplete-framebuffer', 'allocation'] as const) {
  test(`real ${kind} errors publish only SVG fallback and release GPU resources`, async ({ page }, testInfo) => {
    const report = await page.evaluate(kind => window.glowBufferFixture.textureFailureFallback(kind), kind);
    await testInfo.attach(`glow-${kind}-failure`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(report.injectedFailures).toBeGreaterThan(0);
    expect(report.errors).toContain(report.expectedError);
    expect(report.backendAfterCreation).toBe('webgl2');
    expect(report.backendBeforeFailure).toBe('webgl2');
    expect(report.backendAfterRender).toBe('canvas2d');
    expect(report.publications).toBe(1);
    expect(report.fallback.differentChannels).toBe(0);
    expect(report.fallback.alphaEnergy).toBeGreaterThan(0);
    expect(report.releasedCanvasExtents).toEqual([{ width: 0, height: 0 }]);
    expect(report.afterFallback.allocations).toBeGreaterThan(report.baseline.allocations);
    for (const snapshot of [report.afterFallback, report.released]) {
      expect(snapshot.liveGpuResources).toBe(report.baseline.liveGpuResources);
      expect(snapshot.liveObjectUrls).toBe(report.baseline.liveObjectUrls);
    }
  });
}

test('failed texture resize can retry either requested or previous dimensions', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.glowBufferFixture.allocationRetry());
  await testInfo.attach('glow-allocation-retry', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  for (const sample of report.samples) {
    expect(sample.error).toContain(`WebGL error ${report.expectedError}`);
    expect(sample.errors).toContain(report.expectedError);
    expect(sample.injectedFailures).toBeGreaterThan(0);
    expect(sample.comparison.differentChannels).toBe(0);
    expect(sample.comparison.alphaEnergy).toBeGreaterThan(0);
  }
  expect(report.released.liveGpuResources).toBe(report.baseline.liveGpuResources);
  expect(report.released.liveObjectUrls).toBe(report.baseline.liveObjectUrls);
});
