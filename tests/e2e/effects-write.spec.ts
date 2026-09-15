import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('records the sixteen-object and complete calculus timeline measurements', async ({ page, browser }, testInfo) => {
  test.skip(!process.env.RUN_WRITE_BENCHMARK, 'Run performance measurements separately with an otherwise idle GPU.');
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  for (const scenario of ['write', 'move-rotate', 'calculus'] as const) {
    const report = await page.evaluate(scenario => scenario === 'calculus' ? window.effectsWriteFixture.calculus() : window.effectsWriteFixture.benchmark(scenario === 'write'), scenario);
    expect(report.backend).toBe('webgl2');
    expect(report.frames).toBe(scenario === 'calculus' ? 399 : 60);
    expect(report.objects).toBe(scenario === 'calculus' ? 25 : 16);
    await writeFile(testInfo.outputPath(`${scenario}.json`), JSON.stringify({ revision: process.env.BENCHMARK_REVISION ?? 'unrecorded', browserVersion: browser.version(), measuredAt: new Date().toISOString(), ...report }, null, 2));
    console.log(JSON.stringify({ scenario, meanMs: report.meanMs, medianMs: report.medianMs, p95Ms: report.p95Ms, svgImageLoads: report.svgImageLoads, textureUploads: report.textureUploads, segments: report.segments }));
  }
  await page.screenshot({ path: testInfo.outputPath('calculus-final.png'), fullPage: true });
});

const EQUATIONS = [String.raw`x_{11}^2`, String.raw`\frac{a}{b}`, String.raw`\boxed{x}`, String.raw`\overbrace{x+y}`];
type GlyphComparison = Awaited<ReturnType<Window['effectsWriteFixture']['sequence']>>['records'][number]['svg'];
// SVG's direct raster and the isolated layer use different subpixel sampling. These
// limits apply only to glyph pixels; warmed/fresh and replay comparisons remain exact.
const SVG_TOLERANCE = { mean: 35, strongFraction: 0.2, minimumEnergy: 0.9, maximumEnergy: 1.1 };
const LEGACY_LAYER_TOLERANCE = { mean: 2, p99: 40, maximum: 64, minimumEnergy: 0.98, maximumEnergy: 1.02 };
function matchesLegacyLayer(comparison: GlyphComparison) {
  expect(comparison.glyphMeanError).toBeLessThan(LEGACY_LAYER_TOLERANCE.mean);
  expect(comparison.p99).toBeLessThanOrEqual(LEGACY_LAYER_TOLERANCE.p99);
  expect(comparison.maximum).toBeLessThanOrEqual(LEGACY_LAYER_TOLERANCE.maximum);
  expect(comparison.strongDifferenceFraction).toBe(0);
  if (comparison.expectedEnergy) {
    expect(comparison.actualEnergy / comparison.expectedEnergy).toBeGreaterThan(LEGACY_LAYER_TOLERANCE.minimumEnergy);
    expect(comparison.actualEnergy / comparison.expectedEnergy).toBeLessThan(LEGACY_LAYER_TOLERANCE.maximumEnergy);
  }
}
function matchesSvg(comparison: GlyphComparison) {
  if (!comparison.expectedEnergy) { expect(comparison.actualEnergy).toBe(0); return; }
  expect(comparison.actualEnergy / comparison.expectedEnergy).toBeGreaterThan(SVG_TOLERANCE.minimumEnergy);
  expect(comparison.actualEnergy / comparison.expectedEnergy).toBeLessThan(SVG_TOLERANCE.maximumEnergy);
  expect(comparison.glyphMeanError).toBeLessThan(SVG_TOLERANCE.mean);
  expect(comparison.strongDifferenceFraction).toBeLessThan(SVG_TOLERANCE.strongFraction);
}

for (const [index, equation] of EQUATIONS.entries()) for (const order of ['together', 'sequential'] as const) {
  test(`equation ${index + 1} ${order} preserves forward, backward and nearby Write frames`, async ({ page }, testInfo) => {
    await page.goto('/tests/e2e/fixtures/effects-write.html');
    await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
    const report = await page.evaluate(({ equation, order }) => window.effectsWriteFixture.sequence(equation, order), { equation, order });
    await writeFile(testInfo.outputPath('write-sequence.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: testInfo.outputPath('painter-and-svg.png'), fullPage: true });
    expect(report.backend).toBe('webgl2');
    expect(report.nearby.maximum).toBeGreaterThan(0);
    for (const record of report.records) {
      expect(record.fresh.maximum).toBe(0);
      matchesLegacyLayer(record.legacy);
      if (record.replay) expect(record.replay.maximum).toBe(0);
      matchesSvg(record.svg);
    }
  });
}

test('same-ID edits and output resizing match a fresh painter and SVG', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.edits());
  await writeFile(testInfo.outputPath('write-edits.json'), JSON.stringify(report, null, 2));
  for (const record of report) {
    expect(record.fresh.maximum, record.name).toBe(0);
    matchesLegacyLayer(record.legacy);
    matchesSvg(record.svg);
    if (['fill', 'font-size-zero', 'font-size', 'stroke-width', 'glow', 'rotation-opacity', 'output-size', 'letterbox'].includes(record.name)) expect(record.preparations, record.name).toBe(0);
  }
});

test('prepared geometry is reused and cancellation cannot publish a partial frame', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.lifecycle());
  await writeFile(testInfo.outputPath('write-cache-lifecycle.json'), JSON.stringify(report, null, 2));
  expect(report.initialPreparations).toBeGreaterThan(0);
  expect(report.repeatPreparations).toBe(0);
  expect(report.duringAbort).toBe('AbortError');
  expect(report.duringDispose).toBe('AbortError');
  expect(report.afterDispose).toBe('AbortError');
  expect(report.publishedAfterDispose.maximum).toBe(0);
});

test('unsupported math and oversized cutouts preserve SVG fallback and subsequent frames', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.fallback());
  await writeFile(testInfo.outputPath('write-fallback.json'), JSON.stringify(report, null, 2));
  for (const record of report) {
    matchesSvg(record.svg);
    expect(record.svg.actualInk).toBeGreaterThan(0);
    if (record.name !== 'unsupported-math') expect(record.backend).toBe('canvas2d');
  }
});
