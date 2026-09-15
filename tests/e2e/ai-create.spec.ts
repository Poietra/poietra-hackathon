import { expect, test, type Page, type Route } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import type { z } from 'zod';
import { compileProposal, type EditProposal, type EditProposalSchema } from '../../shared/ai';
import { readProject } from '../../shared/document';
import { parseProjectFile } from '../../shared/project-file';

type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const curve = { c1: { x: 400, y: 100 }, c2: { x: 800, y: 100 } };
const ball: Operation[] = [
  { action: 'createObject', ref: '@ball', compositionId: 'comp-1', name: 'AI ball', kind: 'circle', x: 200, y: 500, width: 48, height: 48, fill: '#f4ce55', text: '', fontSize: 40 },
  { action: 'setState', compositionId: 'comp-2', objectId: '@ball', property: 'visible', value: true },
  { action: 'setState', compositionId: 'comp-2', objectId: '@ball', property: 'x', value: 1000 },
  { action: 'setTrack', transitionId: 'transition-1', objectId: '@ball', property: 'easing', value: 'linear' },
  { action: 'setMotionPath', transitionId: 'transition-1', objectId: '@ball', path: curve },
  { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 1200 },
];
const formula: Operation[] = [
  { action: 'createObject', ref: '@formula', compositionId: 'comp-2', name: 'AI formula', kind: 'equation', x: 640, y: 580, width: 240, height: 60, fill: '#ffffff', text: 'E = mc^2', fontSize: 42 },
  { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'type', value: 'write' },
  { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'start', value: 400 },
  { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'duration', value: 800 },
  { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'easing', value: 'linear' },
];
const reply = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

// AI HTTP is stubbed. Compilation, full guards, two browsers, Yjs Apply/Undo and preview are real.
async function fixture(page: Page, operations: Operation[]) {
  const room = crypto.randomUUID();
  await page.route('**/api/health', route => reply(route, { ok: true, ai: true }));
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', (synced: boolean) => { if (synced) resolve(); }));
  let proposal: EditProposal | undefined;
  let calls = 0;
  await page.route('**/api/ai/propose', route => {
    calls++;
    const input = route.request().postDataJSON();
    try {
      proposal = compileProposal(doc, readProject(doc)!, input.sceneId, { message: '新しい図形とアニメーションを、ひとつの編集案にまとめました。', operations });
      return reply(route, proposal);
    } catch (error) { return reply(route, { error: error instanceof Error ? error.message : 'Invalid fixture' }, 400); }
  });
  return {
    doc, calls: () => calls, scene: () => readProject(doc)!.scenes['scene-1'],
    id: (name: string) => (proposal!.changes.find(change => change.path[2] === 'objects' && (change.value as { name: string }).name === name)!.value as { id: string }).id,
    close: () => { provider.destroy(); doc.destroy(); },
  };
}
async function request(page: Page, prompt = '新しい黄色い円を作って上に弧を描いて動かし、数式も登場させて。Transition は1200msにして') {
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).fill(`@codex ${prompt}`);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeVisible();
}
async function preview(page: Page, position = '600') {
  await page.getByRole('button', { name: 'Transition 1,200 ms', exact: true }).click();
  await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill(position);
}
const item = (page: Page, id: string, stage = 'to') => page.locator(`[data-testid="stage-${stage}"] .scene-svg [data-object-id="${id}"]`);

