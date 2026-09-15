import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { parseProjectFile } from '../../shared/project-file';

async function open(page: Page, room: string) {
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
}
async function action(page: Page, name: string, action: 'Duplicate' | 'Delete') {
  await page.getByRole('button', { name: `${name} の操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
const compositions = (page: Page) => page.locator('.composition-list [data-composition-id]');
async function offlineEditor(browser: Browser, room: string) {
  const context = await browser.newContext();
  let offline = false;
  const sockets: WebSocketRoute[] = [];
  await context.routeWebSocket('**/sync/**', socket => {
    if (offline) socket.close();
    else { sockets.push(socket); socket.connectToServer(); }
  });
  const page = await context.newPage(); await open(page, room);
  return { context, page, async disconnect() {
    offline = true;
    for (const socket of sockets) socket.close();
    await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }, async reconnect() {
    offline = false; await context.setOffline(false);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  } };
}

test('a duplicated composition keeps independent states and its outgoing transition; deleting it is undoable across browsers', async ({ browser }) => {
  const first = await browser.newContext(); const second = await browser.newContext();
  const alice = await first.newPage(); const bob = await second.newPage();
  const room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]);
  await action(alice, 'Composition 1', 'Duplicate');
  await expect(compositions(bob)).toHaveCount(3);
  await expect(alice.getByRole('button', { name: 'Composition 1 copy', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await alice.getByRole('button', { name: 'Circle', exact: true }).click();
  const x = alice.getByRole('spinbutton', { name: 'Position X', exact: true });
  await x.fill('450'); await x.press('Tab');
  await bob.getByRole('button', { name: 'Circle', exact: true }).click();
  await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  await bob.getByRole('button', { name: 'Composition 1 copy', exact: true }).click();
  await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('450');
  await bob.getByRole('button', { name: 'Transition 800 ms', exact: true }).last().click();
  await expect(bob.getByRole('button', { name: 'Circle Move: 0–600 ms', exact: true })).toBeVisible();
  await action(alice, 'Composition 1 copy', 'Delete');
  await expect(compositions(bob)).toHaveCount(2);
  await expect(bob.getByRole('button', { name: 'Transition 800 ms', exact: true })).toHaveCount(1);
  await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(compositions(bob)).toHaveCount(3);
  await bob.getByRole('button', { name: 'Composition 1 copy', exact: true }).click();
  await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('450');
  await bob.getByRole('button', { name: 'Transition 800 ms', exact: true }).last().click();
  await expect(bob.getByRole('button', { name: 'Circle Move: 0–600 ms', exact: true })).toBeVisible();
  await first.close(); await second.close();
});

test('the composition menu supports the keyboard and disables deleting the last state', async ({ page }) => {
  await open(page, crypto.randomUUID());
  const menu = page.getByRole('button', { name: 'Composition 2 の操作', exact: true });
  await menu.focus(); await menu.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(compositions(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Composition 1 の操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Composition 1 の操作', exact: true })).toBeFocused();
});

test('opposite offline deletions converge to one retained composition and adding to it survives reload', async ({ browser }) => {
  const room = crypto.randomUUID();
  const alice = await offlineEditor(browser, room), bob = await offlineEditor(browser, room);
  try {
    await Promise.all([alice.disconnect(), bob.disconnect()]);
    await Promise.all([action(alice.page, 'Composition 1', 'Delete'), action(bob.page, 'Composition 2', 'Delete')]);
    await expect(alice.page.getByRole('button', { name: 'Composition 2', exact: true })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Composition 1', exact: true })).toBeVisible();
    await Promise.all([alice.reconnect(), bob.reconnect()]);
    for (const { page } of [alice, bob]) {
      await expect(compositions(page)).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Composition 1', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Circle', exact: true }).click();
      await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    }
    // Exercise the existing store.addComposition path on raw deleted=true fallback.
    await alice.page.locator('.composition-list').getByRole('button', { name: 'Composition を追加', exact: true }).click();
    await expect(compositions(bob.page)).toHaveCount(2);
    await expect(bob.page.getByRole('button', { name: 'Composition 1', exact: true })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Transition 800 ms', exact: true })).toHaveCount(1);
    await bob.page.reload(); await expect(bob.page.getByText('Live', { exact: true })).toBeVisible();
    await expect(compositions(bob.page)).toHaveCount(2);
    await alice.page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(compositions(bob.page)).toHaveCount(1);
    await expect(bob.page.getByRole('button', { name: 'Composition 1', exact: true })).toBeVisible();
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('concurrent offline duplicates produce the same editable timeline and a valid saved project', async ({ browser }) => {
  const room = crypto.randomUUID();
  const alice = await offlineEditor(browser, room), bob = await offlineEditor(browser, room);
  try {
    await Promise.all([alice.disconnect(), bob.disconnect()]);
    await Promise.all([action(alice.page, 'Composition 1', 'Duplicate'), action(bob.page, 'Composition 1', 'Duplicate')]);
    await Promise.all([alice.reconnect(), bob.reconnect()]);
    for (const { page } of [alice, bob]) {
      await expect(compositions(page)).toHaveCount(4);
      await expect(page.getByRole('button', { name: 'Transition 800 ms', exact: true })).toHaveCount(3);
    }
    const ids = await compositions(alice.page).evaluateAll(rows => rows.map(row => row.getAttribute('data-composition-id')));
    await expect.poll(() => compositions(bob.page).evaluateAll(rows => rows.map(row => row.getAttribute('data-composition-id')))).toEqual(ids);
    await bob.page.getByRole('button', { name: 'Transition 800 ms', exact: true }).last().click();
    await expect(bob.page.getByRole('button', { name: 'Circle Move: 0–600 ms', exact: true })).toBeVisible();
    await alice.page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
    const downloadPromise = alice.page.waitForEvent('download');
    await alice.page.getByRole('button', { name: 'Save project', exact: true }).click();
    const file = await downloadPromise;
    const text = await readFile((await file.path())!, 'utf8');
    const saved = parseProjectFile(text).scenes['scene-1'];
    expect(saved.compositionOrder).toEqual(ids);
    expect(Object.keys(saved.transitions)).toHaveLength(3);
    expect(text).not.toContain('incomingTransitionId');
    await alice.page.getByLabel('プロジェクトファイル', { exact: true }).setInputFiles({ name: 'concurrent.poietra.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(alice.page).not.toHaveURL(new RegExp(room));
    await expect(compositions(alice.page)).toHaveCount(4);
    await expect(alice.page.getByRole('button', { name: 'Transition 800 ms', exact: true })).toHaveCount(3);
    await expect(bob.page).toHaveURL(new RegExp(room));
  } finally { await alice.context.close(); await bob.context.close(); }
});
