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
const bar = (page: Page) => page.locator('[data-track-object-id="circle"] .animation-bar');
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

const previewPosition = (page: Page) => page.getByRole('slider', { name: 'Transition preview position', exact: true });
const seekHandle = (page: Page) => page.locator('.track-seek-thumb');
async function expectSeek(page: Page, value: number) {
  await expect(previewPosition(page)).toHaveValue(String(value));
  await expect(page.getByRole('slider', { name: 'Transition の再生ヘッド', exact: true })).toHaveValue(String(value));
  await expect(page.locator('.preview-transport')).toContainText(`${value.toLocaleString('en-US')} / 800 ms`);
  await expect(page.locator('.time-code strong')).toHaveText((1000 + value).toLocaleString('en-US'));
  const lane = await page.locator('.track-lane').first().boundingBox();
  expect((await page.locator('.track-playhead').boundingBox())!.x).toBeCloseTo(lane!.x + lane!.width * value / 800, 0);
}

test('the bottom ruler and wide playhead drag pause playback, hold the frame, and leave shared edits unchanged', async ({ browser }) => {
  const context = await browser.newContext(), other = await browser.newContext();
  const alice = await context.newPage(), bob = await other.newPage(), room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]); await transition(alice);
  const socket = new URL(alice.url()); socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:'; socket.pathname = '/sync'; socket.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(socket.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  try {
    await new Promise<void>(resolve => provider.on('sync', synced => { if (synced) resolve(); }));
    const before = doc.getMap('project').toJSON();
    const ruler = await alice.locator('.track-seek-control').boundingBox();
    await alice.getByRole('button', { name: 'Transition をプレビュー', exact: true }).click();
    await alice.mouse.click(ruler!.x + ruler!.width / 2, ruler!.y + 3);
    await expectSeek(alice, 400);
    await expect(alice.getByRole('button', { name: 'Transition をプレビュー', exact: true })).toBeVisible();
    const handle = await seekHandle(alice).boundingBox();
    expect(handle!.width).toBeGreaterThanOrEqual(28);
    // Grab away from the fine center line to exercise the wider hit target.
    const offset = 8, y = handle!.y + handle!.height - 5;
    await alice.mouse.move(handle!.x + handle!.width / 2 + offset, y); await alice.mouse.down();
    await alice.mouse.move(ruler!.x + ruler!.width + 70, y, { steps: 4 });
    await expectSeek(alice, 800);
    await expect(alice.locator('[data-testid="stage-to"] [data-object-id="circle"]')).toHaveAttribute('transform', 'translate(955 190) rotate(0)');
    await alice.mouse.move(ruler!.x - 40, y, { steps: 4 });
    await expectSeek(alice, 0);
    await expect(alice.locator('[data-testid="stage-to"] [data-object-id="circle"]')).toHaveAttribute('transform', 'translate(245 520) rotate(0)');
    await alice.mouse.move(ruler!.x + ruler!.width * 3 / 8 + offset, y, { steps: 4 }); await alice.mouse.up();
    await expectSeek(alice, 300);
    await expect(alice.locator('[data-testid="stage-to"] [data-object-id="circle"]')).toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
    await alice.waitForTimeout(180); await expectSeek(alice, 300);
    await expect(alice.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
    await expect(alice.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('600');
    expect(doc.getMap('project').toJSON()).toEqual(before);
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await expect(bob.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('520');
  } finally { provider.destroy(); doc.destroy(); await context.close(); await other.close(); }
});

test('bottom seeking follows the visible ruler after scrolling at a narrow width and supports keyboard boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 }); await open(page);
  await page.locator('.composition-list').getByRole('button', { name: 'Composition を追加', exact: true }).click();
  await page.locator('.composition-list').getByRole('button', { name: 'Composition を追加', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).first().click();
  await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
  await page.getByRole('combobox', { name: 'Animation type', exact: true }).selectOption('fade');
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  // The composition strip can scroll independently from the time ruler.
  const strip = page.locator('.composition-strip');
  await strip.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  expect(await strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  const tracks = page.locator('.transition-tracks');
  await page.locator('.track-lane').first().hover(); await page.mouse.wheel(0, 15);
  await expect.poll(() => tracks.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const ruler = await page.locator('.track-seek-control').boundingBox();
  await page.mouse.click(ruler!.x + ruler!.width * 0.75, ruler!.y + 3);
  await expectSeek(page, 600);
  const handle = await seekHandle(page).boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height - 5); await page.mouse.down();
  await page.mouse.move(ruler!.x + ruler!.width / 4, handle!.y + handle!.height - 5, { steps: 4 }); await page.mouse.up();
  await expectSeek(page, 200);
  const slider = page.getByRole('slider', { name: 'Transition の再生ヘッド', exact: true });
  await slider.focus(); await slider.press('End'); await expectSeek(page, 800);
  await slider.press('ArrowRight'); await expectSeek(page, 800);
  await slider.press('Home'); await expectSeek(page, 0);
  await slider.press('ArrowLeft'); await expectSeek(page, 0);
  await slider.press('ArrowRight'); await expectSeek(page, 1);
  await slider.press('Shift+ArrowRight'); await expectSeek(page, 101);
  await expect(slider).toHaveAttribute('aria-valuetext', '101 / 800 ms');
  await expect(page.getByRole('spinbutton', { name: 'Animation start', exact: true })).toHaveValue('0');
  await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('600');
  // Undo removes the last track addition, rather than any of the seek steps.
  await page.keyboard.press('Tab'); await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: /^Sigmoid path Fade:/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Composition 4', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Composition 3', exact: true })).toBeVisible();
});
