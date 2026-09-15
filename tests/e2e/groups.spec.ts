import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { applyChanges, readProject } from '../../shared/document';
import { defaultTrack } from '../../shared/model';

async function fixture(page: Page) {
  const room = crypto.randomUUID(); await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const doc = new Y.Doc();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', (synced: boolean) => { if (synced) resolve(); }));
  const scene = readProject(doc)!.scenes['scene-1'];
  // A second editable member starts with a translated, distinct Bézier and individual timing.
  applyChanges(doc, [
    { path: ['scenes', scene.id, 'objects', 'second'], value: { ...scene.objects.circle, id: 'second', name: 'Second circle', order: 4 } },
    ...Object.values(scene.compositions).map(comp => ({ path: ['scenes', scene.id, 'compositions', comp.id, 'states', 'second'], value: { ...structuredClone(comp.states.circle), x: comp.states.circle.x + 140, y: comp.states.circle.y - 80 } })),
    { path: ['scenes', scene.id, 'transitions', 'transition-1', 'tracks', 'second'], value: defaultTrack('second', { type: 'fade', start: 100, duration: 500, easing: 'linear', order: 'sequential', path: { c1: { x: 645, y: 440 }, c2: { x: 805, y: 110 } } }) },
  ], 'fixture');
  await expect(page.getByRole('button', { name: 'Second circle', exact: true })).toBeVisible();
  return { room, doc, scene: () => readProject(doc)!.scenes['scene-1'], close: () => { provider.destroy(); doc.destroy(); } };
}
async function chooseMembers(page: Page) {
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Second circle', exact: true }).click({ modifiers: ['Shift'] });
}
async function anchor(page: Page, id: string, prefix = 'main') {
  const transform = await page.locator(`[data-testid="stage-${prefix}"] .scene-svg [data-object-id="${id}"]`).getAttribute('transform');
  const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform || '');
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}
async function drag(page: Page, id: string, dx: number, dy: number) {
  const surface = (await page.getByTestId('stage-main').boundingBox())!;
  const before = await anchor(page, id); const scale = surface.width / 1280;
  await page.mouse.move(surface.x + before.x * scale, surface.y + before.y * scale);
  await page.mouse.down(); await page.mouse.move(surface.x + (before.x + dx) * scale, surface.y + (before.y + dy) * scale, { steps: 8 }); await page.mouse.up();
}
async function timing(page: Page, label: string, value: string) { const input = page.getByRole('spinbutton', { name: label, exact: true }); await input.fill(value); await input.press('Tab'); }

