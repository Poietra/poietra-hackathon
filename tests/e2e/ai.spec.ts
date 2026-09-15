import { expect, test, type Page, type Route } from '@playwright/test';

// These are explicit API stubs. No real model call or API key is involved in this suite.
const positionProposal = (x: number, expected = 245, message = '円の位置を調整しました。') => ({
  id: crypto.randomUUID(), message, count: 1,
  changes: [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', 'x'], value: x, expected, existed: true }],
});
const fulfill = (route: Route, body: object, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function open(page: Page, room = crypto.randomUUID()) {
  await page.route('**/api/health', route => fulfill(route, { ok: true, ai: true }));
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
}
async function assistant(page: Page) { await page.getByRole('button', { name: 'Chat', exact: true }).click(); }
async function send(page: Page, text = '円を中央にしてください') {
  await page.getByRole('textbox', { name: 'チャットメッセージ' }).fill(`@codex ${text}`);
  await page.getByRole('button', { name: '送信', exact: true }).click();
}
async function design(page: Page) { await page.getByRole('button', { name: 'Design', exact: true }).click(); }
async function setX(page: Page, value: string) {
  const field = page.getByRole('spinbutton', { name: 'Position X', exact: true }); await field.fill(value); await field.press('Tab');
}

test('a proposal survives inspecting Design, preserves peer fields, and rejects a stale follow-up', async ({ browser }) => {
  const first = await browser.newContext(); const second = await browser.newContext();
  const alice = await first.newPage(); const bob = await second.newPage(); const room = crypto.randomUUID();
  await Promise.all([open(alice, room), open(bob, room)]);
  await alice.route('**/api/ai/propose', route => fulfill(route, positionProposal(640)));
  await assistant(alice); await send(alice);
  await expect(alice.getByRole('button', { name: 'Apply edits' })).toBeVisible();
  await design(alice); await assistant(alice);
  await expect(alice.getByRole('button', { name: 'Apply edits' })).toBeVisible();
  await bob.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
  await alice.getByRole('button', { name: 'Apply edits' }).click();
  await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('640');
  await expect(bob.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
  await send(alice, 'もう一度中央へ');
  await expect(alice.getByRole('button', { name: 'Apply edits' })).toBeVisible();
  await setX(bob, '350');
  await design(alice); await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('350'); await assistant(alice);
  await alice.getByRole('button', { name: 'Apply edits' }).click();
  await expect(alice.getByRole('alert')).toContainText('提案後に対象が変更');
  await expect(bob.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('350');
  await expect(bob.getByRole('textbox', { name: 'Fillのカラーコード' })).toHaveValue('F4CE55');
  await first.close(); await second.close();
});

test('changing the composition while waiting keeps the request target explicit', async ({ page }) => {
  await open(page); await assistant(page);
  let route!: Route;
  await page.route('**/api/ai/propose', current => { route = current; });
  await send(page); await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await fulfill(route, positionProposal(640));
  await expect(page.getByRole('button', { name: '対象を表示', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply edits' })).toBeVisible();
  await page.getByRole('button', { name: '対象を表示', exact: true }).click();
  await page.getByRole('button', { name: 'Apply edits' }).click();
  await design(page); await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('640');
  await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('955');
});

test('canceling then requesting again ignores the first response and keeps the next draft', async ({ page }) => {
  await open(page); await assistant(page);
  let first!: Route; let second!: Route; let count = 0;
  await page.route('**/api/ai/propose', route => { count += 1; if (count === 1) first = route; else second = route; });
  await send(page, '最初の依頼');
  await expect.poll(() => count).toBe(1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'チャットメッセージ' })).toHaveValue('@codex 最初の依頼');
  await send(page, '次の依頼'); await expect.poll(() => count).toBe(2);
  await page.getByRole('textbox', { name: 'チャットメッセージ' }).fill('編集中の下書き');
  await fulfill(first, positionProposal(500, 245, '停止済みの応答')).catch(() => {});
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
  await fulfill(second, positionProposal(640, 245, '新しい応答'));
  await expect(page.getByText('新しい応答', { exact: true })).toBeVisible();
  await expect(page.getByText('停止済みの応答', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'チャットメッセージ' })).toHaveValue('編集中の下書き');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
});

test('changing the scene cancels the pending response and later requests use the new scene', async ({ page }) => {
  await open(page); await assistant(page); let first!: Route; const requests: Array<{ sceneId: string; selectedIds: string[] }> = [];
  await page.route('**/api/ai/propose', route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) first = route;
    else return fulfill(route, { id: crypto.randomUUID(), message: '新しい Scene の応答', count: 0, changes: [] });
  });
  await send(page); await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: 'Scene を追加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Scene を切り替えたため');
  await send(page, '新しい場面を考えて');
  await expect(page.getByText('新しい Scene の応答', { exact: true })).toBeVisible();
  expect(requests[1].sceneId).not.toBe('scene-1'); expect(requests[1].selectedIds).toEqual([]);
  await fulfill(first, positionProposal(640, 245, '前の Scene の応答')).catch(() => {});
  await expect(page.getByText('前の Scene の応答', { exact: true })).toHaveCount(0);
});

test('an API failure can be retried, with no fake edit and no lost draft', async ({ page }) => {
  await open(page); await assistant(page); let first!: Route; let count = 0;
  await page.route('**/api/ai/propose', route => {
    count += 1;
    if (count === 1) first = route;
    else return fulfill(route, positionProposal(640));
  });
  await send(page); await expect.poll(() => count).toBe(1);
  await page.getByRole('textbox', { name: 'チャットメッセージ' }).fill('次の依頼の下書き');
  await fulfill(first, { error: '接続を再確認してください。' }, 503);
  await expect(page.getByRole('alert')).toContainText('接続を再確認');
  await expect(page.getByRole('button', { name: 'Apply edits' })).toHaveCount(0);
  await page.getByRole('button', { name: '再試行', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply edits' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'チャットメッセージ' })).toHaveValue('次の依頼の下書き');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Ctrl+Enter sends a @codex request and applies the guarded proposal without a click', async ({ page }) => {
  await open(page); await assistant(page);
  await page.route('**/api/ai/propose', route => fulfill(route, positionProposal(640)));
  const composer = page.getByRole('textbox', { name: 'チャットメッセージ' });
  await composer.fill('@codex 円を中央にしてください'); await composer.press('Control+Enter');
  await expect(page.getByText('Applied', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply edits' })).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('即適用');
  await design(page); await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('640');
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
});
