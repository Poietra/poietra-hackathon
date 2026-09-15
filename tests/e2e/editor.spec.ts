import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, room: string) { await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible(); await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible(); }
async function selectCircle(page: Page) { await page.getByRole('button', { name: 'Circle', exact: true }).click(); }
async function x(page: Page) {
  const surface = await page.getByTestId('stage-main').boundingBox();
  const object = await page.locator('[data-testid="stage-main"] [data-object-id="circle"]').boundingBox();
  if (!surface || !object) return -1;
  return Math.round((object.x + object.width / 2 - surface.x) / surface.width * 1280 * 100) / 100;
}

test('a property update reaches another browser; undo preserves the collaborator’s color', async ({ browser }) => {
  const first = await browser.newContext(); const second = await browser.newContext();
  const alice = await first.newPage(); const bob = await second.newPage(); const room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]);
  await selectCircle(alice); await selectCircle(bob);
  await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('320');
  await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
  await expect.poll(() => x(bob)).toBe(320);
  await bob.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
  await expect(alice.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect.poll(() => x(bob)).toBe(245);
  await expect(bob.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await first.close(); await second.close();
});

test('composition state stays independent and an unchanged focused field does not overwrite remote changes', async ({ browser }) => {
  const first = await browser.newContext(); const second = await browser.newContext();
  const alice = await first.newPage(); const bob = await second.newPage(); const room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]);
  await selectCircle(alice); await selectCircle(bob);
  await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).focus();
  await bob.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('350'); await bob.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
  await expect.poll(() => x(alice)).toBe(350);
  await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
  await expect.poll(() => x(alice)).toBe(350);
  await alice.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('900'); await alice.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
  await expect.poll(() => x(alice)).toBe(900); await expect.poll(() => x(bob)).toBe(350);
  await first.close(); await second.close();
});

test('scrubbing displays the evaluated frame while paused', async ({ page }) => {
  await open(page, crypto.randomUUID());
  await page.getByRole('slider', { name: '再生位置', exact: true }).evaluate(element => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '1300');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => x(page)).toBeCloseTo(588.75, 1);
  await expect(page.getByRole('button', { name: 'シーンを再生', exact: true })).toBeVisible();
});

test('the transition editor changes timing and lets the user drag a Bézier control point', async ({ page }) => {
  await open(page, crypto.randomUUID()); await selectCircle(page);
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Animation start', exact: true }).fill('100'); await page.getByRole('spinbutton', { name: 'Animation start', exact: true }).press('Tab');
  await expect(page.getByRole('button', { name: 'Circle Move: 100–700 ms', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Bézier path', exact: true }).click();
  const handle = page.locator('[data-path-handle="c1"]'); const before = await handle.boundingBox();
  await page.mouse.move(before!.x+before!.width/2,before!.y+before!.height/2); await page.mouse.down(); await page.mouse.move(before!.x+before!.width/2,before!.y-30,{steps:4}); await page.mouse.up();
  await expect.poll(async () => (await handle.boundingBox())!.y).toBeLessThan(before!.y-20);
});
