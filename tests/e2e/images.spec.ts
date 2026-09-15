import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { compileProposal } from '../../shared/ai';
import { readProject } from '../../shared/document';
import { parseProjectFile } from '../../shared/project-file';

const execute = promisify(execFile);
async function open(page: Page, room = crypto.randomUUID()) {
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return room;
}
async function fixture(page: Page, name = 'Together.png') {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 40, 40); ctx.fillStyle = '#00ff00'; ctx.fillRect(40, 0, 40, 40); ctx.clearRect(32, 12, 16, 16);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') };
}
async function observer(page: Page, room: string) {
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', (synced: boolean) => { if (synced) resolve(); }));
  return { doc, project: () => readProject(doc)!, close: () => { provider.destroy(); doc.destroy(); } };
}
async function upload(page: Page, name?: string) {
  await page.getByLabel('画像ファイル', { exact: true }).setInputFiles(await fixture(page, name));
  await expect(page.getByRole('button', { name: name?.replace('.png', '') || 'Together', exact: true })).toBeVisible();
  await expect(page.locator('.scene-svg image').first()).toHaveAttribute('href', /^data:image\/png;base64,/);
}
async function field(page: Page, name: string, value: string) { const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); }

test('upload shares raster bytes and editable geometry, keeps aspect ratio, and preserves a peer edit on creation Undo', async ({ page, browser }, testInfo) => {
  const room = await open(page), watch = await observer(page, room), context = await browser.newContext(), peer = await context.newPage();
  try {
    await open(peer, room); await upload(page);
    const object = Object.values(watch.project().scenes['scene-1'].objects).find(object => object.kind === 'image')!;
    expect(object.image).toMatchObject({ width: 80, height: 40 }); expect(object.image!.src).toMatch(new RegExp(`^/api/rooms/${room}/images/[a-f0-9]{64}$`));
    await expect(peer.getByRole('button', { name: 'Together', exact: true })).toBeVisible();
    await expect(peer.locator('.scene-svg image')).toHaveAttribute('href', /^data:image\/png;base64,/);
    await field(page, 'Width', '320'); await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('160');
    await peer.getByRole('button', { name: 'Together', exact: true }).click();
    await expect(peer.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('320');
    await field(peer, 'Position X', '700');
    await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('700');
    // Undo the local resize, then the image's creation. Peer's position protects it.
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'Together', exact: true })).toBeVisible();
    await expect(peer.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('700');
    const source = object.image!.src, response = await peer.request.get(source);
    expect(response.ok()).toBe(true); expect(response.headers()['content-type']).toBe('image/png');
    expect((await response.body()).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    await page.screenshot({ path: testInfo.outputPath('shared-image.png'), fullPage: true });
  } finally { watch.close(); await context.close(); }
});

test('saving embeds pixels and opening the file uploads them into a new room', async ({ page }, testInfo) => {
  const room = await open(page); await upload(page);
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project', exact: true }).click()]);
  const path = testInfo.outputPath('image.poietra.json'); await download.saveAs(path);
  const saved = parseProjectFile(await readFile(path, 'utf8'));
  const image = Object.values(saved.scenes['scene-1'].objects).find(object => object.kind === 'image')!;
  expect(image.image!.src).toMatch(/^data:image\/png;base64,/);
  // The imported file must not depend on the original room's asset URL.
  await page.route(`**/api/rooms/${room}/images/**`, route => route.abort());
  await page.getByLabel('プロジェクトファイル', { exact: true }).setInputFiles(path);
  await expect(page).not.toHaveURL(new RegExp(room)); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.locator('.scene-svg image')).toHaveAttribute('href', /^data:image\/png;base64,/);
  const nextRoom = new URL(page.url()).searchParams.get('room')!, watch = await observer(page, nextRoom);
  try { const nextImage = Object.values(watch.project().scenes['scene-1'].objects).find(object => object.kind === 'image')!; expect(nextImage.image!.src).toContain(`/api/rooms/${nextRoom}/images/`); }
  finally { watch.close(); }
});

