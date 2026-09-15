import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { ShapeTextCaseName } from './fixtures/effects-shape-text-regression';

const CASES: ShapeTextCaseName[] = ['circle', 'rectangle', 'path', 'arrow', 'numberline', 'latin', 'japanese', 'whitespace', 'small', 'stroked'];
type Comparison = Awaited<ReturnType<Window['effectsWriteFixture']['shapeSequence']>>['records'][number]['svg'];
// As in the equation checks, SVG rasterization directly into the stage and an
// isolated layer have different subpixel sampling. Fresh/cache/replay are exact.
const SVG_TOLERANCE = { mean: 35, strongFraction: 0.2, minimumEnergy: 0.9, maximumEnergy: 1.1 };
const LEGACY_TEXT_TOLERANCE = { mean: 2, strongFraction: 0 };
function matchesSvg(comparison: Comparison, label: string, checkSampling = true, checkEnergy = true) {
  if (!comparison.expectedEnergy) { expect(comparison.actualEnergy, label).toBe(0); return; }
  const energy = comparison.actualEnergy / comparison.expectedEnergy;
  if (checkEnergy) {
    expect(energy, label).toBeGreaterThan(SVG_TOLERANCE.minimumEnergy);
    expect(energy, label).toBeLessThan(SVG_TOLERANCE.maximumEnergy);
  }
  if (checkSampling) expect(comparison.glyphMeanError, label).toBeLessThan(SVG_TOLERANCE.mean);
  expect(comparison.strongDifferenceFraction, label).toBeLessThan(SVG_TOLERANCE.strongFraction);
}

for (const name of CASES) for (const order of ['together', 'sequential'] as const) {
  test(`${name} ${order} preserves Write contours and forward/backward seeks`, async ({ page }, testInfo) => {
    await page.goto('/tests/e2e/fixtures/effects-write.html');
    await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
    const report = await page.evaluate(({ name, order }) => window.effectsWriteFixture.shapeSequence(name, order), { name, order });
    await writeFile(testInfo.outputPath('shape-text-sequence.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: testInfo.outputPath('painter-and-svg.png'), fullPage: true });
    expect(report.backend).toBe('webgl2');
    for (const record of report.records) {
      expect(record.fresh.maximum, `${record.progress}: fresh`).toBe(0);
      if (record.replay) expect(record.replay.maximum, `${record.progress}: replay`).toBe(0);
      // At 10px the legacy cutout itself differs from direct stage SVG by mean
      // 36.0757/255. Keep ink/contour checks and compare this sampling to the cutout.
      matchesSvg(record.svg, `${record.progress}: SVG`, name !== 'small');
      if (record.cutout) {
        expect(record.cutout.glyphMeanError).toBeLessThan(LEGACY_TEXT_TOLERANCE.mean);
        expect(record.cutout.strongDifferenceFraction).toBe(LEGACY_TEXT_TOLERANCE.strongFraction);
      }
    }
    // A nearby position is intentionally within the same 30fps interval.
    // A clip edge between glyphs or a sequential space can legitimately leave both frames unchanged.
    if (report.nearbySvg.maximum > 0) expect(report.nearby.maximum).toBeGreaterThan(0);
  });
}

for (const name of ['circle', 'rectangle', 'path', 'arrow', 'numberline', 'japanese', 'stroked'] as const) {
  test(`${name} same-ID edits replace cached geometry, masks and output sizes`, async ({ page }, testInfo) => {
    await page.goto('/tests/e2e/fixtures/effects-write.html');
    await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
    const report = await page.evaluate(name => window.effectsWriteFixture.shapeEdits(name), name);
    await writeFile(testInfo.outputPath('shape-text-edits.json'), JSON.stringify(report, null, 2));
    for (const record of report.records) {
      expect(record.fresh.maximum, `${record.name}: fresh`).toBe(0);
      // Chrome's colored text AA differs from tinting a white mask. This case
      // checks the white SVG coverage at the requested color independently.
      matchesSvg(record.svg, `${record.name}: SVG`, true, !record.tintReference);
      if (record.tintReference) {
        expect(record.tintReference.glyphMeanError).toBeLessThan(LEGACY_TEXT_TOLERANCE.mean);
        expect(record.tintReference.strongDifferenceFraction).toBe(LEGACY_TEXT_TOLERANCE.strongFraction);
      }
    }
  });
}

test('text masks survive color and transform changes and release after replacement, eviction and removal', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.textCacheResources());
  await writeFile(testInfo.outputPath('text-cache-resources.json'), JSON.stringify(report, null, 2));
  expect(report.reusedRequests).toBe(0);
  expect(report.reusedAtlasAlive).toBe(true);
  expect(report.replacedAtlasReleased).toBe(true);
  expect(report.deletedAtlasReleased).toBe(true);
  expect(report.firstLayerReleased).toBe(true);
  expect(report.evicted).toBeGreaterThan(0);
  expect(report.liveBytes).toBeLessThanOrEqual(report.allowedBytes);
  expect(report.cleared).toBe(true);
});

test('cancelling a pending text atlas releases its canvases and object URL', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.abortTextPreparation());
  await writeFile(testInfo.outputPath('text-cache-abort.json'), JSON.stringify(report, null, 2));
  expect(report.errorName).toBe('AbortError');
  expect(report.liveUrls).toBe(0);
  expect(report.allocations).toBeGreaterThan(0);
  expect(report.released).toBe(true);
});

test('12px Japanese at 0.75 output scale preserves the legacy SVG cutout glyphs', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const records = await page.evaluate(() => window.effectsWriteFixture.smallTextCutout());
  await writeFile(testInfo.outputPath('small-text-cutout.json'), JSON.stringify(records, null, 2));
  await page.screenshot({ path: testInfo.outputPath('small-text-cutout.png'), fullPage: true });
  for (const record of records) {
    expect(record.comparison.glyphMeanError, `${record.order}/${record.progress}`).toBeLessThan(LEGACY_TEXT_TOLERANCE.mean);
    expect(record.comparison.strongDifferenceFraction).toBe(0);
  }
});

test('unsupported text and large masks use SVG and preserve later native frames', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.textFallbacks());
  await writeFile(testInfo.outputPath('text-fallbacks.json'), JSON.stringify(report, null, 2));
  for (const record of report) {
    expect(record.backend, record.name).toBe('webgl2');
    expect(record.svg.actualInk, record.name).toBeGreaterThan(0);
    matchesSvg(record.svg, record.name);
  }
});
