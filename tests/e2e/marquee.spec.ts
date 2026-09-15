import { expect, test, type Page } from '@playwright/test';

async function world(page: Page, x: number, y: number) {
  const box = await page.getByTestId('stage-main').boundingBox();
  return { x: box!.x + x / 1280 * box!.width, y: box!.y + y / 720 * box!.height };
}
async function field(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab');
}
async function add(page: Page, tool: string, x: number, y: number, content?: string) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  const at = await world(page, x, y); await page.mouse.click(at.x, at.y);
  const id = await page.locator('.layer-row.selected').getAttribute('data-layer-id');
  if (content) {
    const input = page.locator('textarea.content-input'); await expect(input).toBeFocused();
    await input.fill(content); await input.press('Tab'); await field(page, 'Font size', 32);
  }
  return id!;
}
async function setup(page: Page) {
  await page.goto(`/?room=${crypto.randomUUID()}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const rectangle = await add(page, '四角形 (R)', 430, 180);
  await field(page, 'Width', 70); await field(page, 'Height', 60); await field(page, 'Rotation', 35);
  const text = await add(page, 'テキスト (T)', 620, 200, '日 本 語'); await field(page, 'Rotation', -30);
  const equation = await add(page, '数式 (E)', 790, 200, String.raw`x \quad + \quad y`);
  await page.getByRole('combobox', { name: 'キャンバスのズーム', exact: true }).selectOption('0.75');
  await expect(page.locator('.scene-canvas')).toBeVisible();
  return { rectangle, text, equation };
}
async function selected(page: Page) { return (await page.locator('.layer-row.selected').evaluateAll(rows => rows.map(row => row.getAttribute('data-layer-id')!))).sort(); }
async function origin(page: Page, id: string) {
  const transform = await page.locator(`[data-testid="stage-main"] .scene-svg [data-object-id="${id}"]`).getAttribute('transform');
  const result = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform || ''); return { x: Number(result![1]), y: Number(result![2]) };
}
async function marquee(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, shift = false) {
  const a = await world(page, from.x, from.y), b = await world(page, to.x, to.y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 });
  await expect(page.getByTestId('selection-marquee')).toBeVisible(); await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await expect(page.getByTestId('selection-marquee')).toHaveCount(0);
}
async function moveAt(page: Page, x: number, y: number, dx: number, dy: number) {
  const a = await world(page, x, y); await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(a.x + dx, a.y + dy, { steps: 5 }); await page.mouse.up();
}

test('a reverse marquee encloses rotated shapes, text and equations; the selection moves together and Undo restores every object', async ({ page, browser }) => {
  const ids = await setup(page);
  const peerContext = await browser.newContext(); const peer = await peerContext.newPage();
  try {
    await peer.goto(page.url()); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await marquee(page, { x: 890, y: 290 }, { x: 370, y: 100 });
    await expect.poll(() => selected(page)).toEqual(Object.values(ids).sort());
    await expect(page.locator('.inspector-title-label')).toContainText('3 objects');
    await expect(page.locator('[data-selection-id]')).toHaveCount(3);
    const before = Object.fromEntries(await Promise.all(Object.values(ids).map(async id => [id, await origin(page, id)])));
    await moveAt(page, 430, 180, 24, 12);
    const delta = (await origin(page, ids.rectangle)).x - before[ids.rectangle].x; expect(delta).toBeGreaterThan(30);
    for (const id of Object.values(ids)) {
      const after = await origin(page, id); expect(after.x - before[id].x).toBeCloseTo(delta, 1);
      expect(after.y - before[id].y).toBeCloseTo(delta / 2, 1);
      await expect.poll(() => origin(peer, id)).toEqual(after);
    }
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    for (const id of Object.values(ids)) await expect.poll(() => origin(page, id)).toEqual(before[id]);
  } finally { await peerContext.close(); }
});

test('Shift marquee preserves selection, Shift click toggles and locked selected objects stay fixed', async ({ page }) => {
  const ids = await setup(page);
  await page.locator(`[data-layer-id="${ids.rectangle}"] .layer-select`).click();
  await page.getByRole('button', { name: 'ロック', exact: true }).click();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await marquee(page, { x: 370, y: 100 }, { x: 890, y: 290 }, true);
  await expect.poll(() => selected(page)).toEqual(['circle', ...Object.values(ids)].sort());
  const circle = await world(page, 245, 520);
  await page.keyboard.down('Shift'); await page.mouse.click(circle.x, circle.y); await page.keyboard.up('Shift');
  await expect.poll(() => selected(page)).toEqual(Object.values(ids).sort());
  await page.keyboard.down('Shift'); await page.mouse.click(circle.x, circle.y); await page.keyboard.up('Shift');
  await expect.poll(() => selected(page)).toEqual(['circle', ...Object.values(ids)].sort());
  const beforeLocked = await origin(page, ids.rectangle), beforeText = await origin(page, ids.text), beforeCircle = await origin(page, 'circle');
  await moveAt(page, 620, 200, 25, 10);
  expect(await origin(page, ids.rectangle)).toEqual(beforeLocked);
  const delta = (await origin(page, ids.text)).x - beforeText.x; expect(delta).toBeGreaterThan(30);
  expect((await origin(page, 'circle')).x - beforeCircle.x).toBeCloseTo(delta, 1);
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  expect(await origin(page, ids.text)).toEqual(beforeText); expect(await origin(page, 'circle')).toEqual(beforeCircle);
});

test('small empty clicks never become marquees, partial bounds and invisible objects are excluded, and Escape cancels selection', async ({ page }) => {
  await page.goto(`/?room=${crypto.randomUUID()}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const empty = await world(page, 100, 100);
  await page.mouse.move(empty.x, empty.y); await page.mouse.down(); await page.mouse.move(empty.x + 2, empty.y + 1);
  await expect(page.getByTestId('selection-marquee')).toHaveCount(0); await page.mouse.up();
  await expect.poll(() => selected(page)).toEqual([]);
  await marquee(page, { x: 200, y: 470 }, { x: 245, y: 520 });
  await expect.poll(() => selected(page)).toEqual([]);
  await marquee(page, { x: 50, y: 50 }, { x: 1200, y: 650 });
  await expect.poll(() => selected(page)).toEqual(['circle', 'sigmoid']); // The default equation is hidden in Composition 1.
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const far = await world(page, 1200, 650);
  await page.mouse.move(empty.x, empty.y); await page.mouse.down(); await page.mouse.move(far.x, far.y, { steps: 4 });
  await expect.poll(() => selected(page)).toEqual(['circle', 'sigmoid']);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.getByTestId('selection-marquee')).toHaveCount(0);
  await expect.poll(() => selected(page)).toEqual(['circle']);
});
