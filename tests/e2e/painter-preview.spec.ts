import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto(`/tests/e2e/fixtures/painter-preview.html?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="stage-main"] .scene-hit-svg')).toHaveCount(1);
}
const circle = (page: Page, stage = 'main') => page.locator(`[data-testid="stage-${stage}"] .scene-svg [data-object-id="circle"]`);

test('cursor updates keep the unchanged canvas and SVG frame instead of repainting the scene', async ({ page }) => {
  await open(page);
  for (const compare of [false, true]) {
    if (compare) await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.painterPreview.active)).toBe(0);
    const counts = await page.evaluate(async () => {
      const before = { svg: window.painterPreview.svgCalls, paint: window.painterPreview.renders.length };
      await window.painterPreview.cursors(12);
      return { svg: window.painterPreview.svgCalls - before.svg, paint: window.painterPreview.renders.length - before.paint };
    });
    expect(counts).toEqual({ svg: 0, paint: 0 });
  }
  // A real scene change must still invalidate both rendering paths.
  await page.getByRole('button', { name: 'Composition 1', exact: true }).click();
  await page.evaluate(() => window.painterPreview.positions([430]));
  await expect(circle(page)).toHaveAttribute('transform', 'translate(430 520) rotate(0)');
});

test('the Canvas and transparent SVG preserve selection, resize and Bézier editing', async ({ page }) => {
  await open(page);
  await expect(page.locator('.scene-hit-svg')).toHaveCSS('opacity', '0');
  await expect(page.locator('.scene-canvas')).toBeVisible();
  await circle(page).click();
  const handle = page.locator('[data-transform-handle="se"]'), box = await handle.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 25, box!.y + box!.height / 2 + 25, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => Number(await page.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue())).toBeGreaterThan(70);
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await expect(page.locator('[data-testid="stage-to"] .scene-hit-svg')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit Bézier path', exact: true }).click();
  const control = page.locator('[data-path-handle="c1"]'), before = await control.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2); await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2, before!.y - 20, { steps: 3 }); await page.mouse.up();
  await expect.poll(async () => (await control.boundingBox())!.y).toBeLessThan(before!.y - 15);
});

test('slow painting coalesces pending frames and eventually displays the latest position', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const start = window.painterPreview.renders.length;
    window.painterPreview.delay = 80;
    await window.painterPreview.positions([300, 320, 340, 360, 380, 400, 420, 440, 460, 480, 500, 520]);
    return { start };
  });
  await expect(circle(page)).toHaveAttribute('transform', 'translate(520 520) rotate(0)');
  await expect.poll(() => page.evaluate(() => window.painterPreview.active)).toBe(0);
  const after = await page.evaluate(start => ({ calls: window.painterPreview.renders.slice(start), maximum: window.painterPreview.maximumConcurrentPerInstance }), result.start);
  expect(after.maximum).toBe(1);
  expect(after.calls.length).toBeLessThan(10);
  expect(after.calls.at(-1)?.x).toBe(520);
  expect(after.calls.at(-1)?.finished).toBe(true);
});

test('switching compositions aborts the old painter and cannot publish its old position', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => { window.painterPreview.hold = true; await window.painterPreview.positions([390]); });
  await expect.poll(() => page.evaluate(() => window.painterPreview.renders.some(item => item.x === 390 && !item.finished))).toBe(true);
  await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await page.evaluate(() => window.painterPreview.release());
  await expect(page.locator('[data-testid="stage-main"] .scene-hit-svg')).toHaveCount(1);
  await expect(circle(page)).toHaveAttribute('transform', 'translate(955 190) rotate(0)');
  const report = await page.evaluate(() => ({ disposals: window.painterPreview.disposals, staleAborted: window.painterPreview.renders.some(item => item.x === 390 && item.aborted), active: window.painterPreview.active }));
  expect(report.disposals).toBeGreaterThanOrEqual(1); expect(report.staleAborted).toBe(true); expect(report.active).toBe(0);
});

test('a painter error restores the current SVG and keeps subsequent edits usable', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => { window.painterPreview.failNext = true; await window.painterPreview.positions([390]); });
  await expect(page.locator('.scene-hit-svg')).toHaveCount(0);
  await expect(page.locator('.scene-canvas')).not.toBeVisible();
  await expect(circle(page)).toHaveAttribute('transform', 'translate(390 520) rotate(0)');
  await circle(page).click();
  await page.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('420');
  await page.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
  await expect(circle(page)).toHaveAttribute('transform', 'translate(420 520) rotate(0)');
});

test('the backing canvas follows viewport size and device pixel density', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage(); await open(page);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.locator('[data-testid="stage-main"] .scene-canvas').evaluate((canvas: HTMLCanvasElement) => Math.abs(canvas.width - canvas.getBoundingClientRect().width * devicePixelRatio))).toBeLessThan(1);
    await expect(page.locator('[data-testid="stage-main"] .scene-hit-svg')).toHaveCount(1);
  }
  await context.close();
});
