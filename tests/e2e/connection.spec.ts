import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';

async function details(page: Page) {
  await page.getByRole('button', { name: /^共同編集の接続状態:/ }).click();
}
async function editor(browser: Browser, room: string) {
  const context = await browser.newContext(); let offline = false;
  const sockets: WebSocketRoute[] = [];
  await context.routeWebSocket('**/sync/**', socket => {
    if (offline) socket.close();
    else { sockets.push(socket); socket.connectToServer(); }
  });
  const page = await context.newPage(); await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return { context, page, async offline() {
    offline = true; for (const socket of sockets) socket.close(); await context.setOffline(true);
    await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  }, async online() { offline = false; await context.setOffline(false); } };
}

test('an open socket without initial sync never shows Live and keyboard retry recovers the loading screen', async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket('**/sync/**', socket => {
    if (++connections === 1) socket.onMessage(() => {}); // Open, but never return sync step 2.
    else socket.connectToServer();
  });
  await page.goto(`/?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Syncing', { exact: true })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toHaveCount(0);
  await expect(page.getByText('サーバーに接続しましたが、同期が完了していません。再接続してください。', { exact: true })).toBeVisible({ timeout: 12000 });
  const retry = page.getByRole('button', { name: '再接続', exact: true });
  await retry.focus(); await retry.press('Enter');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Composition 1', exact: true })).toBeVisible();
  expect(connections).toBeGreaterThan(1);
});

test('manual reconnect retains offline changes, remote edits, and local undo history in two browsers', async ({ browser }) => {
  const room = crypto.randomUUID(), alice = await editor(browser, room), bob = await editor(browser, room);
  try {
    for (const client of [alice, bob]) {
      await details(client.page);
      await expect(client.page.getByText('変更をこのブラウザに自動保存します。オフラインの変更は再接続後に共有されます。', { exact: true })).toBeVisible();
      await client.page.keyboard.press('Escape');
      await client.page.getByRole('button', { name: 'Circle', exact: true }).click();
    }
    await Promise.all([alice.offline(), bob.offline()]);
    const x = alice.page.getByRole('spinbutton', { name: 'Position X', exact: true });
    const y = bob.page.getByRole('spinbutton', { name: 'Position Y', exact: true });
    await x.fill('410'); await x.press('Tab'); await y.fill('290'); await y.press('Tab');
    for (const client of [alice, bob]) {
      await details(client.page);
      // Exercise the explicit retry even while unavailable, then allow its
      // automatic reconnection to finish when networking returns.
      const retry = client.page.getByRole('button', { name: '再接続', exact: true });
      await retry.focus(); await retry.press('Enter');
      await client.online();
      await client.page.keyboard.press('Escape');
      await expect(client.page.getByText('Live', { exact: true })).toBeVisible();
    }
    await expect(bob.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('410');
    await expect(alice.page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('290');
    await alice.page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(bob.page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await expect(alice.page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('290');
    await expect(bob.page.getByRole('spinbutton', { name: 'Position Y', exact: true })).toHaveValue('290');
  } finally { await alice.context.close(); await bob.context.close(); }
});

test('the local saving assurance waits until IndexedDB has actually loaded and committed', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBFactory.prototype.open;
    const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!;
    const pending: (() => void)[] = [];
    (window as unknown as { releaseLocalDatabase: () => void }).releaseLocalDatabase = () => pending.splice(0).forEach(fn => fn());
    IDBFactory.prototype.open = function (...args) {
      const request = original.apply(this, args);
      Object.defineProperty(request, 'onsuccess', { set(handler: (event: Event) => void) {
        descriptor.set!.call(request, (event: Event) => pending.push(() => handler(event)));
      } });
      return request;
    };
  });
  await page.goto(`/?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await details(page);
  await expect(page.getByText('ブラウザ内の保存を準備しています。準備が終わるまでこのタブを開いたままにしてください。', { exact: true })).toBeVisible();
  await expect(page.getByText(/^変更をこのブラウザに自動保存します/)).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseLocalDatabase: () => void }).releaseLocalDatabase());
  await expect(page.getByText(/^変更をこのブラウザに自動保存します/)).toBeVisible();
});

test('unavailable local storage has an actionable explanation without claiming edits are saved', async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function () { throw new DOMException('Storage blocked', 'SecurityError'); };
  });
  await page.goto(`/?room=${crypto.randomUUID()}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await details(page);
  await expect(page.getByText('ブラウザ内の保存を確認できません。このタブを開いたまま再接続するか、Save project でファイルを保存してください。', { exact: true })).toBeVisible();
  await expect(page.getByText(/^変更をこのブラウザに自動保存します/)).toHaveCount(0);
});
