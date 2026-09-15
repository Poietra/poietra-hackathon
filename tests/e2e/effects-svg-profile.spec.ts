import { makeCalculusProject } from '../../shared/templates';
import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('records calculus SVG sources without including profiling overhead in timing results', async ({ page }, testInfo) => {
  test.skip(!process.env.RUN_SVG_PROFILE, 'Source profiling runs separately from timing measurements.');
  await page.addInitScript(() => {
    const sources: Promise<string>[] = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = value => {
      if (value instanceof Blob && value.type.startsWith('image/svg+xml')) sources.push(value.text());
      return create(value);
    };
    Object.assign(window, { svgProfileSources: () => Promise.all(sources) });
  });
  await page.goto('/tests/e2e/fixtures/effects-write.html');
  await page.waitForFunction(() => Boolean(window.effectsWriteFixture));
  const report = await page.evaluate(() => window.effectsWriteFixture.calculus());
  const sources = await page.evaluate(() => (window as unknown as { svgProfileSources(): Promise<string[]> }).svgProfileSources());
  // Warmup requests precede the recorded samples. Consume each sample's measured
  // count in creation order; Blob.text completion order does not affect attribution.
  const project = makeCalculusProject(), scene = project.scenes[project.sceneOrder[0]];
  const textOwners = new Map(Object.values(scene.compositions).flatMap(composition => Object.entries(composition.states).filter(([id]) => scene.objects[id].kind === 'text').map(([id, state]) => [state.text.split('\n')[0], id] as const)));
  const sourceId = (svg: string) => {
    const id = /data-object-id="([^"]+)"/.exec(svg)?.[1];
    if (id) return id;
    const firstLine = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(svg)?.[1].replace(/<[^>]+>/g, '');
    return firstLine ? textOwners.get(firstLine) ?? 'unattributed-text' : 'whole-frame';
  };
  let cursor = sources.length - report.svgImageLoads;
  const samples = report.samples.map(sample => ({
    timeMs: sample.timeMs, segment: sample.segment,
    sources: sources.slice(cursor, cursor += sample.svgImageLoads).map(svg => ({
      id: sourceId(svg),
      kind: svg.includes('<text ') ? 'text' : svg.includes('<ellipse ') ? 'circle' : svg.includes('<g transform="rotate(') ? 'arrow' : 'other',
    })),
  }));
  expect(samples.reduce((sum, sample) => sum + sample.sources.length, 0)).toBe(report.svgImageLoads);
  const counts: Record<string, number> = {};
  for (const sample of samples) for (const source of sample.sources) {
    const key = `${sample.segment}/${source.kind}/${source.id}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  await writeFile(testInfo.outputPath('svg-sources.json'), JSON.stringify({ revision: process.env.BENCHMARK_REVISION, requests: report.svgImageLoads, counts, samples }, null, 2));
  console.log(JSON.stringify(counts));
});
