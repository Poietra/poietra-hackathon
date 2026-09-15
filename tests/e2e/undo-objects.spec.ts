import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { readProject } from '../../shared/document';
import { parseProjectFile } from '../../shared/project-file';

async function editor(browser: Browser, room: string) {
  const context = await browser.newContext({ viewport: { width: 1715, height: 1050 } });
  let offline = false; const sockets: WebSocketRoute[] = [];
  await context.routeWebSocket('**/sync/**', socket => {
    if (offline) socket.close(); else { sockets.push(socket); socket.connectToServer(); }
  });
  const page = await context.newPage(); await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return { context, page, async disconnect() {
    offline = true; for (const socket of sockets) socket.close(); await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }, async reconnect() {
    offline = false; await context.setOffline(false);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  } };
}
async function observer(page: Page, room: string) {
  const doc = new Y.Doc(), endpoint = new URL(page.url());
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  const close = () => { provider.destroy(); doc.destroy(); };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The test observer could not sync')), 10000);
      provider.on('sync', synced => { if (synced) { clearTimeout(timer); resolve(); } });
    });
  } catch (error) { close(); throw error; }
  return { project: () => readProject(doc)!, scene: () => readProject(doc)!.scenes['scene-1'], close };
}
const layer = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const undo = (page: Page) => layer(page, '元に戻す (⌘Z)').click();
const redo = (page: Page) => layer(page, 'やり直す (⌘⇧Z)').click();
const retainedNotice = '共同編集者が変更した 1 個の新規オブジェクトと、その状態・アニメーションを保持しました。';
async function number(page: Page, label: string, value: number) {
  const field = page.getByRole('spinbutton', { name: label, exact: true }); await field.fill(String(value)); await field.press('Tab');
}
async function fill(page: Page, hex: string) {
  const field = page.getByRole('textbox', { name: 'Fillのカラーコード', exact: true }); await field.fill(hex); await field.press('Enter');
}
async function createCircle(page: Page) {
  await layer(page, '円 (O)').click();
  const surface = page.locator('[data-testid="stage-main"]');
  await surface.click({ position: { x: 360, y: 120 } });
  await expect(layer(page, 'Circle 2')).toBeVisible();
}

test('creator Undo retains a new object after offline peer state edits, without skipping an earlier edit', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  const data = await observer(alice.page, room);
  try {
    await layer(alice.page, 'Circle').click(); await number(alice.page, 'Position X', 300);
    await createCircle(alice.page); await expect(layer(bob.page, 'Circle 2')).toBeVisible();
    await expect.poll(() => Object.values(data.scene().objects).find(object => object.name === 'Circle 2')?.id).toBeTruthy();
    const id = Object.values(data.scene().objects).find(object => object.name === 'Circle 2')!.id;
    await layer(bob.page, 'Circle 2').click();
    await Promise.all([alice.disconnect(), bob.disconnect()]);
    await fill(bob.page, 'FF0000');
    await bob.reconnect(); await alice.reconnect();
    await expect(alice.page.getByRole('textbox', { name: 'Fillのカラーコード', exact: true })).toHaveValue('FF0000');
    await fill(alice.page, '0000FF');
    await expect(bob.page.getByRole('textbox', { name: 'Fillのカラーコード', exact: true })).toHaveValue('0000FF');
    await undo(alice.page);
    await expect(bob.page.getByRole('textbox', { name: 'Fillのカラーコード', exact: true })).toHaveValue('FF0000');
    await undo(alice.page);
    await expect(alice.page.getByText(retainedNotice, { exact: true })).toBeVisible();
    for (const client of [alice, bob]) {
      await expect(layer(client.page, 'Circle 2')).toBeVisible();
      await expect(client.page.locator(`[data-testid="stage-main"] .scene-svg [data-object-id="${id}"]`)).toBeVisible();
    }
    await expect.poll(() => data.scene().compositions['comp-1'].states[id]?.fill).toBe('#FF0000');
    expect(data.scene().compositions['comp-2'].states[id]).toBeDefined();
    expect(data.scene().compositions['comp-1'].states.circle.x).toBe(300);
    expect(parseProjectFile(JSON.stringify(data.project()))).toEqual(data.project());
    await undo(alice.page); await expect.poll(() => data.scene().compositions['comp-1'].states.circle.x).toBe(245);
    await redo(alice.page); await expect.poll(() => data.scene().compositions['comp-1'].states.circle.x).toBe(300);
    expect(data.scene().compositions['comp-1'].states[id].fill).toBe('#FF0000');
  } finally { data.close(); await alice.context.close(); await bob.context.close(); }
});

