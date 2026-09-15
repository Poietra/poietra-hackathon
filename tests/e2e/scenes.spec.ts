import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { parseProjectFile } from '../../shared/project-file';

async function open(page: Page, room: string) {
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Scene 1', exact: true })).toBeVisible();
}
async function action(page: Page, name: string, action: 'Rename' | 'Duplicate' | 'Delete') {
  await page.getByRole('button', { name: `${name} のシーン操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function rename(page: Page, name: string, value: string) {
  await action(page, name, 'Rename');
  await page.getByRole('textbox', { name: 'Scene name', exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
}
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Scenes', exact: true }).getByRole('tab');
async function offlineEditor(browser: Browser, room: string) {
  const context = await browser.newContext(); let offline = false;
  const sockets: WebSocketRoute[] = [];
  await context.routeWebSocket('**/sync/**', socket => {
    if (offline) socket.close(); else { sockets.push(socket); socket.connectToServer(); }
  });
  const page = await context.newPage(); await open(page, room);
  return { context, page, async disconnect() {
    offline = true; for (const socket of sockets) socket.close(); await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }, async reconnect() {
    offline = false; await context.setOffline(false); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  } };
}

test('Scene rename and independent duplication synchronize and survive a saved project roundtrip', async ({ browser }) => {
  const first = await browser.newContext(), second = await browser.newContext();
  const alice = await first.newPage(), bob = await second.newPage(), room = crypto.randomUUID();
  try {
    await Promise.all([open(alice, room), open(bob, room)]);
    await rename(alice, 'Scene 1', 'Motion study');
    await expect(bob.getByRole('tab', { name: 'Motion study', exact: true })).toBeVisible();
    await action(alice, 'Motion study', 'Duplicate');
    await expect(alice.getByRole('tab', { name: 'Motion study copy', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(bob)).toHaveCount(2);
    await alice.getByRole('button', { name: 'Circle', exact: true }).click();
    const x = alice.getByRole('spinbutton', { name: 'Position X', exact: true }); await x.fill('450'); await x.press('Tab');
    await bob.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await bob.getByRole('tab', { name: 'Motion study copy', exact: true }).click();
    await bob.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('450');
    await bob.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Circle Move: 0–600 ms', exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
    const downloading = alice.waitForEvent('download'); await alice.getByRole('button', { name: 'Save project', exact: true }).click();
    const text = await readFile((await (await downloading).path())!, 'utf8');
    const saved = parseProjectFile(text); expect(saved.sceneOrder).toHaveLength(2);
    const [source, copy] = saved.sceneOrder.map(id => saved.scenes[id]);
    expect(Object.keys(copy.objects).some(id => !!source.objects[id])).toBe(false);
    expect(copy.compositionOrder.some(id => source.compositionOrder.includes(id))).toBe(false);
    await alice.getByLabel('プロジェクトファイル', { exact: true }).setInputFiles({ name: 'scenes.poietra.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(alice).not.toHaveURL(new RegExp(room)); await expect(tabs(alice)).toHaveCount(2);
    await alice.getByRole('tab', { name: 'Motion study copy', exact: true }).click(); await alice.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('450');
    await expect(bob).toHaveURL(new RegExp(room));
  } finally { await first.close(); await second.close(); }
});

test('deleting a Scene is undoable without losing an offline collaborator’s edits', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await offlineEditor(browser, room), bob = await offlineEditor(browser, room);
  try {
    await alice.page.getByRole('button', { name: 'Scene を追加', exact: true }).click(); await expect(tabs(bob.page)).toHaveCount(2);
    await bob.disconnect();
    await action(alice.page, 'Scene 1', 'Delete'); await expect(tabs(alice.page)).toHaveCount(1);
    await rename(bob.page, 'Scene 1', 'Peer motion');
    await bob.page.getByRole('button', { name: 'Circle', exact: true }).click();
    const x = bob.page.getByRole('spinbutton', { name: 'Position X', exact: true }); await x.fill('333'); await x.press('Tab');
    await bob.reconnect(); await expect(tabs(bob.page)).toHaveCount(1);
    await alice.page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    for (const { page } of [alice, bob]) {
      await expect(page.getByRole('tab', { name: 'Peer motion', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'Peer motion', exact: true }).click();
      await page.getByRole('button', { name: 'Circle', exact: true }).click();
      await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('333');
    }
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('opposite offline Scene deletions retain one editable Scene and adding to it survives reload', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await offlineEditor(browser, room), bob = await offlineEditor(browser, room);
  try {
    await alice.page.getByRole('button', { name: 'Scene を追加', exact: true }).click(); await expect(tabs(bob.page)).toHaveCount(2);
    await Promise.all([alice.disconnect(), bob.disconnect()]);
    await Promise.all([action(alice.page, 'Scene 1', 'Delete'), action(bob.page, 'Scene 2', 'Delete')]);
    await Promise.all([alice.reconnect(), bob.reconnect()]);
    for (const { page } of [alice, bob]) {
      await expect(tabs(page)).toHaveCount(1); await expect(page.getByRole('tab', { name: 'Scene 1', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Scene 1 のシーン操作', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveAttribute('aria-disabled', 'true');
      await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Scene 1 のシーン操作', exact: true })).toBeFocused();
    }
    await alice.page.getByRole('button', { name: 'Scene を追加', exact: true }).click(); await expect(tabs(bob.page)).toHaveCount(2);
    await bob.page.reload(); await expect(bob.page.getByText('Live', { exact: true })).toBeVisible();
    await expect(tabs(bob.page)).toHaveCount(2); await expect(bob.page.getByRole('tab', { name: 'Scene 1', exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(tabs(bob.page)).toHaveCount(1); await bob.page.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(bob.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  } finally { await alice.context.close(); await bob.context.close(); }
});
