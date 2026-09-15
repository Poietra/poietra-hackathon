import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const CALCULUS = { frames: 399, durationSeconds: 13.3, fps: 30 } as const;
const ACCEPTANCE = {
  timestampPrecision: 3,
  // Lossy MP4/WebM compression is compared over the full RGB frame.
  decodedMeanAbsoluteError: 8,
} as const;
const MODES = ['playback', 'seek', 'seek-large', 'unpaced', 'mp4', 'webm'] as const;

for (const mode of MODES) {
  test(`measures ${mode} initialization and first Glow in the production bundle`, async ({ page, browser }, testInfo) => {
    const query = process.env.GLOW_DEEP_PROBE ? '?deep' : '';
    await page.goto('/tests/e2e/fixtures/glow-initialization.html' + query);
    await page.waitForFunction(() => Boolean(window.glowInitialization));
    const download = mode === 'mp4' || mode === 'webm' ? page.waitForEvent('download') : undefined;
    await page.locator('#run-' + mode).click();
    const report = await page.evaluate(() => window.glowInitialization.result);
    expect(report.initialization).toHaveLength(1);
    expect(report.initialization[0].backend).toBe('webgl2');
    for (const frame of report.frames) expect(frame.backend).toBe('webgl2');
    expect(report.firstGlow).toBeDefined();
    expect(report.following.count).toBeGreaterThan(0);
    if ('packetCount' in report) {
      expect(report.packetCount).toBe(CALCULUS.frames);
      expect(report.frames).toHaveLength(CALCULUS.frames);
      expect(report.progress).toBe(1);
      expect(report.duration).toBeCloseTo(CALCULUS.durationSeconds, ACCEPTANCE.timestampPrecision);
      report.timestamps.forEach((time, index) => expect(time).toBeCloseTo(index / CALCULUS.fps, ACCEPTANCE.timestampPrecision));
      for (const comparison of report.comparisons) {
        expect(comparison.meanAbsoluteError).toBeLessThan(ACCEPTANCE.decodedMeanAbsoluteError);
      }
      await (await download!).saveAs(testInfo.outputPath(`calculus.${mode}`));
    }
    const json = JSON.stringify({ revision: process.env.GLOW_REVISION, browserVersion: browser.version(), measuredAt: new Date().toISOString(), ...report }, null, 2);
    await writeFile(testInfo.outputPath(`${mode}.json`), json);
    await testInfo.attach(`${mode}-timing`, { body: json, contentType: 'application/json' });
    console.log(JSON.stringify({ mode, initialization: report.initialization, firstFrame: report.firstFrame, firstGlow: report.firstGlow, following: report.following, startToFirstDisplayOpportunityMs: 'startToFirstDisplayOpportunityMs' in report ? report.startToFirstDisplayOpportunityMs : undefined, totalExportMs: 'totalExportMs' in report ? report.totalExportMs : undefined }));
  });
}
