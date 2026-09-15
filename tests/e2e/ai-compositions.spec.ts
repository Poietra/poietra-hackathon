import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { compileProposal, type EditProposal, type EditProposalSchema } from '../../shared/ai';
import { applyChanges, readProject } from '../../shared/document';
import { makeBlankScene } from '../../shared/demo';
import { defaultState, type Project } from '../../shared/model';
import { parseProjectFile } from '../../shared/project-file';
import type { z } from 'zod';

type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const sceneId = 'studio', firstId = 'studio-comp-1';
const operations: Operation[] = [
  { action: 'createObject', ref: '@ball', compositionId: firstId, name: 'New ball', kind: 'circle', x: 200, y: 500, width: 48, height: 48, fill: '#f4ce55', text: '', fontSize: 36 },
  { action: 'appendComposition', ref: '@next', transitionRef: '@travel', name: 'Second beat', duration: 1000, transitionDuration: 1200 },
  { action: 'setState', compositionId: '@next', objectId: '@ball', property: 'x', value: 1000 },
  { action: 'setTrack', transitionId: '@travel', objectId: '@ball', property: 'easing', value: 'linear' },
  { action: 'setMotionPath', transitionId: '@travel', objectId: '@ball', path: { c1: { x: 400, y: 100 }, c2: { x: 800, y: 100 } } },
  { action: 'createObject', ref: '@formula', compositionId: '@next', name: 'New formula', kind: 'equation', x: 640, y: 580, width: 240, height: 60, fill: '#ffffff', text: 'E = mc^2', fontSize: 42 },
  { action: 'setTrack', transitionId: '@travel', objectId: '@formula', property: 'type', value: 'write' },
  { action: 'setTrack', transitionId: '@travel', objectId: '@formula', property: 'start', value: 400 },
  { action: 'setTrack', transitionId: '@travel', objectId: '@formula', property: 'duration', value: 800 },
  { action: 'setTrack', transitionId: '@travel', objectId: '@formula', property: 'easing', value: 'linear' },
];

async function open(page: Page, existing = false) {
  const room = crypto.randomUUID();
  await page.route('**/api/health', route => route.fulfill({ json: { ok: true, ai: true } }));
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Observer failed to synchronize')), 10000);
    provider.on('sync', synced => { if (synced) { clearTimeout(timeout); resolve(); } });
  });
  const scene = makeBlankScene(sceneId, 'Our studio');
  if (existing) {
    scene.objects.original = { id: 'original', name: 'Original circle', kind: 'circle', order: 0, locked: false, groupId: null };
    scene.compositions[firstId].states.original = defaultState('circle', { x: 300 });
  }
  const initial: Project = { version: 1, name: 'From a blank scene', sceneOrder: [sceneId], scenes: { [sceneId]: scene } };
  applyChanges(doc, Object.entries(initial).map(([key, value]) => ({ path: [key], value })), 'fixture');
  await expect(page.getByRole('tab', { name: 'Our studio', exact: true })).toBeVisible();
  let proposal: EditProposal;
  await page.route('**/api/ai/propose', route => {
    proposal = compileProposal(doc, readProject(doc)!, sceneId, { message: '次の場面を追加し、円の Move と数式の Write を設定します。', operations });
    return route.fulfill({ json: proposal });
  });
  return {
    doc, initial, scene: () => readProject(doc)!.scenes[sceneId],
    addedId: () => proposal!.compositionAppends![0].compositionIds[0],
    objectId: (name: string) => Object.values(readProject(doc)!.scenes[sceneId].objects).find(object => object.name === name)!.id,
    close: () => { provider.destroy(); doc.destroy(); },
  };
}
async function request(page: Page) {
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'チャットメッセージ', exact: true }).fill('@codex 円と次の場面を作って、ベジェ移動と数式の Write を設定して');
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply edits', exact: true })).toBeVisible();
}

