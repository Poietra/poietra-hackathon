import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { Project } from '../../shared/model';

async function open(page: Page, room: string) {
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
}
async function state(page: Page): Promise<Project> {
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const file = await pending;
  const project = JSON.parse(await readFile((await file.path())!, 'utf8')) as Project;
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  return project;
}
const layer = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function number(page: Page, label: string, value: string) {
  const field = page.getByRole('spinbutton', { name: label, exact: true });
  await field.fill(value); await field.press('Tab');
}

for (const entry of ['timeline', 'sidebar'] as const) {
  test(`${entry} Composition add inherits the last composition including hidden equation and linked states; edits and Undo synchronize independently`, async ({ browser }) => {
    const first = await browser.newContext(), second = await browser.newContext();
    const alice = await first.newPage(), bob = await second.newPage(); const room = crypto.randomUUID();
    try {
      await Promise.all([open(alice, room), open(bob, room)]);
      await layer(alice, 'Composition 2').click();
      await layer(alice, 'Equation').click();
      await alice.getByRole('textbox', { name: 'LaTeX expression', exact: true }).fill('E = mc^2 + \\alpha');
      await number(alice, 'Rotation', '27');
      await number(alice, 'Font size', '64');
      await layer(alice, 'Equation を非表示').click();
      await layer(alice, 'Circle').click(); await number(alice, 'Position X', '800');
      await layer(alice, 'Sigmoid path').click({ modifiers: ['Shift'] });
      await alice.keyboard.press('Control+g');
      const before = (await state(alice)).scenes['scene-1'];
      // Appending always starts from the last composition, even while viewing an earlier one.
      await layer(alice, 'Composition 1').click();
      if (entry === 'timeline') await alice.locator('.add-composition').click();
      else await alice.locator('.composition-list').getByRole('button', { name: 'Composition を追加', exact: true }).click();
      await expect(layer(alice, 'Composition 3')).toHaveAttribute('aria-pressed', 'true');
      await expect(alice.getByRole('status').filter({ hasText: 'Composition 2 の配置と内容を引き継ぎました' })).toBeVisible();
      await expect(layer(bob, 'Composition 3')).toBeVisible();
      const after = (await state(alice)).scenes['scene-1'];
      const created = after.compositionOrder.at(-1)!;
      expect(after.compositions[created].states).toEqual(before.compositions['comp-2'].states);
      expect(after.objects).toEqual(before.objects);
      expect(after.compositions[created].states.equation.visible).toBe(false);
      await layer(alice, 'Circle').click(); await number(alice, 'Position X', '1000');
      await layer(bob, 'Composition 3').click(); await layer(bob, 'Circle').click();
      await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('1000');
      await layer(bob, 'Composition 2').click();
      await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('800');
      await number(bob, 'Position Y', '220');
      await layer(alice, 'Circle').click(); await expect(layer(alice, 'Circle')).toBeFocused(); await alice.keyboard.press('Control+z');
      await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('800');
      await alice.keyboard.press('Control+z');
      await expect(layer(bob, 'Composition 3')).toHaveCount(0);
      await expect(bob.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('220');
    } finally { await first.close(); await second.close(); }
  });
}

test('real keyboard group cut and paste across compositions retains relative placement, isolates pasted identity, and preserves peer edits through Undo and Redo', async ({ browser }) => {
  const first = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const second = await browser.newContext();
  const alice = await first.newPage(), bob = await second.newPage(); const room = crypto.randomUUID();
  try {
    await Promise.all([open(alice, room), open(bob, room)]);
    await layer(alice, 'Composition 2').click();
    await layer(alice, 'Circle').click(); await layer(alice, 'Sigmoid path').click({ modifiers: ['Shift'] });
    await alice.keyboard.press('Control+g');
    await alice.keyboard.press('Control+x');
    await expect(alice.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toHaveCount(0);
    await layer(bob, 'Circle').click(); await number(bob, 'Position X', '320');
    await layer(alice, 'Composition 1').click();
    await alice.keyboard.press('Control+v');
    await expect(layer(bob, 'Circle copy')).toBeVisible();
    const scene = (await state(alice)).scenes['scene-1'];
    const circle = Object.values(scene.objects).find(object => object.name === 'Circle copy')!;
    const path = Object.values(scene.objects).find(object => object.name === 'Sigmoid path copy')!;
    expect(circle.groupId).toBeTruthy(); expect(circle.groupId).toBe(path.groupId);
    expect(circle.groupId).not.toBe(scene.objects.circle.groupId);
    const destination = scene.compositions['comp-1'].states;
    expect(destination[circle.id].x - destination[path.id].x).toBe(710);
    expect(destination[circle.id].y - destination[path.id].y).toBe(-330);
    expect(scene.compositions['comp-2'].states[circle.id].visible).toBe(false);
    await layer(alice, 'Circle copy').click(); await alice.keyboard.press('Control+z');
    await expect(layer(bob, 'Circle copy')).toHaveCount(0);
    await alice.keyboard.press('Control+z');
    await layer(alice, 'Composition 2').click();
    await expect(alice.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('320');
    await alice.keyboard.press('Control+Shift+z');
    await expect(alice.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toHaveCount(0);
    await alice.keyboard.press('Control+z');
    await layer(alice, 'Circle').click(); await alice.keyboard.press('Backspace');
    await expect(alice.getByRole('status').filter({ hasText: 'Composition 2 から非表示' })).toBeVisible();
    await expect(bob.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
    await alice.keyboard.press('Control+z');
    await expect(alice.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
  } finally { await first.close(); await second.close(); }
});

test('Japanese composition keys never activate object tools or deletion; clicking canvas restores object keyboard focus', async ({ page }) => {
  await open(page, crypto.randomUUID());
  await layer(page, 'Circle').click();
  // Chromium automation cannot drive a host OS IME. Verify its actual DOM protocol,
  // including keydown.isComposing outside inputs, without claiming an OS IME test.
  const blocked = await page.locator('[data-testid="stage-main"]').evaluate(element => {
    const events = ['Delete', 'Backspace', 't', 'e', 'ArrowRight'].map(key => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
      element.dispatchEvent(event); return event.defaultPrevented;
    });
    return events;
  });
  expect(blocked).toEqual([false, false, false, false, false]);
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  await expect(page.locator('.tool-instruction')).toHaveCount(0);
  const name = page.getByRole('textbox', { name: 'Object name', exact: true });
  await name.fill('日本語の図形'); await name.press('End'); await name.press('Backspace');
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
  const circle = page.locator('[data-testid="stage-main"] [data-object-id="circle"]');
  await circle.click();
  await expect(name).not.toBeFocused();
  await page.keyboard.press('Delete');
  await expect(circle).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(circle).toBeVisible();
});
