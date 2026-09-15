import { expect, test, type Locator, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto(`/?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByTestId('stage-main').locator('[data-object-id="circle"]')).toBeVisible();
}
async function center(locator: Locator) {
  const box = await locator.boundingBox(); expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test('canvas hover, constrained movement and cancellation show accurate feedback without blocking selection', async ({ page }, testInfo) => {
  await open(page);
  const stage = page.getByTestId('stage-main');
  const circle = stage.locator('.scene-svg [data-object-id="circle"]');
  const start = await center(circle);
  await page.mouse.move(start.x, start.y);
  await expect(stage.locator('[data-hover-id="circle"]')).toBeVisible();
  await expect(stage.locator('.stage-feedback')).toContainText('Circle');
  await circle.click();
  await expect(stage.locator('[data-selection-id="circle"]')).toBeVisible();
  await expect(stage.locator('[data-hover-id]')).toHaveCount(0);
  const original = await page.getByRole('spinbutton', { name: 'Position X', exact: true }).inputValue();
  const originY = await page.getByRole('spinbutton', { name: 'Position Y', exact: true }).inputValue();
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.keyboard.down('Shift');
  await page.mouse.move(start.x + 40, start.y + 12, { steps: 4 });
  await expect(stage).toHaveAttribute('data-gesture', 'move');
  await expect(stage.locator('.stage-feedback')).toContainText('ΔY 0');
  await expect(page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue(originY);
  await expect(stage.locator('.operation-feedback-announcement')).toHaveText('');
  await page.screenshot({ path: testInfo.outputPath('canvas-moving.png') });
  await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(stage.locator('.stage-feedback')).toHaveAttribute('data-feedback-state', 'complete');
  await expect(stage.getByRole('status')).toContainText('変更を確定');
  const changed = await page.getByRole('spinbutton', { name: 'Position X', exact: true }).inputValue();
  expect(changed).not.toBe(original);
  const second = await center(circle);
  await page.mouse.move(second.x, second.y); await page.mouse.down(); await page.mouse.move(second.x + 25, second.y, { steps: 3 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(stage.locator('.stage-feedback')).toHaveAttribute('data-feedback-state', 'cancelled');
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(changed);
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(original);
});

test('locked canvas objects explain selection-only behavior and resize reports actual dimensions', async ({ page }, testInfo) => {
  await open(page); await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const stage = page.getByTestId('stage-main');
  await page.getByRole('button', { name: 'ロック', exact: true }).click();
  await expect(stage.locator('.stage-feedback')).toContainText('ロック中 · 選択のみ');
  await expect(stage.locator('[data-selection-id="circle"]')).toHaveAttribute('data-locked', 'true');
  await expect(stage.locator('[data-transform-handle]')).toHaveCount(0);
  const circle = stage.locator('.scene-svg [data-object-id="circle"]');
  const before = await circle.getAttribute('transform'), at = await center(circle);
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 25, at.y + 10); await page.mouse.up();
  await expect(circle).toHaveAttribute('transform', before!);
  await page.getByRole('button', { name: 'ロック解除', exact: true }).click();
  const handle = await center(stage.locator('[data-transform-handle="se"]'));
  await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x + 35, handle.y + 25, { steps: 4 });
  await expect(stage.locator('.stage-feedback')).toContainText('サイズを変更');
  const width = Number(await page.getByRole('spinbutton', { name: 'Width', exact: true }).inputValue());
  await expect(stage.locator('.operation-feedback-detail')).toContainText(`${Math.round(width)} ×`);
  await page.screenshot({ path: testInfo.outputPath('canvas-resizing.png') });
  await page.mouse.up();
  await expect(stage.locator('.stage-feedback')).toHaveAttribute('data-feedback-state', 'complete');
});

test('transition timing feedback follows trimming, cancel, keyboard selection and lock at narrow width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 850 }); await open(page);
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  const row = page.locator('[data-track-object-id="circle"]'), bar = row.locator('.animation-bar');
  const feedback = page.locator('.timeline-feedback');
  await bar.focus(); await page.keyboard.press('Enter');
  await expect(bar).toHaveAttribute('aria-pressed', 'true');
  await expect(feedback).toContainText('0–600 ms');
  const edge = await center(bar.locator('[data-edge="end"]')), lane = await row.locator('.track-lane').boundingBox();
  await page.mouse.move(edge.x, edge.y); await page.mouse.down(); await page.mouse.move(edge.x + lane!.width / 8, edge.y, { steps: 5 });
  await expect(feedback).toHaveAttribute('data-feedback-state', 'active');
  await expect(feedback).toContainText('終了を調整');
  await expect(feedback).toContainText('0–700 ms');
  const detail = feedback.locator('.operation-feedback-detail');
  await expect(detail).toBeVisible();
  const detailBox = await detail.boundingBox(), ruler = await page.locator('.track-ruler').boundingBox();
  expect(detailBox!.y + detailBox!.height).toBeLessThanOrEqual(ruler!.y);
  await expect(row).toHaveAttribute('data-track-active', 'true');
  await page.screenshot({ path: testInfo.outputPath('timeline-trimming-narrow.png') });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(feedback).toHaveAttribute('data-feedback-state', 'cancelled');
  await expect(bar).toHaveAttribute('aria-label', 'Circle Move: 0–600 ms');
  await row.locator('.track-label').click();
  await page.getByRole('button', { name: 'ロック', exact: true }).click();
  await expect(feedback).toContainText('ロック中 · 選択のみ');
  await expect(bar).toHaveAttribute('aria-disabled', 'true');
  await expect(bar).toHaveAttribute('aria-description', 'ロック中のため時間は変更できません');
  expect(await bar.evaluate(element => getComputedStyle(element).borderStyle)).toBe('dashed');
});

test('media clips select with the keyboard, drag from committed input, and cancel without losing selection', async ({ page }, testInfo) => {
  await open(page);
  const samples = 16000 * 2, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / 16000) * 8000), 44 + i * 2);
  await page.getByLabel('音声・動画ファイル', { exact: true }).setInputFiles({ name: 'Feedback.wav', mimeType: 'audio/wav', buffer: bytes });
  const clip = page.getByRole('button', { name: '音声クリップ Feedback', exact: true });
  await expect(clip).toBeVisible();
  await clip.focus(); await page.keyboard.press('Enter');
  await expect(clip).toHaveAttribute('aria-pressed', 'true');
  const input = page.getByRole('spinbutton', { name: '素材の開始位置', exact: true });
  await input.fill('500'); // Deliberately leave this edit uncommitted until pointer focus changes.
  const at = await center(clip), lane = await clip.locator('..').boundingBox();
  await page.mouse.move(at.x, at.y); await page.mouse.down();
  await page.mouse.move(at.x + lane!.width * 100 / 3400, at.y, { steps: 4 }); await page.mouse.up();
  await expect(input).toHaveValue('600');
  await expect(page.locator('.media-track-status')).toContainText('タイミングを更新しました');
  const next = await center(clip);
  await page.mouse.move(next.x, next.y); await page.mouse.down(); await page.mouse.move(next.x + 35, next.y, { steps: 3 });
  await expect(page.locator('.media-track-status')).toHaveAttribute('aria-live', 'off');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(input).toHaveValue('600');
  await expect(clip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.media-track-status')).toContainText('取り消しました');
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(input).toHaveValue('500');
  // Once this clip determines the scene end, dragging must still move it later.
  await input.fill('2000'); await input.press('Tab');
  const end = await center(clip), endLane = await clip.locator('..').boundingBox();
  await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.move(end.x + endLane!.width / 4, end.y, { steps: 4 }); await page.mouse.up();
  await expect(input).toHaveValue('3000');
  await expect(page.getByRole('slider', { name: '素材トラックの再生位置', exact: true })).toHaveAttribute('max', '5000');
  expect(await clip.evaluate(element => getComputedStyle(element).width)).not.toMatch(/NaN|Infinity|^-/);
  const bounds = await page.locator('.media-timeline').boundingBox(), transport = await page.locator('.transport').boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(transport!.y);
  await expect(page.getByRole('button', { name: 'Preview project', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('media-feedback.png') });
  await page.setViewportSize({ width: 1100, height: 800 });
  const tools = page.locator('.floating-tools');
  const toolBox = await tools.boundingBox(), stageArea = await page.locator('.main-stage-area').boundingBox();
  expect(toolBox!.y).toBeGreaterThanOrEqual(stageArea!.y);
  expect(toolBox!.y + toolBox!.height).toBeLessThanOrEqual(stageArea!.y + stageArea!.height);
  await expect(tools.getByRole('button', { name: '選択 (V)', exact: true })).toBeInViewport();
  await tools.getByRole('button', { name: '共同編集チャット', exact: true }).focus();
  expect(await tools.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
