import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { readProject } from '../../shared/document';
import { parseProjectFile } from '../../shared/project-file';

async function editor(browser: Browser, room: string, clientID: number) {
  const context = await browser.newContext({ viewport: { width: 1715, height: 1050 } });
  // Make the previous stale-write conflict deterministic: Bob's Yjs Item wins.
  // Room IDs still use native randomUUID; edits use only the actual public UI.
  await context.addInitScript(id => {
    const random = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = (<T extends ArrayBufferView<ArrayBuffer>>(array: T): T => {
      if (array instanceof Uint32Array && array.length === 1) { array[0] = id; return array; }
      return random(array) as T;
    });
  }, clientID);
  let offline = false; const sockets: WebSocketRoute[] = [];
  await context.routeWebSocket('**/sync/**', socket => {
    if (offline) socket.close(); else { sockets.push(socket); socket.connectToServer(); }
  });
  const page = await context.newPage(); await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
  return { context, page, async offline() {
    offline = true; for (const socket of sockets) socket.close(); await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }, async online() {
    offline = false; await context.setOffline(false);
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
  } };
}
async function field(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true }); await input.fill(String(value)); await input.press('Tab');
}
const undo = (page: Page) => page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();

test('independent timing and object edits survive offline merge, local Undo, and reload', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room, 100), bob = await editor(browser, room, 200);
  const doc = new Y.Doc(), endpoint = new URL(alice.page.url());
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const observer = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  const scene = () => readProject(doc)?.scenes['scene-1'];
  try {
    await expect.poll(() => !!scene(), { timeout: 15000 }).toBe(true);
    await alice.page.getByRole('button', { name: 'Circle', exact: true }).click();
    for (const client of [alice, bob]) await client.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await Promise.all([alice.offline(), bob.offline()]);
    await field(alice.page, 'Animation duration', 700);
    await field(bob.page, 'Transition duration', 1000);
    await bob.online(); await alice.online();
    await expect(alice.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('700');
    await expect(alice.page.getByRole('spinbutton', { name: 'Transition duration', exact: true })).toHaveValue('1000');
    await bob.page.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(bob.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('700');
    await undo(bob.page);
    await expect(alice.page.getByRole('spinbutton', { name: 'Transition duration', exact: true })).toHaveValue('800');
    await expect(alice.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('700');

    for (const client of [alice, bob]) await client.page.getByRole('button', { name: 'Composition 1 1,000 ms', exact: true }).click();
    await bob.page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
    await Promise.all([alice.offline(), bob.offline()]);
    await field(alice.page, 'Position X', 365); await field(bob.page, 'Position Y', 470);
    await alice.online(); await bob.online();
    await expect.poll(() => [scene()?.compositions['comp-1'].states.circle.x, scene()?.compositions['comp-1'].states.sigmoid.y], { timeout: 15000 }).toEqual([365, 470]);
    await undo(bob.page);
    await expect.poll(() => [scene()?.compositions['comp-1'].states.circle.x, scene()?.compositions['comp-1'].states.sigmoid.y], { timeout: 15000 }).toEqual([365, 520]);
    await expect(alice.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('365');
    expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
    for (const client of [alice, bob]) {
      await client.page.reload(); await expect(client.page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
      await client.page.getByRole('button', { name: 'Circle', exact: true }).click();
      await expect(client.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('365');
      await client.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
      await expect(client.page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('700');
    }
  } finally { observer.destroy(); doc.destroy(); await alice.context.close(); await bob.context.close(); }
});
