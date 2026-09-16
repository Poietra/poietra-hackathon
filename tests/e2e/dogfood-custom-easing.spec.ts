import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { applyChanges, readProject } from '../../shared/document';

const curve = { type: 'cubicBezier' as const, x1: 0, y1: 0, x2: 0, y2: 1 };

async function fixture(page: Page) {
  const room = crypto.randomUUID();
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', synced => { if (synced) resolve(); }));
  return { room, doc, track: () => readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle, close: () => { provider.destroy(); doc.destroy(); } };
}
async function select(page: Page) {
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
}
async function number(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value)); await input.press('Tab');
}
async function custom(page: Page, label: string) {
  await page.getByRole('combobox', { name: label, exact: true }).selectOption({ label: 'Custom Bézier' });
  for (const [key, value] of Object.entries(curve)) if (key !== 'type') await number(page, `${label} ${key.toUpperCase()}`, value as number);
}
const undo = (page: Page) => page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();

test('custom easing changes the rendered motion and independent opacity, then survives save and import', async ({ page }, info) => {
  test.setTimeout(60000);
  const room = await fixture(page);
  try {
    applyChanges(room.doc, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-2', 'states', 'circle', 'opacity'], value: .2 }], 'fixture');
    await select(page); await custom(page, 'Easing');
    await expect.poll(() => room.track().easing).toEqual(curve);
    const rendered = page.locator('[data-testid="stage-to"] .scene-hit-svg [data-object-id="circle"]');
    const preview = page.getByRole('slider', { name: 'Transition preview position', exact: true });
    // x(t)=t^3; at time 1/8, t=1/2 and y(t)=1/2. The spatial path also reaches its midpoint.
    await preview.fill('75');
    await expect(rendered).toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
    await expect(rendered).toHaveAttribute('opacity', '0.6');
    await page.getByRole('combobox', { name: 'Easing', exact: true }).selectOption('linear');
    await page.getByRole('combobox', { name: 'Animation property', exact: true }).selectOption('opacity');
    await custom(page, 'Opacity animation easing');
    await expect.poll(() => room.track().opacityTiming?.easing).toEqual(curve);
    await expect(rendered).toHaveAttribute('opacity', '0.6');
    await expect(rendered).not.toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
    await custom(page, 'Easing');
    await page.screenshot({ path: info.outputPath('custom-easing.png') });
    await page.setViewportSize({ width: 1100, height: 800 });
    const field = page.getByRole('spinbutton', { name: 'Easing X1', exact: true });
    await field.scrollIntoViewIfNeeded(); await expect(field).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('custom-easing-narrow.png') });
    await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    const saved = await download; const file = info.outputPath('custom-easing.poietra.json'); await saved.saveAs(file);
    const data = await readFile(file);
    expect(JSON.parse(data.toString()).scenes['scene-1'].transitions['transition-1'].tracks.circle).toMatchObject({ easing: curve, opacityTiming: { easing: curve } });
    await page.getByLabel('プロジェクトファイル', { exact: true }).setInputFiles({ name: 'custom-easing.poietra.json', mimeType: 'application/json', buffer: data });
    await expect(page).not.toHaveURL(new RegExp(room.room));
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await select(page);
    await expect(page.getByRole('spinbutton', { name: 'Easing X1', exact: true })).toHaveValue('0');
    await preview.fill('75');
    await expect(rendered).toHaveAttribute('transform', 'translate(588.75 355) rotate(0)');
    await expect(rendered).toHaveAttribute('opacity', '0.6');
  } finally { room.close(); }
});

test('a curve drag syncs, is one undo, cancels safely, and preserves a peer timing edit', async ({ browser }) => {
  const alice = await browser.newPage(), bob = await browser.newPage();
  const room = await fixture(alice);
  try {
    await select(alice); await custom(alice, 'Easing');
    await bob.goto(alice.url()); await expect(bob.getByText('Live', { exact: true })).toBeVisible(); await select(bob);
    await expect(bob.getByRole('spinbutton', { name: 'Easing X1', exact: true })).toHaveValue('0');
    const handle = alice.locator('[aria-label="Easing control point 1"]');
    async function drag() {
      await handle.scrollIntoViewIfNeeded(); const box = (await handle.boundingBox())!;
      await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await alice.mouse.down();
      await alice.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 - 30, { steps: 6 });
    }
    await drag(); await alice.mouse.up();
    await expect.poll(() => room.track().easing).not.toEqual(curve);
    await expect(bob.getByRole('spinbutton', { name: 'Easing X1', exact: true })).not.toHaveValue('0');
    await number(bob, 'Animation duration', 500);
    await expect.poll(() => room.track().duration).toBe(500);
    await undo(alice);
    await expect.poll(() => room.track().easing).toEqual(curve);
    expect(room.track().duration).toBe(500);
    for (const cancel of ['Escape', 'pointercancel']) {
      await drag(); await expect.poll(() => room.track().easing).not.toEqual(curve);
      if (cancel === 'Escape') await alice.keyboard.press('Escape');
      else await handle.dispatchEvent('pointercancel', { pointerId: 1 });
      await alice.mouse.up();
      await expect.poll(() => room.track().easing).toEqual(curve);
    }
    applyChanges(room.doc, [{ path: ['scenes', 'scene-1', 'objects', 'circle', 'locked'], value: true }], 'peer');
    await expect(alice.getByRole('combobox', { name: 'Easing', exact: true })).toBeDisabled();
    await expect(alice.getByRole('spinbutton', { name: 'Easing X1', exact: true })).toBeDisabled();
  } finally { room.close(); await alice.close(); await bob.close(); }
});

