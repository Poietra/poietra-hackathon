import { expect, test, type Locator, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { applyChanges } from '../../shared/document';

async function open(page: Page, room = crypto.randomUUID()) {
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
}
async function transition(page: Page) { await page.getByRole('button', { name: /^Transition [\d,]+ ms$/ }).click(); }
const bar = (page: Page) => page.locator('.animation-bar').filter({ has: page.locator('.bar-name', { hasText: 'Move' }) }).first();
async function field(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab');
}
async function center(locator: Locator) { const box = await locator.boundingBox(); expect(box).not.toBeNull(); return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }; }
async function startDrag(page: Page, milliseconds = 100) {
  const target = bar(page); const at = await center(target); const lane = await target.locator('..').boundingBox();
  await page.mouse.move(at.x, at.y); await page.mouse.down();
  await page.mouse.move(at.x + lane!.width * milliseconds / 800, at.y, { steps: 4 });
  return { at, width: lane!.width };
}

test('a long track drag is one undo action while another browser edits appearance', async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext();
  const alice = await a.newPage(); const bob = await b.newPage(); const room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]); await transition(alice);
  const { at, width } = await startDrag(alice, 80);
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('80');
  // Crossing captureTimeout reproduces the old split-undo regression.
  await alice.waitForTimeout(550);
  await bob.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
  await alice.mouse.move(at.x + width * 160 / 800, at.y, { steps: 4 }); await alice.mouse.up();
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('160');
  await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
  await expect(bob.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await a.close(); await b.close();
});

for (const reason of ['Escape', 'pointercancel', 'lostpointercapture', 'unmount'] as const) {
  test(`${reason} cancels only the current timing gesture and preserves earlier undo history`, async ({ page }) => {
    await open(page); await transition(page); await field(page, 'Animation duration', 500);
    await startDrag(page, 100);
    await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('100');
    if (reason === 'Escape') await page.keyboard.press('Escape');
    else if (reason === 'pointercancel') await bar(page).dispatchEvent('pointercancel', { pointerId: 1 });
    else if (reason === 'lostpointercapture') await bar(page).evaluate(element => element.releasePointerCapture(1));
    else await page.getByRole('button', { name: 'Composition 1', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await page.mouse.up();
    if (reason === 'unmount') await transition(page);
    await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
    await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('500');
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('600');
    await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
    await startDrag(page, 100); await page.mouse.up();
    await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('100');
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
  });
}

test('trimming can reach zero duration and cannot extend beyond the transition', async ({ page }) => {
  await open(page); await transition(page); await field(page, 'Animation duration', 100);
  const edge = bar(page).locator('[data-edge="end"]'); const at = await center(edge); const lane = await bar(page).locator('..').boundingBox();
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x - lane!.width / 2, at.y, { steps: 4 }); await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('0');
  const zeroEdge = await center(edge);
  await page.mouse.move(zeroEdge.x, zeroEdge.y); await page.mouse.down(); await page.mouse.move(zeroEdge.x + lane!.width * 2, zeroEdge.y, { steps: 4 }); await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('800');
  await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
});

test('locked tracks remain selectable and cannot be moved directly', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: 'ロック', exact: true }).click(); await transition(page);
  await expect(bar(page)).toHaveAttribute('aria-disabled', 'true');
  await startDrag(page, 100); await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
  await expect(bar(page)).toHaveAttribute('aria-label', 'Circle Move: 0–600 ms');
});

test('a zero-duration scene renders finite timing positions without changing data on drag', async ({ page }) => {
  const room = crypto.randomUUID(); await open(page, room);
  const socket = new URL(page.url()); socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:'; socket.pathname = '/sync'; socket.search = '';
  const doc = new Y.Doc(); const provider = new WebsocketProvider(socket.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  try {
    await new Promise<void>(resolve => provider.on('sync', (synced: boolean) => { if (synced) resolve(); }));
    applyChanges(doc, [
      { path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'duration'], value: 0 },
      { path: ['scenes', 'scene-1', 'compositions', 'comp-2', 'duration'], value: 0 },
      { path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'duration'], value: 0 },
      ...['circle', 'equation'].flatMap(id => ['start', 'duration'].map(property => ({ path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', id, property], value: 0 }))),
    ]);
    await expect(page.getByRole('button', { name: 'Transition 0 ms', exact: true })).toBeVisible(); await transition(page);
    await expect(bar(page)).toHaveAttribute('aria-disabled', 'true');
    const lane = await bar(page).locator('..').boundingBox(); const button = await bar(page).boundingBox();
    expect(button!.x).toBeCloseTo(lane!.x, 1); expect(button!.width).toBeGreaterThan(0);
    await startDrag(page, 100); await page.mouse.up();
    await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('0');
    await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
    expect(await page.locator('.track-playhead').evaluate(element => getComputedStyle(element).left)).toMatch(/^\d+(\.\d+)?px$/);
    await page.getByRole('button', { name: 'Composition 1', exact: true }).click();
    for (const style of await page.locator('.scene-ruler > span').evaluateAll(elements => elements.map(element => element.getAttribute('style')))) expect(style ?? '').not.toMatch(/NaN|Infinity/);
    await expect(page.getByRole('slider', { name: '再生位置', exact: true })).toHaveValue('0');
  } finally { provider.destroy(); doc.destroy(); }
});

test('the playhead stays visible and aligned with its track lane at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 }); await open(page); await transition(page);
  const lane = await bar(page).locator('..').boundingBox();
  const playhead = page.locator('.track-playhead'); await expect(playhead).toBeVisible();
  expect((await playhead.boundingBox())!.x).toBeCloseTo(lane!.x, 1);
  await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('400');
  expect((await playhead.boundingBox())!.x).toBeCloseTo(lane!.x + lane!.width / 2, 1);
});


test('a peer changing the same track during a drag keeps their timing', async ({ browser }) => {
  const a = await browser.newContext(); const b = await browser.newContext();
  const alice = await a.newPage(); const bob = await b.newPage(); const room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]); await Promise.all([transition(alice), transition(bob)]);
  const { at, width } = await startDrag(alice, 80);
  await expect(bob.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('80');
  await field(bob, 'Animation start', 120);
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('120');
  await alice.mouse.move(at.x + width * 160 / 800, at.y, { steps: 4 }); await alice.mouse.up();
  await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('120');
  await expect(bob.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('120');
  await expect(alice.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('600');
  await a.close(); await b.close();
});
