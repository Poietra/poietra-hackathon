import { expect, test, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type {} from './fixtures/effects';

async function saveReport(testInfo: TestInfo, name: string, report: unknown) {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/effects.html');
  await page.waitForFunction(() => Boolean(window.effectsFixture));
});

test('WebGL2 adds Glow only to selected objects and preserves animation and resize', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.smoke());
  expect(report.backend).toBe('webgl2');
  expect(report.changedPixels).toBeGreaterThan(100);
  expect(report.glowRing.lit.meanEnergy).toBeGreaterThan(report.glowRing.unlit.meanEnergy + 3);
  expect(report.unaffected.lit).toEqual(report.unaffected.unlit);
  expect(report.background.lit).toEqual(report.background.unlit);
  const motion = await page.evaluate(() => window.effectsFixture.animation());
  expect(motion.inputUnchanged).toBe(true);
  expect(motion.equationInk[0]).toBeLessThan(motion.equationInk[1]);
  expect(motion.equationInk[1]).toBeLessThan(motion.equationInk[2]);
  expect(motion.oldPosition.end).toBeLessThan(motion.oldPosition.start / 2);
  expect(motion.replay.meanAbsoluteError).toBeLessThan(0.1);
  const resized = await page.evaluate(() => window.effectsFixture.resize());
  expect(resized.letterbox).toEqual([8, 9, 11, 255]);
  expect(resized.content).toBeGreaterThan(100);
  expect([resized.width, resized.height]).toEqual([640, 360]);
  await saveReport(testInfo, 'webgl2-rendering', { report, motion, resized });
  await page.locator('body').screenshot({ path: testInfo.outputPath('glow-preview.png') });
});

test('Canvas 2D fallback remains usable when WebGL2 is unavailable', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects.html?backend=canvas2d');
  await page.waitForFunction(() => Boolean(window.effectsFixture));
  const report = await page.evaluate(() => window.effectsFixture.smoke());
  expect(report.backend).toBe('canvas2d');
  expect(report.changedPixels).toBeGreaterThan(100);
  expect(report.glowRing.lit.meanEnergy).toBeGreaterThan(report.glowRing.unlit.meanEnergy);
  await saveReport(testInfo, 'canvas-fallback', report);
});

test('actual WebGL context loss switches to Canvas 2D for later frames', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.contextLoss());
  expect(report.before).toBe('webgl2'); expect(report.after).toBe('canvas2d');
  expect(report.ink).toBeGreaterThan(200);
  await saveReport(testInfo, 'context-loss', report);
});

test('cancellation and dispose release resources without breaking a new painter', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.lifecycle());
  expect(report.preAborted).toBe('AbortError');
  expect(report.disposedDuringRender).toBe('AbortError');
  expect(report.disposedAfterRender).not.toBe('');
  expect(report.released.liveGpuResources).toBe(report.baseline.liveGpuResources);
  expect(report.released.liveObjectUrls).toBe(report.baseline.liveObjectUrls);
  expect(report.repeated.liveGpuResources).toBe(report.warmed.liveGpuResources);
  expect(report.nextBackend).toBe('webgl2');
  await saveReport(testInfo, 'painter-lifecycle', report);
});

for (const format of ['mp4', 'webm'] as const) {
  test(`saved ${format.toUpperCase()} matches the Canvas Glow at the same times`, async ({ page }, testInfo) => {
    const downloading = page.waitForEvent('download');
    const report = await page.evaluate(format => window.effectsFixture.export(format), format);
    const download = await downloading;
    const path = testInfo.outputPath(`poietra-glow.${format}`);
    await download.saveAs(path);
    await testInfo.attach(`glow-${format}`, { path, contentType: `video/${format}` });
    expect([report.width, report.height, report.packetCount]).toEqual([1280, 720, 102]);
    expect(report.duration).toBeCloseTo(3.4, 3);
    expect(report.backend).toBe('webgl2');
    report.timestamps.forEach((timestamp, index) => expect(timestamp).toBeCloseTo(index / 30, 3));
    expect(report.progress.at(-1)).toBe(1);
    for (const sample of report.comparisons) {
      expect(sample.meanAbsoluteError).toBeLessThan(8);
      expect(sample.japanese.expected.ink).toBeGreaterThan(200);
      expect(sample.japanese.actual.ink).toBeGreaterThan(sample.japanese.expected.ink * 0.75);
      if (sample.equation) expect(sample.equation.actual.ink).toBeGreaterThan(sample.equation.expected.ink * 0.75);
    }
    await saveReport(testInfo, 'glow-video-comparison', report);
    await page.locator('body').screenshot({ path: testInfo.outputPath(`canvas-and-decoded-${format}.png`) });
  });
}

test('records warmed 1280x720 rendering timings for sixteen moving objects', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.benchmark());
  expect(report.backend).toBe('webgl2');
  expect(report.count).toBe(16);
  expect(report.timings).toHaveLength(report.frames);
  expect(report.timings.every(time => Number.isFinite(time) && time >= 0)).toBe(true);
  expect(report.meanMs).toBeGreaterThan(0);
  await saveReport(testInfo, 'effects-benchmark', report);
});
