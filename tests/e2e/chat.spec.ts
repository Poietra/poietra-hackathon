import { expect, test, type Page, type Route } from '@playwright/test';

const fulfill = (route: Route, value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
const log = (page: Page) => page.getByRole('log', { name: '共同編集チャット', exact: true });
async function open(page: Page, room: string, name: string, ai = true) {
  await page.addInitScript(name => localStorage.setItem('poietra-user-name', name), name);
  await page.route('**/api/health', route => fulfill(route, { ok: true, ai }));
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
}
const proposal = (message: string, property = 'x', value = 640, expected = 245) => ({ id: crypto.randomUUID(), message, count: 1, changes: [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', property], value, expected, existed: true }] });

test('people chat without AI availability, see real names and unread messages, and restore room-wide history after reload', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID(); let calls = 0;
  for (const page of [alice, bob]) await page.route('**/api/ai/propose', route => { calls++; return route.abort(); });
  try {
    await Promise.all([open(alice, room, 'Alice', false), open(bob, room, 'Bob', false)]);
    await bob.getByRole('button', { name: 'Design', exact: true }).click();
    await send(alice, '円は黄色がいいと思います');
    await expect(bob.getByLabel('1 件の未読', { exact: true })).toBeVisible();
    await bob.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(log(bob).getByText('円は黄色がいいと思います', { exact: true })).toBeVisible();
    await expect(log(bob).locator('.chat-author').first()).toContainText('Alice');
    await send(bob, 'いいですね！\n次の場面も相談しましょう');
    await expect(log(alice).getByText('いいですね！\n次の場面も相談しましょう', { exact: true })).toBeVisible();
    await send(alice, '連絡先 person@codex.com');
    expect(calls).toBe(0);
    await alice.reload(); await expect(alice.getByText('Live', { exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(log(alice).locator('.chat-message.user')).toHaveCount(3);
    await alice.getByRole('button', { name: 'Scene を追加', exact: true }).click();
    await expect(log(alice).getByText('円は黄色がいいと思います', { exact: true })).toBeVisible();
    await expect(log(alice).getByRole('button', { name: 'Scene 1 を開く', exact: true }).first()).toBeVisible();
    await log(alice).getByRole('button', { name: 'Scene 1 を開く', exact: true }).first().click();
    await expect(alice.getByRole('tab', { name: 'Scene 1', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(calls).toBe(0);
  } finally { await a.close(); await b.close(); }
});

test('@codex calls AI only on the sending browser, shares pending/reply/apply status, and restores an unapplied proposal on reload', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID(); let calls = 0, peerCalls = 0, response!: Route;
  const requests: { prompt: string; history: { role: string; content: string }[] }[] = [];
  await alice.route('**/api/ai/propose', route => { calls++; requests.push(route.request().postDataJSON()); response = route; });
  await bob.route('**/api/ai/propose', route => { peerCalls++; return route.abort(); });
  try {
    await Promise.all([open(alice, room, 'Alice'), open(bob, room, 'Bob')]);
    await send(bob, '黄色はこのままで、位置だけ変えよう');
    await expect(log(alice).getByText('黄色はこのままで、位置だけ変えよう', { exact: true })).toBeVisible();
    await send(alice, '@codex 円を中央にして');
    await expect.poll(() => calls).toBe(1);
    expect(requests[0].prompt).toBe('円を中央にして');
    expect(requests[0].history).toContainEqual({ role: 'user', content: 'Bob: 黄色はこのままで、位置だけ変えよう' });
    await expect(log(bob).getByText('Codex に依頼中…', { exact: true })).toBeVisible();
    await send(alice, '次は数式を出そう');
    await expect(log(bob).getByText('次は数式を出そう', { exact: true })).toBeVisible();
    await fulfill(response, proposal('円を中央に移動する案です。'));
    await expect(log(bob).getByText('円を中央に移動する案です。', { exact: true })).toBeVisible();
    await expect(log(bob).getByRole('button', { name: 'Apply edits', exact: true })).toHaveCount(0);
    await expect(log(bob).getByText('依頼した人が適用できます', { exact: true })).toBeVisible();
    await alice.reload(); await expect(alice.getByText('Live', { exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(log(alice).getByRole('button', { name: 'Apply edits', exact: true })).toBeVisible();
    await log(alice).getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(log(bob).getByText('Applied', { exact: true })).toBeVisible();
    await bob.getByRole('button', { name: 'Design', exact: true }).click();
    await bob.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('640');
    await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await expect(log(alice).getByText('円を中央に移動する案です。', { exact: true })).toBeVisible();
    expect(calls).toBe(1); expect(peerCalls).toBe(0);
  } finally { await a.close(); await b.close(); }
});

test('both collaborators can invoke Codex, and a peer request does not cancel the local pending request', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID();
  let aCalls = 0, bCalls = 0, aReply!: Route, bReply!: Route;
  await alice.route('**/api/ai/propose', route => { aCalls++; aReply = route; });
  await bob.route('**/api/ai/propose', route => { bCalls++; bReply = route; });
  try {
    await Promise.all([open(alice, room, 'Alice'), open(bob, room, 'Bob')]);
    await send(alice, '@codex 円を中央にして'); await expect.poll(() => aCalls).toBe(1);
    await send(bob, '@codex 円の色を変えて'); await expect.poll(() => bCalls).toBe(1);
    await expect(log(alice).getByText('Codex に依頼中…', { exact: true })).toHaveCount(2);
    await fulfill(bReply, { id: crypto.randomUUID(), message: 'どの色にしますか？', count: 0, changes: [] });
    await expect(log(alice).getByText('どの色にしますか？', { exact: true })).toBeVisible();
    await expect(alice.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await fulfill(aReply, proposal('中央に移動します。'));
    await expect(log(bob).getByText('中央に移動します。', { exact: true })).toBeVisible();
    expect(aCalls).toBe(1); expect(bCalls).toBe(1);
  } finally { await a.close(); await b.close(); }
});

test('offline human messages merge on reconnection without changing the edit Undo stack or calling AI', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID(); let calls = 0;
  for (const page of [alice, bob]) await page.route('**/api/ai/propose', route => { calls++; return route.abort(); });
  try {
    await Promise.all([open(alice, room, 'Alice'), open(bob, room, 'Bob')]);
    await a.setOffline(true);
    await send(alice, 'オフラインで書いた相談'); await send(bob, 'オンライン側の相談');
    await a.setOffline(false);
    await expect(log(alice).getByText('オンライン側の相談', { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(log(bob).getByText('オフラインで書いた相談', { exact: true })).toBeVisible();
    await expect(alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true })).toBeDisabled();
    await expect(bob.getByRole('button', { name: '元に戻す (⌘Z)', exact: true })).toBeDisabled();
    expect(calls).toBe(0);
  } finally { await a.close(); await b.close(); }
});

test('an interrupted request becomes stopped after reload and can be restored without sending it twice', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/ai/propose', () => { calls++; });
  await open(page, crypto.randomUUID(), 'Alice');
  await send(page, '@codex 円を黄色にして'); await expect.poll(() => calls).toBe(1);
  await page.reload(); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(log(page).getByText('停止しました', { exact: true })).toBeVisible({ timeout: 15000 });
  await log(page).getByRole('button', { name: '依頼を入力欄に戻す', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'チャットメッセージ', exact: true })).toHaveValue('@codex 円を黄色にして');
  expect(calls).toBe(1);
});

test('the mention shortcut focuses the composer and IME confirmation does not send a message', async ({ page }, testInfo) => {
  let calls = 0;
  await page.route('**/api/ai/propose', route => { calls++; return fulfill(route, { id: crypto.randomUUID(), message: '円をどのくらい大きくしますか？', count: 0, changes: [] }); });
  await open(page, crypto.randomUUID(), 'Alice');
  const composer = page.getByRole('textbox', { name: 'チャットメッセージ', exact: true });
  await page.getByRole('button', { name: '@codex', exact: true }).click();
  await expect(composer).toBeFocused(); await expect(composer).toHaveValue('@codex ');
  await composer.press('Enter'); await expect(page.getByRole('alert')).toContainText('@codex の後に');
  expect(calls).toBe(0);
  await composer.fill('相談中の日本語');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(log(page).locator('.chat-message.user')).toHaveCount(0);
  await expect(composer).toHaveValue('相談中の日本語');
  await composer.fill('円のサイズを相談しましょう'); await composer.press('Enter');
  await send(page, '@codex 円を大きくして');
  await expect(log(page).getByText('円をどのくらい大きくしますか？', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shared-chat.png'), fullPage: true });
  expect(calls).toBe(1);
});

test('a received chat message keeps project preview playing', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext(), alice = await a.newPage(), bob = await b.newPage(), room = crypto.randomUUID();
  try {
    await Promise.all([open(alice, room, 'Alice'), open(bob, room, 'Bob')]);
    await alice.getByRole('button', { name: 'Preview project', exact: true }).click();
    await alice.getByRole('button', { name: 'プロジェクトを再生', exact: true }).click();
    await send(bob, '再生しながら見ています');
    await expect(alice.locator('.chat-message > p').filter({ hasText: '再生しながら見ています' })).toHaveCount(1);
    await expect(alice.getByRole('button', { name: 'プロジェクトの再生を停止', exact: true })).toBeVisible();
  } finally { await a.close(); await b.close(); }
});

test('people can chat from a scene preview and Codex targets the displayed moment after returning to editing', async ({ page }) => {
  const requests: { compositionId: string }[] = [];
  await page.route('**/api/ai/propose', route => { requests.push(route.request().postDataJSON()); return fulfill(route, { id: crypto.randomUUID(), message: '今の場面を確認しました。', count: 0, changes: [] }); });
  await open(page, crypto.randomUUID(), 'Alice');
  await page.getByRole('slider', { name: '再生位置', exact: true }).fill('2500');
  await expect(page.getByRole('textbox', { name: 'チャットメッセージ', exact: true })).toBeVisible();
  await send(page, 'この場面もよさそうです');
  await expect(log(page).getByText('この場面もよさそうです', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).fill('@codex この場面を確認して');
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'この場面を編集', exact: true }).click();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(log(page).getByText('今の場面を確認しました。', { exact: true })).toBeVisible();
  expect(requests[0].compositionId).toBe('comp-2');
});