test('two browsers group, drag together, set common timing, preview, ungroup and undo without losing individual curves', async ({ browser }, testInfo) => {
  const first = await browser.newContext({ viewport: { width: 1715, height: 1050 } }), second = await browser.newContext({ viewport: { width: 1715, height: 1050 } });
  const alice = await first.newPage(), bob = await second.newPage(); const room = await fixture(alice);
  try {
    await bob.goto(`/?room=${room.room}`); await expect(bob.getByText('Live', { exact: true })).toBeVisible();
    const before = structuredClone(room.scene());
    await chooseMembers(alice); await alice.getByRole('button', { name: 'Group', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Select group: Circle, Second circle', exact: true }).first()).toBeVisible();
    const groupId = room.scene().objects.circle.groupId; expect(groupId).toBeTruthy();
    expect(room.scene().objects.second.groupId).toBe(groupId);
    await alice.getByRole('button', { name: 'Circle', exact: true }).click();
    await expect(alice.getByRole('spinbutton', { name: 'Position X', exact: true })).toBeVisible();
    await drag(alice, 'circle', 60, -40);
    await expect.poll(async () => (await anchor(bob, 'circle')).x).toBeCloseTo(305, 2);
    await expect.poll(async () => (await anchor(bob, 'second')).x).toBeCloseTo(445, 2);
    expect((await anchor(bob, 'second')).y - (await anchor(bob, 'circle')).y).toBeCloseTo(-80, 2);
    await alice.getByRole('button', { name: 'Select group: Circle, Second circle', exact: true }).first().click();
    await expect(alice.locator('.layer-selection-summary')).toContainText('2 selected');
    await alice.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await expect(alice.getByRole('list', { name: 'Animation targets', exact: true })).toContainText('Circle');
    await expect(alice.getByRole('list', { name: 'Animation targets', exact: true })).toContainText('Second circle');
    await timing(alice, 'Selected animation duration', '500');
    await timing(alice, 'Selected animation start', '100');
    await alice.getByRole('combobox', { name: 'Selected animation easing', exact: true }).selectOption('linear');
    await alice.getByRole('button', { name: 'Apply Move', exact: true }).click();
    await expect.poll(() => room.scene().transitions['transition-1'].tracks.second.type).toBe('move');
    for (const id of ['circle', 'second']) {
      expect(room.scene().transitions['transition-1'].tracks[id]).toEqual({ ...before.transitions['transition-1'].tracks[id], type: 'move', start: 100, duration: 500, easing: 'linear' });
    }
    expect(room.scene().transitions['transition-1'].tracks.equation).toEqual(before.transitions['transition-1'].tracks.equation);
    await alice.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('350');
    await bob.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await bob.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('350');
    await expect.poll(async () => (await anchor(bob, 'second', 'to')).x - (await anchor(bob, 'circle', 'to')).x).toBeCloseTo(140, 2);
    expect((await anchor(bob, 'second', 'to')).y - (await anchor(bob, 'circle', 'to')).y).toBeCloseTo(-80, 2);
    await alice.screenshot({ path: testInfo.outputPath('group-animation-preview.png'), fullPage: true });
    await alice.getByRole('button', { name: 'Ungroup', exact: true }).click();
    await expect(bob.locator('[data-group-id]')).toHaveCount(0);
    await alice.getByRole('button', { name: 'Composition 1', exact: true }).click();
    await alice.getByRole('button', { name: 'Circle', exact: true }).click();
    const secondBefore = await anchor(alice, 'second'); await drag(alice, 'circle', 30, 0);
    expect(await anchor(alice, 'second')).toEqual(secondBefore);
    await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await alice.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(bob.getByRole('button', { name: 'Select group: Circle, Second circle', exact: true }).first()).toBeVisible();
    expect(room.scene().objects.circle.groupId).toBe(groupId); expect(room.scene().objects.second.groupId).toBe(groupId);
    expect(room.scene().transitions['transition-1'].tracks.circle.duration).toBe(500);
  } finally { room.close(); await first.close(); await second.close(); }
});

test('group controls share keyboard semantics, distinguish members, and preserve layer paint order', async ({ page }) => {
  const room = await fixture(page);
  try {
    await chooseMembers(page); await page.keyboard.press('Control+g');
    await expect(page.getByRole('button', { name: 'Select group: Circle, Second circle', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Second circle', exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('385');
    await page.getByRole('button', { name: 'Select group · 2', exact: true }).click();
    await expect(page.locator('.layer-row.selected')).toHaveCount(2);
    await page.getByRole('button', { name: 'Ungroup', exact: true }).click();
    await expect(page.locator('[data-group-id]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await page.keyboard.press('Control+Shift+g');
    await expect(page.locator('[data-group-id]')).toHaveCount(0);
    await expect.poll(() => [room.scene().objects.circle.groupId, room.scene().objects.second.groupId]).toEqual([null, null]);
    expect(await page.locator('.layer-tree [data-layer-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-layer-id')))).toEqual(['second', 'equation', 'circle', 'sigmoid']);
  } finally { room.close(); }
});

test('common fields apply to explicit unlocked visible targets and add a missing track without changing excluded animation', async ({ page }) => {
  const room = await fixture(page);
  try {
    const before = structuredClone(room.scene());
    await page.getByRole('button', { name: 'Second circle をロック', exact: true }).click();
    await chooseMembers(page);
    await page.getByRole('button', { name: 'Equation', exact: true }).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Sigmoid path', exact: true }).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Animation targets', exact: true })).toContainText('Sigmoid path');
    await expect(page.getByRole('list', { name: 'Excluded animation targets', exact: true })).toContainText('ロック中');
    await expect(page.getByRole('list', { name: 'Excluded animation targets', exact: true })).toContainText('片側のみ表示');
    await timing(page, 'Selected animation duration', '400'); await timing(page, 'Selected animation start', '100');
    await page.getByRole('combobox', { name: 'Selected animation easing', exact: true }).selectOption('easeOut');
    await expect.poll(() => room.scene().transitions['transition-1'].tracks.sigmoid?.easing).toBe('easeOut');
    const tracks = room.scene().transitions['transition-1'].tracks;
    expect(tracks.sigmoid).toEqual(defaultTrack('sigmoid', { start: 100, duration: 400, easing: 'easeOut' }));
    expect(tracks.second).toEqual(before.transitions['transition-1'].tracks.second);
    expect(tracks.equation).toEqual(before.transitions['transition-1'].tracks.equation);
    expect(tracks.circle).toEqual({ ...before.transitions['transition-1'].tracks.circle, start: 100, duration: 400, easing: 'easeOut' });
    expect(room.scene().compositions).toEqual(before.compositions);
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect.poll(() => room.scene().transitions['transition-1'].tracks.circle.easing).toBe('easeInOut');
    expect(room.scene().transitions['transition-1'].tracks.sigmoid.easing).toBe('easeInOut');
  } finally { room.close(); }
});
