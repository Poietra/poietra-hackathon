import { expect, test, type Page, type Route } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { compileProposal, type EditProposal, type EditProposalSchema } from '../../shared/ai';
import { readProject } from '../../shared/document';
import type { z } from 'zod';

// Explicit API stubs: these tests make no model requests. Editing proposals use the real compiler and live Yjs guards.
type History = { role: 'user' | 'assistant'; content: string; proposalStatus?: 'proposed' | 'applied' | 'discarded' };
type Request = { prompt: string; history: History[]; sceneId: string; compositionId: string | null; transitionId: string | null; selectedIds: string[] };
type Operations = z.infer<typeof EditProposalSchema>['operations'];
const reply = (message: string): EditProposal => ({ id: crypto.randomUUID(), message, count: 0, changes: [] });
const fulfill = (route: Route, body: object, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const log = (page: Page) => page.getByRole('log', { name: 'AI との編集履歴', exact: true });
const card = (page: Page, message: string) => log(page).locator('.chat-message.assistant').filter({ hasText: message }).locator('.proposal-card');
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'AI への編集依頼', exact: true }).fill(text);
  await page.getByRole('button', { name: '編集を依頼', exact: true }).click();
}
async function answered(page: Page, text: string) {
  await expect(log(page).locator('.chat-message.assistant > p').last()).toHaveText(text);
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
}
async function field(page: Page, label: string, value: string) {
  const input = page.getByRole('spinbutton', { name: label, exact: true }); await input.fill(value); await input.press('Tab');
}
async function open(page: Page, room = crypto.randomUUID()) {
  await page.route('**/api/health', route => fulfill(route, { ok: true, ai: true }));
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  return room;
}
async function observe(page: Page, room: string) {
  const doc = new Y.Doc(); const endpoint = new URL(page.url());
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', (synced: boolean) => { if (synced) resolve(); }));
  return {
    scene: () => readProject(doc)!.scenes['scene-1'],
    proposal: (message: string, operations: Operations) => compileProposal(doc, readProject(doc)!, 'scene-1', { message, operations }),
    close: () => { provider.destroy(); doc.destroy(); },
  };
}

const multiPositions: Operations = [
  { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 300 },
  { action: 'setState', compositionId: 'comp-2', objectId: 'circle', property: 'x', value: 1000 },
];

