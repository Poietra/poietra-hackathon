import { expect, test, type Page, type Route } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import type { z } from 'zod';
import { compileProposal, type EditProposalSchema } from '../../shared/ai';
import { applyChanges, readProject } from '../../shared/document';

type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const curve = { c1: { x: 500, y: 100 }, c2: { x: 750, y: 100 } };
const original = { c1: { x: 505, y: 520 }, c2: { x: 665, y: 190 } };
const motion = (path: typeof curve | null = curve): Operation => ({ action: 'setMotionPath', transitionId: 'transition-1', objectId: 'circle', path });
const statePath = ['scenes', 'scene-1', 'compositions', 'comp-1', 'states'];
const reply = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// AI HTTP responses are explicitly stubbed. The room, guards, application and WASM preview are real.
async function fixture(page: Page) {
  const room = crypto.randomUUID();
  await page.route('**/api/health', route => reply(route, { ok: true, ai: true }));
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', (synced: boolean) => { if (synced) resolve(); }));
  return { doc, close: () => { provider.destroy(); doc.destroy(); } };
}
async function stub(page: Page, doc: Y.Doc, operations: (prompt: string) => Operation[]) {
  await page.route('**/api/ai/propose', route => {
    const input = route.request().postDataJSON();
    try {
      const proposal = compileProposal(doc, readProject(doc)!, input.sceneId, { message: '選択したオブジェクトの経路を調整します。', operations: operations(input.prompt) }, { selectedIds: input.selectedIds, compositionId: input.compositionId, transitionId: input.transitionId });
      return reply(route, proposal);
    } catch (error) { return reply(route, { error: error instanceof Error ? error.message : 'Invalid test proposal' }, 400); }
  });
}
async function send(page: Page, text = '円を上に弧を描いて動かしてください') {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('textbox', { name: 'AI への編集依頼', exact: true }).fill(text);
  await page.getByRole('button', { name: '編集を依頼', exact: true }).click();
}
async function chooseMotion(page: Page) {
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
}

function origin(page: Page) {
  return page.locator('[data-testid="stage-to"] .scene-svg [data-object-id="circle"]').getAttribute('transform').then(transform => {
    const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform || '');
    return { x: Number(match![1]), y: Number(match![2]) };
  });
}

test('an AI motion curve updates WASM preview, preserves another object, undoes, and can return to straight motion', async ({ page }) => {
  const room = await fixture(page);
  try {
    await stub(page, room.doc, prompt => [motion(prompt.includes('直線') ? null : curve)]);
    await chooseMotion(page); await send(page);
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect.poll(() => readProject(room.doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(curve);
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('300');
    await expect.poll(() => origin(page)).toEqual({ x: 618.75, y: 163.75 });
    const states = readProject(room.doc)!.scenes['scene-1'].compositions;
    expect(states['comp-1'].states.circle).toMatchObject({ x: 245, y: 520 });
    expect(states['comp-2'].states.circle).toMatchObject({ x: 955, y: 190 });
    expect(states['comp-1'].states.sigmoid.path).toEqual({ c1: { x: 260, y: 0 }, c2: { x: 420, y: -330 } });
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect.poll(() => readProject(room.doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(original);
    await send(page, '円の移動を直線に戻してください');
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect.poll(() => origin(page)).toEqual({ x: 600, y: 355 });
  } finally { room.close(); }
});

test('a path proposal is rejected when a collaborator changes an endpoint while AI is open', async ({ page }) => {
  const room = await fixture(page);
  try {
    await stub(page, room.doc, () => [motion()]); await chooseMotion(page); await send(page);
    await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeVisible();
    applyChanges(room.doc, [{ path: [...statePath, 'circle', 'x'], value: 320 }]);
    await page.getByRole('button', { name: 'Composition 1', exact: true }).click();
    await page.getByRole('button', { name: 'Design', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('320');
    await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('提案後に対象が変更');
    expect(readProject(room.doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(original);
  } finally { room.close(); }
});

test('an AI shape path changes relative controls only in the selected composition', async ({ page }) => {
  const room = await fixture(page);
  try {
    const path = { c1: { x: 120, y: -250 }, c2: { x: 600, y: -20 } };
    await stub(page, room.doc, () => [{ action: 'setShapePath', compositionId: 'comp-1', objectId: 'sigmoid', path }]);
    await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click(); await send(page, 'この曲線を上に大きく曲げてください');
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(page.locator('[data-testid="stage-main"] .scene-svg [data-object-id="sigmoid"] path').first()).toHaveAttribute('d', 'M0 0 C120 -250 600 -20 710 -330');
    await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
    await expect(page.locator('[data-testid="stage-main"] .scene-svg [data-object-id="sigmoid"] path').first()).toHaveAttribute('d', 'M0 0 C260 0 420 -330 710 -330');
  } finally { room.close(); }
});

test('an out-of-selection model edit is rejected as a whole before any path is applied', async ({ page }) => {
  const room = await fixture(page);
  try {
    await stub(page, room.doc, () => [motion(), { action: 'setShapePath', compositionId: 'comp-2', objectId: 'sigmoid', path: curve }]);
    await chooseMotion(page); await send(page);
    await expect(page.getByRole('alert')).toContainText('選択外のオブジェクト');
    await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toHaveCount(0);
    expect(readProject(room.doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(original);
  } finally { room.close(); }
});