test('one AI proposal creates Move and Write animations, previews in two browsers, and undoes/redoes completely', async ({ page, browser }, testInfo) => {
  const room = await fixture(page, [...ball, ...formula]);
  const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const peer = await peerContext.newPage();
  await peer.route('**/api/ai/propose', route => route.abort('blockedbyclient'));
  try {
    await peer.goto(page.url()); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    const original = structuredClone(room.scene());
    await request(page);
    await expect(page.getByLabel('編集する対象', { exact: true })).toContainText('AI ball');
    await expect(page.getByLabel('編集する対象', { exact: true })).toContainText('AI formula');
    const ballId = room.id('AI ball'), formulaId = room.id('AI formula');
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'AI ball', exact: true })).toBeVisible();
    await expect(peer.getByRole('button', { name: 'AI formula', exact: true })).toBeVisible();
    await expect.poll(() => room.scene().transitions['transition-1'].tracks[formulaId]?.type).toBe('write');
    expect(room.calls()).toBe(1);
    expect(room.scene().compositions['comp-1'].states[formulaId].visible).toBe(false);
    expect(room.scene().compositions['comp-2'].states[formulaId].visible).toBe(true);
    expect(room.scene().transitions['transition-1'].tracks.circle).toEqual(original.transitions['transition-1'].tracks.circle);
    expect(room.scene().transitions['transition-1'].tracks.equation).toEqual(original.transitions['transition-1'].tracks.equation);
    for (const participant of [page, peer]) {
      await preview(participant, '200');
      await expect(item(participant, formulaId)).toHaveCount(0);
      await participant.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('600');
      await expect(item(participant, ballId)).toHaveAttribute('transform', 'translate(600 200) rotate(0)');
      await expect(item(participant, formulaId).locator('path').first()).toBeAttached();
    }
    await page.screenshot({ path: testInfo.outputPath('created-move-and-write.png'), fullPage: true });

    // A peer's existing-object edit must survive Undo of the untouched new objects.
    await peer.getByRole('button', { name: 'Composition 1', exact: true }).click();
    await peer.getByRole('button', { name: 'Circle', exact: true }).click();
    await peer.getByRole('button', { name: '色 #ef8078', exact: true }).click();
    await expect.poll(() => room.scene().compositions['comp-1'].states.circle.fill).toBe('#ef8078');
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'AI ball', exact: true })).toHaveCount(0);
    await expect(peer.getByRole('button', { name: 'AI formula', exact: true })).toHaveCount(0);
    await expect.poll(() => room.scene().transitions['transition-1'].duration).toBe(800);
    for (const comp of Object.values(room.scene().compositions)) { expect(comp.states[ballId]).toBeUndefined(); expect(comp.states[formulaId]).toBeUndefined(); }
    expect(room.scene().transitions['transition-1'].tracks[ballId]).toBeUndefined();
    expect(room.scene().transitions['transition-1'].tracks[formulaId]).toBeUndefined();
    expect(room.scene().compositions['comp-1'].states.circle.fill).toBe('#ef8078');
    await page.getByRole('button', { name: 'やり直す (⌘⇧Z)', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'AI ball', exact: true })).toBeVisible();
    await preview(peer); await expect(item(peer, ballId)).toHaveAttribute('transform', 'translate(600 200) rotate(0)');
    expect(parseProjectFile(JSON.stringify(readProject(room.doc)))).toEqual(readProject(room.doc));
  } finally { room.close(); await peerContext.close(); }
});

test('creation Undo preserves a peer-edited new object, its animation and required Transition length', async ({ page, browser }) => {
  const room = await fixture(page, [...ball, { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 300 }]);
  const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const peer = await peerContext.newPage();
  await peer.route('**/api/ai/propose', route => route.abort('blockedbyclient'));
  try {
    await peer.goto(page.url()); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await request(page, '黄色い円を新しく作って1200msで動かし、既存Circleの最初のXを300にして'); const id = room.id('AI ball');
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'AI ball', exact: true })).toBeVisible();
    await peer.getByRole('button', { name: 'Composition 2', exact: true }).click();
    await peer.getByRole('button', { name: 'AI ball', exact: true }).click();
    await peer.getByRole('button', { name: '色 #ef8078', exact: true }).click();
    await expect.poll(() => room.scene().compositions['comp-2'].states[id].fill).toBe('#ef8078');
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect.poll(() => room.scene().compositions['comp-1'].states.circle.x).toBe(245);
    await expect(peer.getByRole('button', { name: 'AI ball', exact: true })).toBeVisible();
    expect(room.scene().compositions['comp-2'].states[id].fill).toBe('#ef8078');
    expect(room.scene().transitions['transition-1'].tracks[id].path).toEqual(curve);
    expect(room.scene().transitions['transition-1'].duration).toBeGreaterThanOrEqual(1200);
    expect(parseProjectFile(JSON.stringify(readProject(room.doc)))).toEqual(readProject(room.doc));
    await preview(peer); await expect(item(peer, id)).toHaveAttribute('transform', 'translate(600 200) rotate(0)');
    expect(room.calls()).toBe(1);
  } finally { room.close(); await peerContext.close(); }
});

test('Undo of an AI timing extension keeps a peer’s longer existing animation valid and previewable', async ({ page, browser }) => {
  const room = await fixture(page, [
    { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 2000 },
    { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'duration', value: 2000 },
  ]);
  const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const peer = await peerContext.newPage();
  await peer.route('**/api/ai/propose', route => route.abort('blockedbyclient'));
  try {
    await peer.goto(page.url()); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await request(page, '既存のCircleを同じ経路で2秒かけて動かして');
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await peer.getByRole('button', { name: 'Transition 2,000 ms', exact: true }).click();
    await peer.getByRole('button', { name: 'Circle', exact: true }).click();
    const duration = peer.getByRole('spinbutton', { name: 'Animation duration', exact: true });
    await duration.fill('1800'); await duration.press('Tab');
    await expect.poll(() => room.scene().transitions['transition-1'].tracks.circle.duration).toBe(1800);
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(duration).toHaveValue('1800');
    expect(room.scene().transitions['transition-1'].duration).toBeGreaterThanOrEqual(1800);
    expect(parseProjectFile(JSON.stringify(readProject(room.doc)))).toEqual(readProject(room.doc));
    await peer.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('900');
    await expect(item(peer, 'circle')).toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
    expect(room.calls()).toBe(1);
  } finally { room.close(); await peerContext.close(); }
});
