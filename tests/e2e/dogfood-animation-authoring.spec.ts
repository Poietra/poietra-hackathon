import { expect, test, type Locator, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { applyChanges, readProject } from '../../shared/document';

async function blank(page: Page) {
  const room = crypto.randomUUID();
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByTestId('stage-main')).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(); const provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', synced => { if (synced) resolve(); }));
  await page.locator('.new-scene-button').click();
  await expect.poll(() => readProject(doc)?.sceneOrder.length).toBe(2);
  const id = readProject(doc)!.sceneOrder[1];
  return { doc, id, scene: () => readProject(doc)!.scenes[id], close: () => { provider.destroy(); doc.destroy(); } };
}
async function create(page: Page, kind: 'text' | 'circle', x: number, y: number, text = '') {
  await page.getByRole('button', { name: kind === 'text' ? 'テキスト (T)' : '円 (O)', exact: true }).click();
  const box = (await page.getByTestId('stage-main').boundingBox())!;
  await page.mouse.click(box.x + x / 1280 * box.width, box.y + y / 720 * box.height);
  if (kind === 'text') { const input = page.getByRole('textbox', { name: 'Text content', exact: true }); await input.fill(text); await input.press('Tab'); }
  return (await page.locator('.layer-row.selected').getAttribute('data-layer-id'))!;
}
async function field(page: Page, name: string, value: number) { const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab'); }
async function members(page: Page, ids: string[]) {
  for (const [index, id] of ids.entries()) await page.locator(`[data-layer-id="${id}"] .layer-select`).click(index ? { modifiers: ['Shift'] } : {});
}
async function dragTiming(page: Page, row: Locator, amount: number, edge?: 'start' | 'end') {
  const target = edge ? row.locator(`[data-edge="${edge}"]`) : row.locator('.animation-bar');
  const box = (await target.boundingBox())!, lane = (await row.locator('.track-lane').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + lane.width * amount / 800, box.y + box.height / 2, { steps: 5 });
}
const undo = (page: Page) => page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();

test('created objects have editable automatic motion; timing materializes once, cancels cleanly, and preserves peer changes on undo', async ({ page }) => {
  const room = await blank(page);
  try {
    const circle = await create(page, 'circle', 280, 230);
    const title = await create(page, 'text', 600, 420, '一緒につくる動画');
    await page.locator('.composition-strip .add-composition').click();
    await members(page, [circle]); await field(page, 'Position X', 900);
    await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    const transitionId = Object.keys(room.scene().transitions)[0];
    const track = () => room.scene().transitions[transitionId].tracks[circle];
    const row = page.locator(`[data-track-object-id="${circle}"]`);
    await expect(page.locator('.track-row')).toHaveCount(2);
    await expect(row.locator('.animation-bar')).toHaveAttribute('aria-label', 'Circle 1 Move: 0–800 ms');
    expect(room.scene().transitions[transitionId].tracks).toEqual({});
    await row.locator('.track-label').click();
    expect(track()).toBeUndefined(); // Selecting and seeking never materialize shared data.
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('400');
    await expect(page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${circle}"]`)).toHaveAttribute('transform', 'translate(590 230) rotate(0)');
    expect(track()).toBeUndefined();

    await dragTiming(page, row, -400, 'end'); await page.mouse.up();
    await expect.poll(() => track()?.duration).toBe(400);
    await dragTiming(page, row, 100); await page.mouse.up();
    await expect.poll(() => track()?.start).toBe(100);
    const destination = room.scene().compositionOrder[1];
    applyChanges(room.doc, [{ path: ['scenes', room.id, 'compositions', destination, 'states', circle, 'fill'], value: '#f4ce55' }], 'peer');
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('600');
    await expect(page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${circle}"]`)).toHaveAttribute('fill', '#f4ce55');
    await undo(page); await expect.poll(() => track()?.start).toBe(0);
    expect(track().duration).toBe(400);
    await undo(page); await expect.poll(() => track()).toBeUndefined();
    await expect(row.locator('.animation-bar')).toHaveAttribute('aria-label', 'Circle 1 Move: 0–800 ms');
    expect(room.scene().compositions[destination].states[circle]).toMatchObject({ x: 900, fill: '#f4ce55' });

    for (const reason of ['Escape', 'pointercancel'] as const) {
      await dragTiming(page, row, -200, 'end'); await expect.poll(() => track()?.duration).toBe(600);
      if (reason === 'Escape') await page.keyboard.press('Escape');
      else await row.locator('.animation-bar').dispatchEvent('pointercancel', { pointerId: 1 });
      await page.mouse.up(); await expect.poll(() => track()).toBeUndefined();
    }
    // Pointer focus commits the numeric draft before capturing the gesture baseline.
    await page.getByRole('spinbutton', { name: 'Animation duration', exact: true }).fill('500');
    await dragTiming(page, row, -100, 'end'); await page.mouse.up();
    await expect.poll(() => track()?.duration).toBe(400);
    await undo(page); await expect.poll(() => track()?.duration).toBe(500);
    await undo(page); await expect.poll(() => track()).toBeUndefined();
    applyChanges(room.doc, [{ path: ['scenes', room.id, 'objects', circle, 'locked'], value: true }], 'peer');
    await expect(row.locator('.animation-bar')).toHaveAttribute('aria-disabled', 'true');
    await dragTiming(page, row, -200, 'end'); await page.mouse.up(); expect(track()).toBeUndefined();
    applyChanges(room.doc, room.scene().compositionOrder.map(id => ({ path: ['scenes', room.id, 'compositions', id, 'states', title, 'visible'], value: false })), 'peer');
    await expect(page.locator('.track-row')).toHaveCount(1);
  } finally { room.close(); }
});

test('multiple Japanese titles can enter and exit together with Write order and shared timing, one undo, and peer synchronization', async ({ page }, testInfo) => {
  const room = await blank(page);
  try {
    await page.locator('.composition-strip .add-composition').click();
    const first = await create(page, 'text', 430, 270, '最初の字幕');
    const second = await create(page, 'text', 730, 430, '次の字幕');
    const ids = [first, second];
    await members(page, ids);
    await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
    const transitionId = Object.keys(room.scene().transitions)[0];
    const tracks = () => room.scene().transitions[transitionId].tracks;
    await expect(page.getByRole('list', { name: 'Animation targets', exact: true })).toContainText('Enter · Move');
    await expect(page.getByRole('list', { name: 'Animation targets', exact: true }).locator('li')).toHaveCount(2);
    const type = page.getByRole('combobox', { name: 'Selected animation type', exact: true });
    await type.selectOption('write');
    await expect.poll(() => ids.map(id => tracks()[id]?.type)).toEqual(['write', 'write']);
    await undo(page); await expect.poll(() => Object.keys(tracks())).toEqual([]);
    await type.selectOption('write');
    await page.getByRole('combobox', { name: 'Selected Write order', exact: true }).selectOption('sequential');
    await field(page, 'Selected animation duration', 400); await field(page, 'Selected animation start', 200);
    await page.getByRole('combobox', { name: 'Selected animation easing', exact: true }).selectOption('linear');
    await expect.poll(() => ids.map(id => tracks()[id])).toEqual(ids.map(objectId => ({ objectId, type: 'write', start: 200, duration: 400, easing: 'linear', order: 'sequential', path: null })));
    const fromId = room.scene().compositionOrder[0], toId = room.scene().compositionOrder[1];
    expect(ids.map(id => [room.scene().compositions[fromId].states[id].visible, room.scene().compositions[toId].states[id].visible])).toEqual([[false, true], [false, true]]);
    applyChanges(room.doc, [{ path: ['scenes', room.id, 'compositions', toId, 'states', first, 'fill'], value: '#f4ce55' }], 'peer');
    await page.getByRole('slider', { name: 'Transition preview position', exact: true }).fill('400');
    for (const id of ids) await expect(page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${id}"]`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('multiple-title-enter.png') });
    await undo(page); await expect.poll(() => ids.map(id => tracks()[id].easing)).toEqual(['easeInOut', 'easeInOut']);
    expect(room.scene().compositions[toId].states[first].fill).toBe('#f4ce55');

    await page.getByRole('button', { name: 'Composition 2', exact: true }).click();
    await page.locator('.composition-strip .add-composition').click();
    await members(page, ids);
    await page.getByRole('button', { name: 'Hide in this composition', exact: true }).click();
    await members(page, ids);
    await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).last().click();
    const exitId = Object.values(room.scene().transitions).find(t => t.fromId === toId)!.id;
    await expect(page.getByRole('list', { name: 'Animation targets', exact: true })).toContainText('Exit · Move');
    for (const animation of ['grow', 'fade', 'write']) {
      await type.selectOption(animation);
      await expect.poll(() => ids.map(id => room.scene().transitions[exitId].tracks[id]?.type)).toEqual([animation, animation]);
    }
    await undo(page); await expect.poll(() => ids.map(id => room.scene().transitions[exitId].tracks[id].type)).toEqual(['fade', 'fade']);
    expect(ids.map(id => room.scene().compositions[toId].states[id].text)).toEqual(['最初の字幕', '次の字幕']);
    applyChanges(room.doc, [{ path: ['scenes', room.id, 'objects', second, 'locked'], value: true }], 'peer');
    await expect(page.getByRole('list', { name: 'Excluded animation targets', exact: true })).toContainText('ロック中');
    await type.selectOption('grow');
    await expect.poll(() => ids.map(id => room.scene().transitions[exitId].tracks[id].type)).toEqual(['grow', 'fade']);
  } finally { room.close(); }
});
