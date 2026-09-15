import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, room: string) {
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
}
async function copy(page: Page, cut = false) {
  return page.evaluate(cut => {
    const clipboardData = new DataTransfer();
    document.body.dispatchEvent(new ClipboardEvent(cut ? 'cut' : 'copy', { clipboardData, bubbles: true, cancelable: true }));
    return clipboardData.getData('text/plain');
  }, cut);
}
async function paste(page: Page, text: string) {
  await page.evaluate(text => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test('pasting copied objects synchronizes and Undo preserves a peer’s source edit', async ({ browser }) => {
  const first = await browser.newContext(); const second = await browser.newContext();
  const alice = await first.newPage(); const bob = await second.newPage(); const room = crypto.randomUUID();
  try {
    await Promise.all([open(alice, room), open(bob, room)]);
    const data = await copy(alice);
    await bob.getByRole('spinbutton', { name: 'Position X', exact: true }).fill('320');
    await bob.getByRole('spinbutton', { name: 'Position X', exact: true }).press('Tab');
    await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('320');
    await paste(alice, data);
    await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('269');
    await expect(bob.getByRole('button', { name: 'Circle copy', exact: true })).toBeVisible();
    await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Circle copy', exact: true })).toHaveCount(0);
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('320');
  } finally { await first.close(); await second.close(); }
});

test('cut and paste into another composition preserves the earlier composition and each step can be undone', async ({ page }) => {
  await open(page, crypto.randomUUID());
  const data = await copy(page, true);
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await paste(page, data);
  await expect(page.getByRole('button', { name: 'Circle copy', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Circle copy', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await page.getByRole('button', { name: 'Composition 1', exact: true }).click();
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
});

test('native clipboard shortcuts paste in place and text fields keep normal clipboard behavior', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, crypto.randomUUID());
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+Shift+v');
  await expect(page.getByRole('button', { name: 'Circle copy', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  const intercepted = await page.getByRole('textbox', { name: 'Object name', exact: true }).evaluate(element => {
    const clipboardData = new DataTransfer(); const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(intercepted).toBe(false);
});

test('selecting UI text keeps copy, cut and delete away from selected canvas objects', async ({ page }) => {
  await open(page, crypto.randomUUID());
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const results = await page.getByRole('heading', { name: 'Make it move.', exact: true }).evaluate(element => {
    const selection = window.getSelection()!; const range = document.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range);
    return ['copy', 'cut'].map(type => {
      const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      element.dispatchEvent(event); return event.defaultPrevented;
    });
  });
  expect(results).toEqual([false, false]);
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-testid="stage-main"] [data-object-id="circle"]')).toBeVisible();
});
