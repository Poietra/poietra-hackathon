import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) { await page.evaluate(() => window.exportDialogProbe.open()); await expect(page.getByRole('dialog')).toBeVisible(); }
async function ready(page: Page, index = 0) {
  await expect.poll(() => page.evaluate(() => window.exportDialogProbe.state().capabilities)).toBe(index + 1);
  await page.evaluate(index => window.exportDialogProbe.capabilities(index, { mp4: true, webm: true }), index);
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled();
}
async function start(page: Page) { await page.getByRole('button', { name: 'Export video', exact: true }).click(); }
test.beforeEach(async ({ page }) => { await page.goto('/tests/e2e/fixtures/export-dialog.html'); });

test('freezes the scene, filename and aspect-preserving settings, and downloads the same result again', async ({ page }) => {
  await page.evaluate(() => window.exportDialogProbe.changeSource(900, 1600, 'Portrait', 'My movie'));
  await open(page); await ready(page);
  await expect(page.getByRole('combobox', { name: 'Export resolution' })).toContainText('Source · 900 × 1600');
  await expect(page.getByRole('combobox', { name: 'Export resolution' })).toContainText('720p · 720 × 1280');
  await page.getByRole('combobox', { name: 'Export resolution' }).selectOption('1080');
  await page.getByRole('combobox', { name: 'Export frame rate' }).selectOption('60');
  await start(page);
  await expect(page.getByRole('status')).toContainText('準備しています');
  await page.evaluate(() => window.exportDialogProbe.changeSource(600, 600, 'Peer renamed scene', 'Peer renamed project'));
  await expect(page.getByRole('dialog')).toContainText('Portrait · 3.40 seconds');
  await expect(page.getByRole('combobox', { name: 'Export resolution' })).toBeDisabled();
  const state = await page.evaluate(() => window.exportDialogProbe.state());
  expect(state.exports[0]).toMatchObject({ scene: { width: 900, height: 1600, name: 'Portrait' }, width: 1080, height: 1920, fps: 60 });
  await page.evaluate(() => window.exportDialogProbe.progress(0, 0.25));
  await expect(page.getByRole('progressbar', { name: 'Export progress' })).toHaveAttribute('value', '0.25');
  const downloaded = page.waitForEvent('download'); await page.evaluate(() => window.exportDialogProbe.finish(0));
  expect((await downloaded).suggestedFilename()).toBe('My movie-Portrait.mp4');
  await expect(page.getByRole('status')).toContainText('書き出しが完了しました');
  const again = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download again' }).click();
  expect((await again).suggestedFilename()).toBe('My movie-Portrait.mp4');
  expect((await page.evaluate(() => window.exportDialogProbe.state())).exports).toHaveLength(1);
  await page.getByRole('button', { name: 'New export' }).click();
  await expect(page.getByRole('dialog')).toContainText('Peer renamed scene');
  await expect(page.getByRole('combobox', { name: 'Export resolution' })).toBeEnabled();
});

test('cancel ignores late progress and completion while the next export can fail and retry', async ({ page }) => {
  const downloads: string[] = []; page.on('download', value => downloads.push(value.suggestedFilename()));
  await open(page); await ready(page); await start(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('キャンセルしました');
  expect((await page.evaluate(() => window.exportDialogProbe.state())).exports[0].aborted).toBe(true);
  await start(page);
  await page.evaluate(() => { window.exportDialogProbe.progress(0, 0.99); window.exportDialogProbe.finish(0); });
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '0');
  await expect(page.getByRole('status')).toContainText('準備しています');
  await page.evaluate(() => window.exportDialogProbe.fail(1));
  await expect(page.getByRole('alert')).toContainText('Encoder interrupted');
  expect(downloads).toEqual([]);
  await start(page); const download = page.waitForEvent('download');
  await page.evaluate(() => window.exportDialogProbe.finish(2)); await download;
  await expect(page.getByRole('status')).toContainText('完了しました');
});

test('stale capabilities cannot overwrite a reopened dialog and unsupported browsers get an explanation', async ({ page }) => {
  await open(page); await expect.poll(() => page.evaluate(() => window.exportDialogProbe.state().capabilities)).toBe(1);
  await page.getByRole('button', { name: '閉じる', exact: true }).click(); await open(page);
  await expect.poll(() => page.evaluate(() => window.exportDialogProbe.state().capabilities)).toBe(2);
  await page.evaluate(() => window.exportDialogProbe.capabilities(1, { mp4: false, webm: true }));
  await expect(page.getByRole('combobox', { name: 'Export format' })).toHaveValue('webm');
  await page.evaluate(() => window.exportDialogProbe.capabilities(0, { mp4: true, webm: false }));
  await expect(page.getByRole('combobox', { name: 'Export format' })).toHaveValue('webm');
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await open(page);
  await expect.poll(() => page.evaluate(() => window.exportDialogProbe.state().capabilities)).toBe(3);
  await page.evaluate(() => window.exportDialogProbe.capabilities(2, { mp4: false, webm: false }));
  await expect(page.getByRole('alert')).toContainText('Chrome または Edge');
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeDisabled();
});

test('close and unmount abort in-flight exports, and neither late completion can download', async ({ page }) => {
  const downloads: string[] = []; page.on('download', value => downloads.push(value.suggestedFilename()));
  await open(page); await ready(page); await start(page); await page.keyboard.press('Escape');
  expect((await page.evaluate(() => window.exportDialogProbe.state())).exports[0].aborted).toBe(true);
  await open(page); await ready(page, 1); await start(page);
  await page.evaluate(() => window.exportDialogProbe.finish(0));
  await expect(page.getByRole('status')).toContainText('準備しています');
  await page.evaluate(() => window.exportDialogProbe.unmount());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await page.evaluate(() => window.exportDialogProbe.state())).exports[1].aborted).toBe(true);
  await page.evaluate(() => { window.exportDialogProbe.progress(1, 1); window.exportDialogProbe.finish(1); });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(downloads).toEqual([]);
});

test('native dimensions remain exact for WebM and MP4 shows its required even dimensions', async ({ page }) => {
  await page.evaluate(() => window.exportDialogProbe.changeSource(1001, 751, 'Custom', 'Original'));
  await open(page); await ready(page);
  await expect(page.getByRole('combobox', { name: 'Export resolution' })).toContainText('Source · 1002 × 752');
  await expect(page.getByRole('dialog')).toContainText('偶数ピクセル');
  await page.getByRole('combobox', { name: 'Export format' }).selectOption('webm');
  await expect(page.getByRole('combobox', { name: 'Export resolution' })).toContainText('Source · 1001 × 751');
  await page.getByRole('combobox', { name: 'Export frame rate' }).selectOption('24'); await start(page);
  expect((await page.evaluate(() => window.exportDialogProbe.state())).exports[0]).toMatchObject({ format: 'webm', width: 1001, height: 751, fps: 24 });
});

test('capability errors are visible and a fresh opening can recover', async ({ page }) => {
  await open(page); await expect.poll(() => page.evaluate(() => window.exportDialogProbe.state().capabilities)).toBe(1);
  await page.evaluate(() => window.exportDialogProbe.capabilityError(0));
  await expect(page.getByRole('alert')).toContainText('Capability check failed');
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await open(page); await ready(page, 1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