test('a Composition request shows its real Transition and both Composition targets, applies from another selection and undoes without overwriting peer color', async ({ page, browser }) => {
  const room = await open(page), observer = await observe(page, room), peerContext = await browser.newContext();
  const peer = await peerContext.newPage(); const requests: Request[] = [];
  const message = '両方の配置と、その間の円の移動経路を調整しました。';
  const before = structuredClone(observer.scene());
  await page.route('**/api/ai/propose', route => {
    requests.push(route.request().postDataJSON());
    return fulfill(route, observer.proposal(message, [...multiPositions, { action: 'setMotionPath', transitionId: 'transition-1', objectId: 'circle', path: { c1: { x: 400, y: 100 }, c2: { x: 800, y: 100 } } }]));
  });
  try {
    await open(peer, room); await peer.getByRole('button', { name: 'Design', exact: true }).click();
    await send(page, 'Composition 1と2の円の配置を調整し、その間を上に弧を描いて移動させて'); await answered(page, message);
    expect(requests[0].compositionId).toBe('comp-1'); expect(requests[0].transitionId).toBeNull();
    const proposal = card(page, message), targets = proposal.locator('.proposal-target');
    await expect(targets).toHaveCount(3);
    await expect(targets.filter({ hasText: 'Transition' })).toContainText('Composition 1 → Composition 2');
    await expect(targets.filter({ hasText: 'Transition' })).toContainText('Circle');
    await targets.filter({ hasText: 'Transition' }).getByRole('button', { name: '対象を表示', exact: true }).click();
    await expect(page.getByTestId('stage-to')).toBeVisible();
    await targets.filter({ hasText: 'Composition 2' }).filter({ hasNotText: 'Transition' }).getByRole('button', { name: '対象を表示', exact: true }).click();
    await expect(page.getByTestId('stage-main')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Composition 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click();
    await peer.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
    await expect.poll(() => observer.scene().compositions['comp-1'].states.circle.fill).toBe('#f4ce55');
    await proposal.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(proposal).toContainText('Applied');
    await expect(page.locator('.layer-row.selected')).toHaveAttribute('data-layer-id', 'sigmoid');
    await expect(peer.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('300');
    await expect.poll(() => observer.scene().compositions['comp-2'].states.circle.x).toBe(1000);
    expect(observer.scene().transitions['transition-1'].tracks.circle.path!.c1.y).toBe(100);
    expect(observer.scene().compositions['comp-1'].states.sigmoid).toEqual(before.compositions['comp-1'].states.sigmoid);
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(peer.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('245');
    await expect.poll(() => observer.scene().compositions['comp-2'].states.circle.x).toBe(955);
    expect(observer.scene().transitions['transition-1'].tracks.circle.path).toEqual(before.transitions['transition-1'].tracks.circle.path);
    await expect(peer.getByRole('textbox', { name: 'Fillのカラーコード', exact: true })).toHaveValue('F4CE55');
  } finally { observer.close(); await peerContext.close(); }
});

test('a peer timing change rejects the entire proposal across multiple targets', async ({ page, browser }) => {
  const room = await open(page), observer = await observe(page, room), peerContext = await browser.newContext();
  const peer = await peerContext.newPage(), message = '配置とアニメーションの長さを調整しました。';
  await page.route('**/api/ai/propose', route => fulfill(route, observer.proposal(message, [...multiPositions, { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'duration', value: 500 }])));
  try {
    await open(peer, room); await peer.getByRole('button', { name: 'Design', exact: true }).click();
    await send(page, '円の両Compositionの位置と移動時間を調整して'); await answered(page, message);
    await peer.getByRole('button', { name: 'Transition 800 ms', exact: true }).click(); await field(peer, 'Animation duration', '550');
    await expect.poll(() => observer.scene().transitions['transition-1'].tracks.circle.duration).toBe(550);
    await card(page, message).getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('提案後に対象が変更');
    expect(observer.scene().compositions['comp-1'].states.circle.x).toBe(245);
    expect(observer.scene().compositions['comp-2'].states.circle.x).toBe(955);
    expect(observer.scene().transitions['transition-1'].tracks.circle.duration).toBe(550);
    await expect(card(page, message).getByText('Applied', { exact: true })).toHaveCount(0);
  } finally { observer.close(); await peerContext.close(); }
});

test('completed conversation turns preserve conditions, questions and proposed/applied/discarded status in subsequent requests', async ({ page }) => {
  const room = await open(page), observer = await observe(page, room), requests: Request[] = [];
  const prompts = ['この円を跳ね返らせたい', '地面は y=600、反発係数は0.8です', 'その条件で続けて', '今の位置を保って色を調整して', '破棄した色は使わず続けて'];
  const responses = ['地面の高さと反発係数を教えてください。', '円の位置を提案しました。', '条件を引き継ぎます。', '円の色を提案しました。', '現在の編集状態から続けます。'];
  await page.route('**/api/ai/propose', route => {
    const index = requests.push(route.request().postDataJSON()) - 1;
    return fulfill(route, index === 1 ? observer.proposal(responses[index], [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 640 }]) : index === 3 ? observer.proposal(responses[index], [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'fill', value: '#ef8078' }]) : reply(responses[index]));
  });
  try {
    for (let index = 0; index < 3; index++) { await send(page, prompts[index]); await answered(page, responses[index]); }
    expect(requests[0].history).toEqual([]);
    expect(requests[1].history).toEqual([{ role: 'user', content: prompts[0] }, { role: 'assistant', content: responses[0] }]);
    expect(requests[2].prompt).toBe(prompts[2]);
    expect(requests[2].history).toContainEqual({ role: 'user', content: prompts[1] });
    expect(requests[2].history).toContainEqual({ role: 'assistant', content: responses[1], proposalStatus: 'proposed' });
    expect(requests[2].history.some(turn => turn.content === prompts[2])).toBe(false);
    await card(page, responses[1]).getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect.poll(() => observer.scene().compositions['comp-1'].states.circle.x).toBe(640);
    await send(page, prompts[3]); await answered(page, responses[3]);
    expect(requests[3].history).toContainEqual({ role: 'assistant', content: responses[1], proposalStatus: 'applied' });
    await card(page, responses[3]).getByRole('button', { name: '編集案を破棄', exact: true }).click();
    await send(page, prompts[4]); await answered(page, responses[4]);
    expect(requests[4].history).toContainEqual({ role: 'assistant', content: responses[3], proposalStatus: 'discarded' });
    expect(requests[4].history).toHaveLength(8);
    expect(observer.scene().compositions['comp-1'].states.circle.fill).not.toBe('#ef8078');
  } finally { observer.close(); }
});

test('retry reuses its user entry and stopped unanswered requests never enter later history', async ({ page }) => {
  await open(page); const requests: Request[] = []; let stopped!: Route;
  await page.route('**/api/ai/propose', route => {
    const index = requests.push(route.request().postDataJSON());
    if (index === 1) return fulfill(route, { error: '一時的に接続できません。' }, 503);
    if (index === 3) { stopped = route; return; }
    return fulfill(route, reply(`完了応答${index}`));
  });
  await send(page, '再試行する依頼'); await expect(page.getByRole('button', { name: '再試行', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '再試行', exact: true }).click(); await answered(page, '完了応答2');
  expect(requests[1].prompt).toBe('再試行する依頼'); expect(requests[1].history).toEqual([]);
  await expect(log(page).locator('.chat-message.user').filter({ hasText: '再試行する依頼' })).toHaveCount(1);
  await send(page, '停止する依頼'); await expect.poll(() => requests.length).toBe(3);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await send(page, '停止後の依頼'); await answered(page, '完了応答4');
  await fulfill(stopped, reply('停止した古い応答')).catch(() => {});
  await expect(log(page).getByText('停止した古い応答', { exact: true })).toHaveCount(0);
  expect(requests[3].history).toEqual([{ role: 'user', content: '再試行する依頼' }, { role: 'assistant', content: '完了応答2' }]);
  await send(page, '履歴を確認'); await answered(page, '完了応答5');
  expect(requests[4].history).toHaveLength(4);
  expect(requests[4].history.some(turn => turn.content.includes('停止する依頼') || turn.content.includes('停止した古い応答'))).toBe(false);
});

test('switching Scenes aborts pending work and keeps completed histories separate when returning', async ({ page }) => {
  await open(page); const requests: Request[] = []; let oldScenePending!: Route;
  await page.route('**/api/ai/propose', route => {
    const index = requests.push(route.request().postDataJSON());
    if (index === 2) { oldScenePending = route; return; }
    return fulfill(route, reply(`Scene応答${index}`));
  });
  await send(page, '最初のSceneの条件'); await answered(page, 'Scene応答1');
  await send(page, '最初のSceneの未完了依頼'); await expect.poll(() => requests.length).toBe(2);
  await page.getByRole('button', { name: 'Scene を追加', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Scene 2', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await expect(log(page).getByText('Scene応答1', { exact: true })).toHaveCount(0);
  await send(page, '別Sceneの条件'); await answered(page, 'Scene応答3');
  expect(requests[2].sceneId).not.toBe('scene-1'); expect(requests[2].history).toEqual([]);
  await fulfill(oldScenePending, reply('前Sceneの遅い応答')).catch(() => {});
  await page.getByRole('tab', { name: 'Scene 1', exact: true }).click();
  await expect(log(page).getByText('Scene応答1', { exact: true })).toBeVisible();
  await expect(log(page).getByText('Scene応答3', { exact: true })).toHaveCount(0);
  await expect(log(page).getByText('前Sceneの遅い応答', { exact: true })).toHaveCount(0);
  await send(page, 'このSceneの条件で続けて'); await answered(page, 'Scene応答4');
  expect(requests[3].sceneId).toBe('scene-1');
  expect(requests[3].history).toEqual([{ role: 'user', content: '最初のSceneの条件' }, { role: 'assistant', content: 'Scene応答1' }]);
});

test('history retains recent complete turns within entry, total-content and per-message limits', async ({ page }) => {
  test.setTimeout(60000); await open(page); const requests: Request[] = [], responses: string[] = [];
  await page.route('**/api/ai/propose', route => {
    const index = requests.push(route.request().postDataJSON()) - 1;
    const content = index < 14 ? `短い応答${index}` : `長い応答${index}:` + 'a'.repeat(2990);
    responses.push(content); return fulfill(route, reply(content));
  });
  for (let index = 0; index < 19; index++) {
    await send(page, index < 14 ? `短い依頼${index}` : `長い依頼${index}:` + 'b'.repeat(2990));
    await expect.poll(() => responses.length).toBe(index + 1); await answered(page, responses[index]);
  }
  expect(requests[13].history).toHaveLength(24);
  expect(requests[13].history.some(turn => turn.content === '短い依頼0')).toBe(false);
  for (const request of requests) {
    expect(request.history.length).toBeLessThanOrEqual(24);
    expect(request.history.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(24000);
    expect(request.history.every(turn => turn.content.length <= 3000)).toBe(true);
    expect(request.history.at(-1)?.role ?? 'assistant').toBe('assistant');
    expect(request.history.filter(turn => turn.role === 'user').length).toBe(request.history.filter(turn => turn.role === 'assistant').length);
  }
  expect(requests.at(-1)!.history.length).toBeLessThan(24);
  expect(requests.at(-1)!.history.at(-1)?.content).toBe(responses[17]);
});