test('file drop and clipboard paste create image objects while text fields keep their paste behavior', async ({ page }) => {
  await open(page); const file = await fixture(page, 'Dropped.png');
  await page.locator('[data-testid="stage-main"]').evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'Dropped.png', { type: 'image/png' }));
    const rect = element.getBoundingClientRect(); element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + rect.width / 4, clientY: rect.top + rect.height / 4 }));
  }, file.buffer.toString('base64'));
  await expect(page.getByRole('button', { name: 'Dropped', exact: true })).toBeVisible();
  expect(Math.abs(Number(await page.getByRole('spinbutton', { name: 'Position X', exact: true }).inputValue()) - 320)).toBeLessThan(2);
  expect(Math.abs(Number(await page.getByRole('spinbutton', { name: 'Position Y', exact: true }).inputValue()) - 180)).toBeLessThan(2);
  await page.locator('[data-testid="stage-main"]').evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), clipboardData = new DataTransfer(); clipboardData.items.add(new File([bytes], 'Pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, file.buffer.toString('base64'));
  await expect(page.getByRole('button', { name: 'Pasted', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const consumed = await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).evaluate((element, base64) => {
    const clipboardData = new DataTransfer(); clipboardData.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'In chat.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }); element.dispatchEvent(event); return event.defaultPrevented;
  }, file.buffer.toString('base64'));
  expect(consumed).toBe(false); await expect(page.getByRole('button', { name: 'In chat', exact: true })).toHaveCount(0);
});

for (const format of ['mp4', 'webm'] as const) test(`the actual ${format} contains image colors and transparency`, async ({ page }, testInfo) => {
  test.setTimeout(90000); await open(page); await upload(page); await field(page, 'Width', '320');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption(format);
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'Export video', exact: true }).click()]);
  const path = testInfo.outputPath(`image.${format}`); await download.saveAs(path);
  const decoded = await execute('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
  const probe = await execute('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path]);
  const size = JSON.parse(probe.stdout).streams[0]; expect(size).toMatchObject({ width: 1280, height: 720 });
  const pixel = (x: number, y: number) => [...decoded.stdout.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3)];
  const red = pixel(540, 320), green = pixel(740, 320), hole = pixel(640, 360);
  expect(red[0]).toBeGreaterThan(220); expect(red[1]).toBeLessThan(30);
  expect(green[1]).toBeGreaterThan(220); expect(green[0]).toBeLessThan(30);
  expect(Math.max(...hole)).toBeLessThan(30);
});