test('untouched creation Undo/Redo stays normal; a later peer-created animation retains its object and all states', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  const data = await observer(alice.page, room);
  try {
    await createCircle(alice.page); await expect(layer(bob.page, 'Circle 2')).toBeVisible();
    await undo(alice.page); await expect(layer(bob.page, 'Circle 2')).toHaveCount(0);
    await expect.poll(() => Object.values(data.scene().objects).some(object => object.name === 'Circle 2')).toBe(false);
    await redo(alice.page); await expect(layer(bob.page, 'Circle 2')).toBeVisible();
    await expect.poll(() => Object.values(data.scene().objects).find(object => object.name === 'Circle 2')?.id).toBeTruthy();
    const id = Object.values(data.scene().objects).find(object => object.name === 'Circle 2')!.id;
    await layer(bob.page, 'Circle 2').click(); await layer(bob.page, 'Transition 800 ms').click();
    await number(bob.page, 'Animation duration', 350);
    await expect.poll(() => data.scene().transitions['transition-1'].tracks[id]?.duration).toBe(350);
    // Wait for Alice's actual UI to see this dependency before undoing its creation.
    await layer(alice.page, 'Transition 800 ms').click();
    await expect(layer(alice.page, 'Circle 2 Move: 0–350 ms')).toBeVisible();
    await undo(alice.page);
    await expect(alice.page.getByText(retainedNotice, { exact: true })).toBeVisible();
    for (const client of [alice, bob]) await expect(layer(client.page, 'Circle 2 Move: 0–350 ms')).toBeVisible();
    await expect(layer(alice.page, 'やり直す (⌘⇧Z)')).toBeDisabled();
    expect(data.scene().objects[id]).toBeDefined();
    for (const composition of Object.values(data.scene().compositions)) expect(composition.states[id]).toBeDefined();
    expect(parseProjectFile(JSON.stringify(data.project()))).toEqual(data.project());
    await layer(alice.page, 'Composition 1').click();
    await expect(alice.page.locator(`[data-testid="stage-main"] .scene-svg [data-object-id="${id}"]`)).toBeVisible();
    await bob.page.reload(); await expect(bob.page.getByText('Live', { exact: true })).toBeVisible();
    await expect(layer(bob.page, 'Circle 2')).toBeVisible();
    await expect(bob.page.locator(`[data-testid="stage-main"] .scene-svg [data-object-id="${id}"]`)).toBeVisible();
  } finally { data.close(); await alice.context.close(); await bob.context.close(); }
});

test('Redo of a shorter Transition keeps a later peer animation within the timeline', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  const data = await observer(alice.page, room);
  try {
    await layer(alice.page, 'Transition 800 ms').click();
    await number(alice.page, 'Transition duration', 2000);
    await number(alice.page, 'Transition duration', 800);
    await undo(alice.page);
    await expect(alice.page.getByRole('spinbutton', { name: 'Transition duration', exact: true })).toHaveValue('2000');
    await layer(bob.page, 'Transition 2,000 ms').click(); await layer(bob.page, 'Circle').click();
    await number(bob.page, 'Animation duration', 1800);
    await layer(alice.page, 'Circle').click();
    await expect(alice.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('1800');
    await redo(alice.page);
    await expect(alice.page.getByText('共同編集者のアニメーションが収まるように、Transition の長さを保持しました。', { exact: true })).toBeVisible();
    for (const client of [alice, bob]) {
      await expect(client.page.getByRole('spinbutton', { name: 'Transition duration', exact: true })).toHaveValue('2000');
      await expect(layer(client.page, 'Circle Move: 0–1,800 ms')).toBeVisible();
    }
    await expect.poll(() => data.scene().transitions['transition-1'].tracks.circle.duration).toBe(1800);
    expect(data.scene().transitions['transition-1'].duration).toBe(2000);
    expect(parseProjectFile(JSON.stringify(data.project()))).toEqual(data.project());
    await bob.page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('900');
    await expect(bob.page.locator('[data-testid="stage-to"] .scene-svg [data-object-id="circle"]')).toBeVisible();
  } finally { data.close(); await alice.context.close(); await bob.context.close(); }
});

test('Redo refuses a deleted long track after a peer shortens the Transition and preserves the pending history', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  const data = await observer(alice.page, room);
  try {
    await layer(alice.page, 'Transition 800 ms').click(); await number(alice.page, 'Transition duration', 2000);
    await layer(alice.page, 'Sigmoid path').click(); await layer(alice.page, 'Add animation').click();
    await expect(layer(alice.page, 'Sigmoid path Move: 0–2,000 ms')).toBeVisible();
    await undo(alice.page); await expect(layer(alice.page, 'Add animation')).toBeVisible();
    await layer(bob.page, 'Transition 2,000 ms').click(); await number(bob.page, 'Transition duration', 600);
    await expect(alice.page.getByRole('spinbutton', { name: 'Transition duration', exact: true })).toHaveValue('600');
    await expect.poll(() => data.scene().transitions['transition-1'].duration).toBe(600);
    const before = structuredClone(data.project());
    await redo(alice.page);
    await expect(alice.page.getByText('共同編集者が Transition を短くしたため、このアニメーションをやり直せません。現在の長さに合わせて改めて編集してください。', { exact: true })).toBeVisible();
    await expect(layer(alice.page, 'やり直す (⌘⇧Z)')).toBeEnabled();
    await expect(layer(alice.page, 'Add animation')).toBeVisible();
    expect(data.project()).toEqual(before); expect(parseProjectFile(JSON.stringify(before))).toEqual(before);
    // A peer can make the still-pending Redo valid again without a new local edit.
    await number(bob.page, 'Transition duration', 2500);
    await expect(alice.page.getByRole('spinbutton', { name: 'Transition duration', exact: true })).toHaveValue('2500');
    await redo(alice.page);
    await expect(layer(alice.page, 'Sigmoid path Move: 0–2,000 ms')).toBeVisible();
    await expect.poll(() => data.scene().transitions['transition-1'].tracks.sigmoid?.duration).toBe(2000);
    expect(data.scene().transitions['transition-1'].duration).toBe(2500);
    expect(parseProjectFile(JSON.stringify(data.project()))).toEqual(data.project());
  } finally { data.close(); await alice.context.close(); await bob.context.close(); }
});