test('a blank Scene becomes an editable animation in one Apply, shows new targets, and fully undoes/redoes', async ({ page, browser }, testInfo) => {
  const room = await open(page), peerContext = await browser.newContext(), peer = await peerContext.newPage();
  try {
    await peer.goto(page.url()); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('button', { name: '円を作り、次の場面へ上向きの弧で動かして', exact: true })).toBeVisible();
    await request(page);
    const targets = page.getByLabel('編集する対象', { exact: true });
    await expect(targets).toContainText('追加 · Second beat');
    await expect(targets).toContainText('Composition 1 → Second beat');
    await expect(targets).not.toContainText('削除された対象');
    await expect(targets.getByRole('button', { name: '適用後に表示', exact: true })).toHaveCount(2);
    for (const button of await targets.getByRole('button', { name: '適用後に表示', exact: true }).all()) await expect(button).toBeDisabled();
    expect(room.scene().compositionOrder).toEqual([firstId]);
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(page.getByTestId('stage-to')).toBeVisible();
    await expect(peer.getByRole('button', { name: 'Second beat', exact: true })).toBeVisible();
    const secondId = room.addedId(), ball = room.objectId('New ball'), formula = room.objectId('New formula');
    expect(room.scene().compositionOrder).toEqual([firstId, secondId]);
    expect(room.scene().compositions[secondId].states[ball]).toMatchObject({ x: 1000, visible: true });
    expect(room.scene().compositions[firstId].states[formula].visible).toBe(false);
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('600');
    await expect(page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${ball}"]`)).toHaveAttribute('transform', 'translate(600 200) rotate(0)');
    await page.screenshot({ path: testInfo.outputPath('one-request-created-scene.png') });
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'Second beat', exact: true })).toHaveCount(0);
    await expect.poll(() => room.scene()).toEqual(room.initial.scenes[sceneId]);
    await page.getByRole('button', { name: 'やり直す (⌘⇧Z)', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'Second beat', exact: true })).toBeVisible();
    await peer.getByRole('button', { name: 'Transition 1,200 ms', exact: true }).click();
    await peer.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('600');
    await expect(peer.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${ball}"]`)).toHaveAttribute('transform', 'translate(600 200) rotate(0)');
    expect(parseProjectFile(JSON.stringify(readProject(room.doc)))).toEqual(readProject(room.doc));
  } finally { room.close(); await peerContext.close(); }
});

test('creation Undo retains the new Composition and animation after a peer edits its contents', async ({ page, browser }) => {
  const room = await open(page), peerContext = await browser.newContext(), peer = await peerContext.newPage();
  try {
    await peer.goto(page.url()); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await request(page); await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await peer.getByRole('button', { name: 'Second beat', exact: true }).click();
    await peer.getByRole('button', { name: 'New ball', exact: true }).click();
    await peer.getByRole('button', { name: '色 #ef8078', exact: true }).click();
    const secondId = room.addedId(), ball = room.objectId('New ball');
    await expect.poll(() => room.scene().compositions[secondId].states[ball].fill).toBe('#ef8078');
    // Wait for the creator's UI to receive the peer update before undoing.
    await page.getByRole('button', { name: 'Second beat', exact: true }).click();
    await page.getByRole('button', { name: 'New ball', exact: true }).click();
    await page.getByRole('button', { name: 'Design', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Fillのカラーコード', exact: true })).toHaveValue('EF8078');
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(page.getByText('共同編集者が使っている 1 個の新しい場面と、そのオブジェクト・動きを保持しました。', { exact: true })).toBeVisible();
    expect(room.scene().compositionOrder).toEqual([firstId, secondId]);
    expect(room.scene().compositions[secondId].states[ball].fill).toBe('#ef8078');
    expect(Object.values(room.scene().transitions)[0].tracks[ball].duration).toBe(1200);
    expect(parseProjectFile(JSON.stringify(readProject(room.doc)))).toEqual(readProject(room.doc));
  } finally { room.close(); await peerContext.close(); }
});

test('a copied source changed by a peer invalidates the whole proposal without creating partial scenes', async ({ page }) => {
  const room = await open(page, true);
  try {
    await request(page);
    applyChanges(room.doc, [{ path: ['scenes', sceneId, 'compositions', firstId, 'states', 'original', 'x'], value: 333 }], 'peer');
    await page.getByRole('button', { name: 'Original circle', exact: true }).click();
    await page.getByRole('button', { name: 'Design', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('333');
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Apply edits', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('変更されました');
    expect(room.scene().compositionOrder).toEqual([firstId]);
    expect(Object.keys(room.scene().objects)).toEqual(['original']);
    expect(Object.keys(room.scene().transitions)).toEqual([]);
  } finally { room.close(); }
});
