import { expect, test } from '@playwright/test';

test('arrow keys nudge a linked selection; key repeat is one undo and Shift moves ten pixels', async ({ page }) => {
  await page.goto(`/?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+g');
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(550);
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('247');
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('247');
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('510');
  await page.getByRole('button', { name: 'ロック', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
});