test('multiple selected objects share custom curves without displaying Mixed and Cut disables easing', async ({ page }) => {
  const room = await fixture(page);
  try {
    await select(page);
    await page.getByRole('button', { name: 'Equation', exact: true }).click({ modifiers: ['Shift'] });
    await custom(page, 'Selected animation easing');
    await expect(page.getByRole('combobox', { name: 'Selected animation easing', exact: true })).toHaveValue('custom');
    await expect.poll(() => room.track().easing).toEqual(curve);
    expect(readProject(room.doc)!.scenes['scene-1'].transitions['transition-1'].tracks.equation.easing).toEqual(curve);
    await page.getByRole('button', { name: 'Circle', exact: true }).click();
    await page.getByRole('combobox', { name: 'Animation type', exact: true }).selectOption('none');
    await expect(page.getByRole('combobox', { name: 'Easing', exact: true })).toBeDisabled();
    await expect(page.getByRole('spinbutton', { name: 'Easing X1', exact: true })).toBeDisabled();
    expect(room.track().easing).toEqual(curve);
  } finally { room.close(); }
});

for (const replacement of ['preset', 'custom'] as const) test(`cancelling a drag after a peer ${replacement} replacement never undoes an earlier edit`, async ({ page }) => {
  const room = await fixture(page);
  try {
    await select(page); await custom(page, 'Easing');
    const name = page.getByRole('textbox', { name: 'Project name', exact: true });
    await name.fill('Keep my earlier edit'); await name.press('Tab');
    await expect.poll(() => readProject(room.doc)!.name).toBe('Keep my earlier edit');
    const handle = page.getByRole('button', { name: 'Easing control point 1', exact: true });
    await handle.scrollIntoViewIfNeeded(); const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 25, { steps: 4 });
    await expect.poll(() => room.track().easing).not.toEqual(curve);
    const peerCurve = replacement === 'preset' ? 'linear' : { ...curve, x1: .9, y1: .3 };
    applyChanges(room.doc, [{ path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', 'circle', 'easing'], value: peerCurve }], 'peer');
    if (replacement === 'preset') await expect(handle).toHaveCount(0);
    else { await expect(page.getByRole('spinbutton', { name: 'Easing X1', exact: true })).toHaveValue('0.9'); await page.keyboard.press('Escape'); }
    await page.mouse.up();
    await expect(name).toHaveValue('Keep my earlier edit');
    expect(room.track().easing).toEqual(peerCurve);
    await undo(page);
    await expect(name).toHaveValue('A little motion');
    expect(room.track().easing).toEqual(peerCurve);
  } finally { room.close(); }
});

test('cancelling the first independent curve drag preserves a peer edit to the new property timing', async ({ page }) => {
  const room = await fixture(page);
  try {
    await select(page); await custom(page, 'Easing');
    await page.getByRole('combobox', { name: 'Animation property', exact: true }).selectOption('opacity');
    expect(room.track().opacityTiming).toBeUndefined();
    const handle = page.getByRole('button', { name: 'Opacity animation easing control point 1', exact: true });
    await handle.scrollIntoViewIfNeeded(); const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 25, { steps: 4 });
    await expect.poll(() => room.track().opacityTiming?.duration).toBe(600);
    applyChanges(room.doc, [{ path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', 'circle', 'opacityTiming', 'duration'], value: 300 }], 'peer');
    await expect(page.getByRole('spinbutton', { name: 'Opacity animation duration', exact: true })).toHaveValue('300');
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.getByRole('spinbutton', { name: 'Opacity animation duration', exact: true })).toHaveValue('300');
    expect(room.track().opacityTiming?.duration).toBe(300);
    expect(room.track().easing).toEqual(curve);
  } finally { room.close(); }
});
