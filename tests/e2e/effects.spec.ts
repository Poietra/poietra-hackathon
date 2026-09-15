import { expect, test, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type {} from './fixtures/effects';

const ACCEPTANCE = { width: 1280, height: 720, fps: 30, durationSeconds: 3.4, frames: 102 };
const BACKGROUND_RGB = [8, 9, 11];
const TOLERANCE = {
  minimumGlowPixels: 100, // Reject a no-op Glow path while ignoring isolated antialiasing noise.
  minimumGlowEnergy: 3, // RGB energy above the unlit ring immediately outside a circle.
  repeatFrameError: 0.1, // Repainting the same uncompressed frame must not retain motion trails.
  compressedFrameError: 8, // Mean RGB error out of 255, allowing H.264 and VP9 compression.
  minimumTextInk: 200, // Require actual readable glyph pixels, not an empty comparison region.
  retainedGlyphFraction: 0.75, // Compression may soften edges but cannot erase a quarter of the glyphs.
  retainedHaloFraction: 0.35, // Dim halo pixels are compressed more heavily than solid glyphs.
  alphaChannelError: 2, // Canvas alpha compositing rounds 8-bit channels.
};

async function saveReport(testInfo: TestInfo, name: string, report: unknown) {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

type VideoReport = Awaited<ReturnType<Window['effectsFixture']['export']>>;

function expectMatchingVideo(report: VideoReport, backend: 'webgl2' | 'canvas2d') {
  expect([report.width, report.height, report.packetCount]).toEqual([ACCEPTANCE.width, ACCEPTANCE.height, ACCEPTANCE.frames]);
  expect(report.duration).toBeCloseTo(ACCEPTANCE.durationSeconds, 3);
  expect(report.backend).toBe(backend);
  if (backend === 'webgl2') expect(report.exportWebglContexts).toBeGreaterThan(0);
  else expect(report.exportWebglContexts).toBe(0);
  report.timestamps.forEach((timestamp, index) => expect(timestamp).toBeCloseTo(index / ACCEPTANCE.fps, 3));
  expect(report.progress.at(-1)).toBe(1);
  const backgroundEnergy = BACKGROUND_RGB.reduce((sum, channel) => sum + channel, 0);
  for (const sample of report.comparisons) {
    expect(sample.meanAbsoluteError).toBeLessThan(TOLERANCE.compressedFrameError);
    expect(sample.japanese.expected.ink).toBeGreaterThan(TOLERANCE.minimumTextInk);
    expect(sample.japanese.actual.ink).toBeGreaterThan(sample.japanese.expected.ink * TOLERANCE.retainedGlyphFraction);
    expect(sample.halo.actual.meanEnergy - backgroundEnergy).toBeGreaterThan((sample.halo.expected.meanEnergy - backgroundEnergy) * TOLERANCE.retainedHaloFraction);
    if (sample.equation) {
      expect(sample.equation.expected.ink).toBeGreaterThan(0);
      expect(sample.equation.actual.ink).toBeGreaterThan(sample.equation.expected.ink * TOLERANCE.retainedGlyphFraction);
      expect(sample.equation.error.meanAbsoluteError).toBeLessThan(TOLERANCE.compressedFrameError);
    }
  }
}
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/effects.html');
  await page.waitForFunction(() => Boolean(window.effectsFixture));
});

