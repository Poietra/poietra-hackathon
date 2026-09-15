import { expect, test, type Locator, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto(`/?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
}
async function field(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(String(value)); await input.press('Tab');
}
async function center(locator: Locator) {
  const box = await locator.boundingBox(); expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}
async function drag(page: Page, locator: Locator, dx: number, dy: number) {
  const at = await center(locator);
  await page.mouse.move(at.x, at.y); await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 5 }); await page.mouse.up();
}
function shape(page: Page, id = 'circle', stage = 'main') { return page.locator(`[data-testid="stage-${stage}"] .scene-svg [data-object-id="${id}"]`); }
async function origin(page: Page, id = 'circle') {
  const transform = await shape(page, id).getAttribute('transform');
  const result = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform || '');
  return { x: Number(result![1]), y: Number(result![2]) };
}

test('resize keeps the opposite corner fixed, rotation snaps, and each gesture can be undone', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const fixed = await center(page.locator('[data-transform-handle="nw"]'));
  await drag(page, page.locator('[data-transform-handle="se"]'), 40, 25);
  await expect.poll(async () => Number(await page.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue())).toBeGreaterThan(80);
  const after = await center(page.locator('[data-transform-handle="nw"]'));
  expect(after.x).toBeCloseTo(fixed.x, 1); expect(after.y).toBeCloseTo(fixed.y, 1);
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('42');
  const pivot = await center(shape(page)); const handle = await center(page.locator('[data-transform-handle="rotate"]'));
  const distance = Math.hypot(handle.x - pivot.x, handle.y - pivot.y);
  await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.keyboard.down('Shift');
  await page.mouse.move(pivot.x + distance, pivot.y, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(page.getByRole('spinbutton', { name: 'Rotation', exact: true })).toHaveValue('90');
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Rotation', exact: true })).toHaveValue('0');
});

test('equation corner handles scale visible glyphs using font size', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await page.getByRole('button', { name: 'Equation', exact: true }).click();
  const before = await shape(page, 'equation').boundingBox();
  await drag(page, page.locator('[data-transform-handle="se"]'), 45, 10);
  await expect.poll(async () => Number(await page.getByRole('spinbutton', { name: 'Font size', exact: true }).inputValue())).toBeGreaterThan(50);
  await expect.poll(async () => (await shape(page, 'equation').boundingBox())!.width).toBeGreaterThan(before!.width + 20);
});

test('linked objects move together and locked objects expose no transform handles', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Link objects', exact: true }).click();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const initialCircle = await origin(page), initialPath = await origin(page, 'sigmoid');
  await drag(page, shape(page), 35, -20);
  const movedCircle = await origin(page), movedPath = await origin(page, 'sigmoid');
  expect(movedCircle.x - initialCircle.x).toBeGreaterThan(30);
  expect(movedCircle.x - initialCircle.x).toBeCloseTo(movedPath.x - initialPath.x, 1);
  expect(movedCircle.y - initialCircle.y).toBeCloseTo(movedPath.y - initialPath.y, 1);
  await page.getByRole('button', { name: 'ロック', exact: true }).click();
  await expect(page.locator('[data-transform-handle]')).toHaveCount(0);
  await drag(page, shape(page), 30, 10);
  expect(await origin(page)).toEqual(movedCircle); expect(await origin(page, 'sigmoid')).toEqual(movedPath);
});

test('Escape cancels an active transform and pointer cancellation never creates a drawing', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const initial = await origin(page), at = await center(shape(page));
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 60, at.y - 25, { steps: 4 });
  expect((await origin(page)).x).toBeGreaterThan(initial.x);
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await origin(page)).toEqual(initial);
  await page.getByRole('button', { name: '四角形 (R)', exact: true }).click();
  const stage = page.getByTestId('stage-main'), start = await center(stage);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 50, start.y + 30, { steps: 4 });
  await expect(shape(page, 'drawing-preview')).toBeVisible();
  await stage.dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  await expect(stage.locator('.scene-svg [data-object-id]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Rectangle 1', exact: true })).toHaveCount(0);
  // The canceled gesture must not absorb the next real edit into its undo entry.
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await field(page, 'Position X', 330); await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  expect(await origin(page)).toEqual(initial);
});

test('a rotated Bézier handle follows the cursor without jumping into unrotated coordinates', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
  await field(page, 'Position X', 250); await field(page, 'Position Y', 250); await field(page, 'Rotation', 30);
  const handle = page.locator('[data-path-handle="c1"]'); const before = await center(handle);
  await drag(page, handle, 30, -10);
  const after = await center(handle);
  expect(after.x - before.x).toBeCloseTo(30, 0); expect(after.y - before.y).toBeCloseTo(-10, 0);
  const curve = await shape(page, 'sigmoid').locator('path').getAttribute('d');
  expect(curve).toMatch(/710 -330$/);
});

test('a paused transition frame can be selected without changing the destination state', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Transition preview position', exact: true });
  await slider.fill('300');
  const circle = shape(page, 'circle', 'to');
  const before = await circle.getAttribute('transform'); await drag(page, circle, 35, 10);
  await expect(circle).toHaveAttribute('transform', before!);
  await expect(page.locator('[data-testid="stage-to"] [data-transform-handle]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('955');
});
