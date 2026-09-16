import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { readProject } from '../../shared/document';
import { defaultTrack } from '../../shared/model';
import { parseProjectFile } from '../../shared/project-file';

async function editor(browser: Browser, room: string) {
  const context = await browser.newContext({ viewport: { width: 1715, height: 1050 } });
  let offline = false; const sockets: WebSocketRoute[] = [];
  await context.routeWebSocket('**/sync/**', socket => {
    if (offline) socket.close(); else { sockets.push(socket); socket.connectToServer(); }
  });
  const page = await context.newPage(); await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return { context, page, async offline() {
    offline = true; for (const socket of sockets) socket.close(); await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }, async online() {
    offline = false; await context.setOffline(false);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  } };
}
async function observer(page: Page, room: string) {
  const doc = new Y.Doc(), endpoint = new URL(page.url());
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', synced => { if (synced) resolve(); }));
  return {
    project: () => readProject(doc)!,
    tracks: () => readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks,
    close: () => { provider.destroy(); doc.destroy(); },
  };
}
async function field(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab');
}
const undo = (page: Page) => page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
const redo = (page: Page) => page.getByRole('button', { name: 'やり直す (⌘⇧Z)', exact: true }).click();
const retainedNotice = '共同編集者が変更した 1 個の新規アニメーションを保持しました。';

test('a group-created track survives peer offline edits and creator Undo while other batch fields Undo normally', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  const data = await observer(alice.page, room);
  try {
    await alice.page.getByRole('button', { name: 'Circle', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Sigmoid path', exact: true }).click({ modifiers: ['Shift'] });
    await alice.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await field(alice.page, 'Selected animation duration', 400);
    await bob.page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
    await bob.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await expect(bob.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('400');
    await Promise.all([alice.offline(), bob.offline()]);
    await bob.page.getByRole('combobox', { name: 'Easing', exact: true }).selectOption('easeOut');
    await bob.online(); await alice.online();
    await expect(alice.page.getByRole('combobox', { name: 'Selected animation easing', exact: true })).toHaveValue('');
    // Undoing an overwrite recreates the peer's value under Alice's Yjs client ID.
    // Shared ownership must survive this ordinary field Undo.
    await alice.page.getByRole('combobox', { name: 'Selected animation easing', exact: true }).selectOption('linear');
    await expect(bob.page.getByRole('combobox', { name: 'Easing', exact: true })).toHaveValue('linear');
    await undo(alice.page);
    await expect(bob.page.getByRole('combobox', { name: 'Easing', exact: true })).toHaveValue('easeOut');
    await undo(alice.page);
    await expect.poll(() => data.tracks().circle.duration).toBe(600);
    await expect.poll(() => data.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut', implicit: false }));
    await expect(alice.page.getByText(retainedNotice, { exact: true })).toBeVisible();
    for (const client of [alice, bob]) await expect(client.page.getByRole('button', { name: 'Sigmoid path Move: 0–400 ms', exact: true })).toBeVisible();
    await expect(bob.page.getByRole('combobox', { name: 'Easing', exact: true })).toHaveValue('easeOut');
    await expect(bob.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('400');
    expect(parseProjectFile(JSON.stringify(data.project()))).toEqual(data.project());
    await redo(alice.page); await expect.poll(() => data.tracks().circle.duration).toBe(400);
    expect(data.tracks().sigmoid.easing).toBe('easeOut');
    await undo(alice.page); await expect.poll(() => data.tracks().circle.duration).toBe(600);
    expect(data.tracks().sigmoid.easing).toBe('easeOut');
    await bob.page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('200');
    await expect(bob.page.locator('[data-testid="stage-to"] .scene-svg [data-object-id="sigmoid"]')).toBeVisible();
  } finally { data.close(); await alice.context.close(); await bob.context.close(); }
});

test('single-track creation Undo removes untouched data and retains peer-edited Redo data without undoing the previous action', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  const data = await observer(alice.page, room);
  try {
    await alice.page.getByRole('button', { name: 'Circle', exact: true }).click();
    await field(alice.page, 'Position X', 300);
    await alice.page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
    await alice.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await field(alice.page, 'Animation duration', 400); // Activate the automatic track with explicit timing.
    await expect.poll(() => data.tracks().sigmoid?.duration).toBe(400);
    await undo(alice.page);
    await expect(alice.page.getByRole('button', { name: 'Add animation', exact: true })).toBeVisible();
    await expect.poll(() => data.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { implicit: true }));
    await redo(alice.page);
    await bob.page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
    await bob.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await expect(bob.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('400');
    await bob.page.getByRole('combobox', { name: 'Easing', exact: true }).selectOption('easeOut');
    await expect(alice.page.getByRole('combobox', { name: 'Easing', exact: true })).toHaveValue('easeOut');
    await undo(alice.page);
    await expect.poll(() => data.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut', implicit: false }));
    await expect(alice.page.getByText(retainedNotice, { exact: true })).toBeVisible();
    expect(data.project().scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(300);
    await expect(alice.page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true })).toBeEnabled();
    await alice.page.keyboard.press('Control+Shift+z');
    await expect(alice.page.getByRole('button', { name: 'Sigmoid path Move: 0–400 ms', exact: true })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'やり直す (⌘⇧Z)', exact: true })).toBeDisabled();
    expect(data.project().scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(300);
    await undo(alice.page);
    await expect.poll(() => data.project().scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(245);
    await redo(alice.page);
    await expect.poll(() => data.project().scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(300);
    expect(data.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut', implicit: false }));
    expect(parseProjectFile(JSON.stringify(data.project()))).toEqual(data.project());
    await expect(bob.page.getByRole('button', { name: 'Sigmoid path Move: 0–400 ms', exact: true })).toBeVisible();
  } finally { data.close(); await alice.context.close(); await bob.context.close(); }
});