test('WebGL2 adds Glow only to selected objects and preserves animation and resize', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.smoke());
  expect(report.backend).toBe('webgl2');
  expect(report.changedPixels).toBeGreaterThan(TOLERANCE.minimumGlowPixels);
  expect(report.glowRing.lit.meanEnergy).toBeGreaterThan(report.glowRing.unlit.meanEnergy + TOLERANCE.minimumGlowEnergy);
  expect(report.unaffected.lit).toEqual(report.unaffected.unlit);
  expect(report.background.lit).toEqual(report.background.unlit);
  const motion = await page.evaluate(() => window.effectsFixture.animation());
  expect(motion.inputUnchanged).toBe(true);
  expect(motion.equationInk[0]).toBeLessThan(motion.equationInk[1]);
  expect(motion.equationInk[1]).toBeLessThan(motion.equationInk[2]);
  expect(motion.oldPosition.end).toBeLessThan(motion.oldPosition.start / 2);
  expect(motion.replay.meanAbsoluteError).toBeLessThan(TOLERANCE.repeatFrameError);
  const resized = await page.evaluate(() => window.effectsFixture.resize());
  expect(resized.letterbox).toEqual([8, 9, 11, 255]);
  expect(resized.content).toBeGreaterThan(TOLERANCE.minimumGlowPixels);
  expect([resized.width, resized.height]).toEqual([640, 360]);
  const transforms = await page.evaluate(() => window.effectsFixture.transformProperties());
  expect(transforms.plainHorizontal).toEqual([255, 255, 255, 255]);
  expect(transforms.rotatedHorizontal).toEqual([8, 9, 11, 255]);
  expect(transforms.rotatedVertical).toEqual([255, 255, 255, 255]);
  transforms.transparentCenter.slice(0, 3).forEach((value, index) => {
    const expected = BACKGROUND_RGB[index] * 0.75 + 255 * 0.25;
    expect(Math.abs(value - expected)).toBeLessThanOrEqual(TOLERANCE.alphaChannelError);
  });
  expect(transforms.stacked).toEqual([0, 0, 255, 255]);
  expect(transforms.hiddenForeground).toEqual([255, 0, 0, 255]);
  await saveReport(testInfo, 'webgl2-rendering', { report, motion, resized, transforms });
  await page.locator('body').screenshot({ path: testInfo.outputPath('glow-preview.png') });
});

test('Canvas 2D fallback remains usable when WebGL2 is unavailable', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects.html?backend=canvas2d');
  await page.waitForFunction(() => Boolean(window.effectsFixture));
  const report = await page.evaluate(() => window.effectsFixture.smoke());
  expect(report.backend).toBe('canvas2d');
  expect(report.changedPixels).toBeGreaterThan(TOLERANCE.minimumGlowPixels);
  expect(report.glowRing.lit.meanEnergy).toBeGreaterThan(report.glowRing.unlit.meanEnergy);
  await saveReport(testInfo, 'canvas-fallback', report);
  const downloading = page.waitForEvent('download');
  const video = await page.evaluate(() => window.effectsFixture.export('mp4'));
  const path = testInfo.outputPath('poietra-glow-canvas-fallback.mp4');
  await (await downloading).saveAs(path);
  await testInfo.attach('canvas-fallback-mp4', { path, contentType: 'video/mp4' });
  expectMatchingVideo(video, 'canvas2d');
  await saveReport(testInfo, 'canvas-fallback-video', video);
});

test('actual WebGL context loss switches to Canvas 2D for later frames', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.contextLoss());
  expect(report.before).toBe('webgl2'); expect(report.after).toBe('canvas2d');
  expect(report.ink).toBeGreaterThan(TOLERANCE.minimumTextInk);
  await saveReport(testInfo, 'context-loss', report);
});

test('cancellation and dispose release resources without breaking a new painter', async ({ page }, testInfo) => {
  const report = await page.evaluate(() => window.effectsFixture.lifecycle());
  expect(report.preAborted).toBe('AbortError');
  expect(report.disposedDuringRender).toBe('AbortError');
  expect(report.disposedAfterRender).toBe('AbortError');
  expect(report.released.liveGpuResources).toBe(report.baseline.liveGpuResources);
  expect(report.released.liveObjectUrls).toBe(report.baseline.liveObjectUrls);
  expect(report.repeated.liveGpuResources).toBe(report.warmed.liveGpuResources);
  expect(report.repeated.allocations).toBe(report.warmed.allocations);
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
    expectMatchingVideo(report, 'webgl2');
    await saveReport(testInfo, 'glow-video-comparison', report);
    await page.locator('body').screenshot({ path: testInfo.outputPath(`canvas-and-decoded-${format}.png`) });
  });
}

test('records warmed 1280x720 rendering timings for sixteen moving objects', async ({ page }, testInfo) => {
  for (const withWrite of [true, false]) {
    const report = await page.evaluate(withWrite => window.effectsFixture.benchmark(withWrite), withWrite);
    expect(report.backend).toBe('webgl2');
    expect(report.count).toBe(16);
    expect(report.timings).toHaveLength(report.frames);
    expect(report.timings.every(time => Number.isFinite(time) && time >= 0)).toBe(true);
    expect(report.meanMs).toBeGreaterThan(0);
    await saveReport(testInfo, withWrite ? 'effects-benchmark' : 'effects-benchmark-move-rotate', report);
  }
});
