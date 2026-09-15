import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, room = crypto.randomUUID()) {
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
}
async function rowOrder(page: Page) { return page.locator('.layer-tree [data-layer-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-layer-id'))); }
async function paintOrder(page: Page) { return page.locator('[data-testid="stage-main"] .scene-svg [data-object-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-object-id'))); }

// Lock state is shared. A dirty field must not sneak a write through its blur
// handler when another participant locks the selected layer.
test('a collaborator can lock a layer and all direct Inspector, timing and visibility edits become unavailable', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]);
  await alice.getByRole('button', { name: 'Circle', exact: true }).click();
  const x = alice.getByRole('spinbutton', { name: 'Position X', exact: true }); await x.fill('480');
  await bob.getByRole('button', { name: 'Circle', exact: true }).click();
  await bob.getByRole('button', { name: 'ロック', exact: true }).click();
  await expect(x).toBeDisabled();
  await expect(alice.getByRole('textbox', { name: 'Object name', exact: true })).toBeDisabled();
  await expect(alice.getByRole('textbox', { name: 'Fillのカラーコード', exact: true })).toBeDisabled();
  await expect(alice.getByRole('combobox', { name: 'Object effect', exact: true })).toBeDisabled();
  await expect(alice.getByRole('button', { name: '左揃え', exact: true })).toBeDisabled();
  await expect(alice.getByRole('button', { name: 'Circle を非表示', exact: true })).toBeDisabled();
  await expect(alice.getByRole('button', { name: 'Bring to front', exact: true })).toBeDisabled();
  await expect(alice.locator('[data-object-id="circle"]')).toHaveAttribute('transform', 'translate(245 520) rotate(0)');
  await alice.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toBeDisabled();
  await expect(alice.getByRole('combobox', { name: 'Animation type', exact: true })).toBeDisabled();
  await expect(alice.getByRole('button', { name: 'Edit Bézier path', exact: true })).toBeDisabled();
  await expect(alice.getByRole('combobox', { name: 'Present in destination composition', exact: true })).toBeDisabled();
  await alice.getByRole('button', { name: 'ロック解除', exact: true }).click();
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toBeEnabled();
  await alice.getByRole('button', { name: 'Composition 1', exact: true }).click();
  await expect(x).toHaveValue('245');
  await expect(bob.getByRole('button', { name: 'ロック', exact: true })).toBeVisible();
  await a.close(); await b.close();
});

test('front/back changes match painting order, synchronize and undo without changing a peer’s color', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]);
  for (const page of [alice, bob]) { await page.getByRole('button', { name: 'Composition 2', exact: true }).click(); await page.getByRole('button', { name: 'Circle', exact: true }).click(); }
  await expect.poll(() => rowOrder(alice)).toEqual(['equation', 'circle', 'sigmoid']);
  await alice.getByRole('button', { name: 'Send to back', exact: true }).click();
  await expect.poll(() => paintOrder(bob)).toEqual(['circle', 'sigmoid', 'equation']);
  await expect.poll(() => rowOrder(bob)).toEqual(['equation', 'sigmoid', 'circle']);
  await alice.getByRole('button', { name: 'Bring to front', exact: true }).click();
  await expect.poll(() => paintOrder(bob)).toEqual(['sigmoid', 'equation', 'circle']);
  await bob.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
  await expect(alice.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect.poll(() => rowOrder(bob)).toEqual(['equation', 'sigmoid', 'circle']);
  await expect(bob.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await a.close(); await b.close();
});

test('linked rows retain actual front-to-back order even when another layer sits between them', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
  await page.getByRole('button', { name: 'Bring to front', exact: true }).click();
  await expect.poll(() => rowOrder(page)).toEqual(['sigmoid', 'equation', 'circle']);
  await expect.poll(() => paintOrder(page)).toEqual(['circle', 'equation', 'sigmoid']);
  await page.getByRole('button', { name: 'Circle をロック', exact: true }).click();
  await page.getByRole('button', { name: 'Circle', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: '左揃え', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Group', exact: true })).toBeDisabled();
});
