import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, room = crypto.randomUUID()) {
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
}
const circle = (page: Page, stage = 'main') => page.locator(`[data-testid="stage-${stage}"] [data-object-id="circle"]`);

test('a paused scene preview cannot edit a hidden composition and opens the displayed composition with the keyboard', async ({ browser }) => {
  const alice = await browser.newPage(), bob = await browser.newPage(); const room = crypto.randomUUID();
  try {
    await Promise.all([open(alice, room), open(bob, room)]);
    await alice.getByRole('button', { name: 'Circle', exact: true }).click();
    await bob.getByRole('button', { name: 'Circle', exact: true }).click();
    await alice.getByRole('slider', { name: '再生位置', exact: true }).fill('2500');
    await expect(circle(alice)).toHaveAttribute('transform', 'translate(955 190) rotate(0)');
    await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveCount(0);
    await expect(alice.getByRole('button', { name: 'Circle を非表示', exact: true })).toBeDisabled();
    await alice.locator('body').click({ position: { x: 280, y: 690 } });
    await alice.keyboard.press('Delete'); await alice.keyboard.press('Control+d'); await alice.keyboard.press('ArrowRight');
    await alice.evaluate(() => { const data = new DataTransfer(); document.body.dispatchEvent(new ClipboardEvent('cut', { clipboardData: data, bubbles: true })); });
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await expect(bob.locator('[data-layer-id]')).toHaveCount(3);
    await expect(circle(bob)).toBeVisible();
    const edit = alice.getByRole('button', { name: 'この場面を編集', exact: true });
    await edit.focus(); await edit.press('Space');
    await expect(alice.getByRole('button', { name: 'Composition 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('955');
    await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('900');
    await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await bob.getByRole('button', { name: 'Composition 2', exact: true }).click();
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('900');
  } finally { await alice.close(); await bob.close(); }
});

test('a scene preview started from a transition keeps its scene ruler and returns to the same transition time', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await page.getByRole('button', { name: 'シーンを再生', exact: true }).click();
  await expect(page.getByRole('slider', { name: '再生位置', exact: true })).toBeVisible();
  await page.getByRole('slider', { name: '再生位置', exact: true }).fill('1300');
  await expect(circle(page)).toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
  await page.getByRole('button', { name: 'この場面を編集', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Transition preview position', exact: true })).toHaveValue('300');
  await expect(circle(page, 'to')).toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
  await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('600');
});

test('choosing a drawing tool from preview adds to the displayed composition', async ({ page }) => {
  await open(page);
  await page.getByRole('slider', { name: '再生位置', exact: true }).fill('2500');
  await page.getByRole('button', { name: '四角形 (R)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Composition 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const surface = page.getByTestId('stage-main'), bounds = await surface.boundingBox();
  await page.mouse.move(bounds!.x + 150, bounds!.y + 130); await page.mouse.down();
  await page.mouse.move(bounds!.x + 220, bounds!.y + 175); await page.mouse.up();
  await expect(page.locator('[data-layer-id]')).toHaveCount(4);
  const selected = page.locator('[data-layer-id].selected');
  const id = await selected.getAttribute('data-layer-id');
  await expect(page.locator(`[data-testid="stage-main"] [data-object-id="${id}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Composition 1', exact: true }).click();
  await expect(page.locator(`[data-testid="stage-main"] [data-object-id="${id}"]`)).toHaveCount(0);
});