test('an uploaded image receives AI Move and Write tracks and previews the right path and reveal', async ({ page }) => {
  const room = await open(page), watch = await observer(page, room);
  try {
    await upload(page);
    const object = Object.values(watch.project().scenes['scene-1'].objects).find(object => object.kind === 'image')!;
    await page.route('**/api/health', route => route.fulfill({ json: { ok: true, ai: true } }));
    let calls = 0;
    await page.route('**/api/ai/propose', route => {
      calls++;
      const operations = calls === 1 ? [
        { action: 'setState' as const, compositionId: 'comp-2', objectId: object.id, property: 'visible' as const, value: true },
        { action: 'setState' as const, compositionId: 'comp-2', objectId: object.id, property: 'x' as const, value: 1000 },
        { action: 'setTrack' as const, transitionId: 'transition-1', objectId: object.id, property: 'type' as const, value: 'move' },
        { action: 'setTrack' as const, transitionId: 'transition-1', objectId: object.id, property: 'easing' as const, value: 'linear' },
      ] : [
        { action: 'setState' as const, compositionId: 'comp-1', objectId: object.id, property: 'visible' as const, value: false },
        { action: 'setTrack' as const, transitionId: 'transition-1', objectId: object.id, property: 'type' as const, value: 'write' },
      ];
      return route.fulfill({ json: compileProposal(watch.doc, watch.project(), 'scene-1', { message: calls === 1 ? '画像を移動します。' : '画像を左から表示します。', operations }) });
    });
    // Refresh the availability indicator without waiting for its periodic health check.
    await page.reload(); await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Together', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).fill('@codex 画像を次の場面へ右に動かして');
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('400');
    await expect(page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${object.id}"]`)).toHaveAttribute('transform', 'translate(820 360) rotate(0)');
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('0');
    await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).fill('@codex 画像を左からWriteで登場させて');
    await page.getByRole('button', { name: '送信', exact: true }).click();
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('400');
    await expect(page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${object.id}"] clipPath[id$="-reveal"] rect`)).toHaveAttribute('width', '40');
    expect(calls).toBe(2);
  } finally { watch.close(); }
});

test('failed image uploads and unsupported files leave the composition unchanged', async ({ page }) => {
  const room = await open(page), watch = await observer(page, room);
  try {
    await page.route('**/api/rooms/*/images', route => route.fulfill({ status: 503, json: { error: '画像を保存できませんでした。' } }));
    await page.getByLabel('画像ファイル', { exact: true }).setInputFiles(await fixture(page));
    await expect(page.getByRole('alert').filter({ hasText: '画像を保存できませんでした' })).toBeVisible();
    expect(Object.values(watch.project().scenes['scene-1'].objects).some(object => object.kind === 'image')).toBe(false);
    await page.getByLabel('画像ファイル', { exact: true }).setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg onload="alert(1)"/>') });
    await expect(page.getByRole('alert').filter({ hasText: 'PNG・JPEG・WebP' })).toBeVisible();
    expect(Object.values(watch.project().scenes['scene-1'].objects).some(object => object.kind === 'image')).toBe(false);
  } finally { watch.close(); }
});

test('JPEG and WebP can be added together and undone as one edit', async ({ page }) => {
  const room = await open(page), watch = await observer(page, room);
  try {
    const files = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 48;
      const context = canvas.getContext('2d')!; context.fillStyle = '#44aacc'; context.fillRect(0, 0, 96, 48);
      return ['image/jpeg', 'image/webp'].map(type => ({ name: type === 'image/jpeg' ? 'Photo.jpg' : 'Logo.webp', mimeType: type, encoded: canvas.toDataURL(type).split(',')[1] }));
    });
    await page.getByLabel('画像ファイル', { exact: true }).setInputFiles(files.map(file => ({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.encoded, 'base64') })));
    await expect(page.getByRole('button', { name: 'Photo', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Logo', exact: true })).toBeVisible();
    await expect.poll(() => Object.values(watch.project().scenes['scene-1'].objects).filter(object => object.kind === 'image').length).toBe(2);
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Photo', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Logo', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'やり直す (⌘⇧Z)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Photo', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Logo', exact: true })).toBeVisible();
  } finally { watch.close(); }
});

test('changing the target scene while uploading does not insert images into either scene', async ({ page }) => {
  const room = await open(page), watch = await observer(page, room); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/rooms/*/images', async route => { started = true; await gate; await route.continue().catch(() => {}); });
  try {
    await page.getByLabel('画像ファイル', { exact: true }).setInputFiles(await fixture(page));
    await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Scene を追加', exact: true }).click(); release();
    await expect(page.getByRole('button', { name: 'Add image', exact: true })).toBeEnabled();
    expect(Object.values(watch.project().scenes).flatMap(scene => Object.values(scene.objects)).some(object => object.kind === 'image')).toBe(false);
  } finally { release(); watch.close(); }
});

test('large images are normalized and portable imports preserve compressed pixels exactly', async ({ page }, testInfo) => {
  const room = await open(page), watch = await observer(page, room);
  try {
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 3072; canvas.height = 1536;
      const context = canvas.getContext('2d')!, pixels = context.createImageData(canvas.width, canvas.height);
      let seed = 12345;
      for (let index = 0; index < pixels.data.length; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[index] = index % 4 === 3 ? 255 : seed >>> 24; }
      context.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('画像ファイル', { exact: true }).setInputFiles({ name: 'Texture.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
    await expect(page.getByRole('button', { name: 'Texture', exact: true })).toBeVisible();
    const original = Object.values(watch.project().scenes['scene-1'].objects).find(object => object.kind === 'image')!.image!;
    expect(original.width).toBeLessThanOrEqual(2048); expect(original.width / original.height).toBe(2);
    const response = await page.request.get(original.src); expect(response.headers()['content-type']).toBe('image/webp'); expect((await response.body()).length).toBeLessThanOrEqual(1024 * 1024);
    await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project', exact: true }).click()]);
    const path = testInfo.outputPath('texture.poietra.json'); await download.saveAs(path);
    await page.getByLabel('プロジェクトファイル', { exact: true }).setInputFiles(path);
    await expect(page).not.toHaveURL(new RegExp(room)); await expect(page.getByText('Live', { exact: true })).toBeVisible();
    const next = await observer(page, new URL(page.url()).searchParams.get('room')!);
    try {
      const restored = Object.values(next.project().scenes['scene-1'].objects).find(object => object.kind === 'image')!.image!;
      expect(restored.src.split('/').at(-1)).toBe(original.src.split('/').at(-1));
      expect(restored.width).toBe(original.width); expect(restored.height).toBe(original.height);
      await expect(page.locator('.scene-svg image')).toHaveAttribute('href', /^data:image\/webp;base64,/);
    } finally { next.close(); }
  } finally { watch.close(); }
});

test('pasting an image into another project saves its own asset and fails without partial edits', async ({ page, browser }) => {
  const sourceRoom = await open(page); await upload(page);
  const clipboard = await page.locator('[data-testid="stage-main"]').evaluate(element => {
    const clipboardData = new DataTransfer(); element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData('text/plain');
  });
  expect(clipboard).toContain(sourceRoom);
  const context = await browser.newContext(), target = await context.newPage(), room = await open(target), watch = await observer(target, room);
  const paste = () => target.locator('[data-testid="stage-main"]').evaluate((element, text) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, clipboard);
  try {
    await target.route('**/api/rooms/*/images', route => route.fulfill({ status: 503, json: { error: '画像を保存できませんでした。' } }));
    await paste(); await expect(target.getByRole('status').filter({ hasText: '画像を保存できませんでした' })).toBeVisible();
    await expect(target.getByRole('button', { name: 'Together', exact: true })).toHaveCount(0);
    await target.unroute('**/api/rooms/*/images'); await paste();
    await expect(target.locator('.scene-svg image')).toHaveAttribute('href', /^data:image\/png;base64,/);
    await expect.poll(() => Object.values(watch.project().scenes['scene-1'].objects).filter(object => object.kind === 'image').length).toBe(1);
    const copied = Object.values(watch.project().scenes['scene-1'].objects).find(object => object.kind === 'image')!;
    expect(copied.image!.src).toContain(`/api/rooms/${room}/images/`); expect(JSON.stringify(copied)).not.toContain(sourceRoom);
    await target.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click(); await expect(target.locator('.scene-svg image')).toHaveCount(0);
    await expect(page.locator('.scene-svg image')).toHaveCount(1);
  } finally { watch.close(); await context.close(); }
});
