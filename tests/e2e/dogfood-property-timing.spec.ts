import { expect, test, type Locator, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { applyChanges, readProject } from '../../shared/document';

async function field(page: Page, label: string, value: number) {
  const input = page.getByRole('spinbutton', { name: label, exact: true });
  await input.fill(String(value)); await input.press('Tab');
}

async function setup(page: Page) {
  const room = crypto.randomUUID();
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', synced => { if (synced) resolve(); }));
  await page.locator('.new-scene-button').click();
  await expect.poll(() => readProject(doc)?.sceneOrder.length).toBe(2);
  const sceneId = readProject(doc)!.sceneOrder[1];
  const scene = () => readProject(doc)!.scenes[sceneId];
  await page.getByRole('button', { name: '円 (O)', exact: true }).click();
  const box = (await page.getByTestId('stage-main').boundingBox())!;
  await page.mouse.click(box.x + box.width * 200 / 1280, box.y + box.height / 3);
  const objectId = (await page.locator('.layer-row.selected').getAttribute('data-layer-id'))!;
  await field(page, 'Position X', 200);
  await page.locator('.composition-strip .add-composition').click();
  await page.locator(`[data-layer-id="${objectId}"] .layer-select`).click();
  await field(page, 'Position X', 1000); await field(page, 'Opacity', 20);
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await field(page, 'Transition duration', 2000);
  const transitionId = Object.keys(scene().transitions)[0];
  const track = () => scene().transitions[transitionId].tracks[objectId];
  return { doc, sceneId, scene, objectId, transitionId, track, close: () => { provider.destroy(); doc.destroy(); } };
}

async function property(page: Page, channel: string, label: string, duration: number) {
  await page.getByRole('combobox', { name: 'Animation property', exact: true }).selectOption(channel);
  await field(page, `${label} animation duration`, duration);
  await page.getByRole('combobox', { name: `${label} animation easing`, exact: true }).selectOption('linear');
}

async function drag(page: Page, row: Locator, delta: number, edge?: 'start' | 'end') {
  const bar = row.locator('.animation-bar'); await bar.scrollIntoViewIfNeeded();
  const target = edge ? row.locator(`[data-edge="${edge}"]`) : bar;
  const box = (await target.boundingBox())!, lane = (await row.locator('.track-lane').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + lane.width * delta / 2000, box.y + box.height / 2, { steps: 5 });
}

const undo = (page: Page) => page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();

test('a custom object moves over two seconds while opacity finishes in 300 ms; reset and undo restore inherited timing', async ({ page }, info) => {
  const room = await setup(page);
  try {
    await property(page, 'position', 'Position', 2000);
    await property(page, 'opacity', 'Opacity', 300);
    await expect.poll(() => room.track().positionTiming).toEqual({ start: 0, duration: 2000, easing: 'linear' });
    await expect.poll(() => room.track().opacityTiming).toEqual({ start: 0, duration: 300, easing: 'linear' });
    const opacityRow = page.locator(`[data-property-object-id="${room.objectId}"][data-property-channel="opacity"]`);
    await expect(opacityRow.locator('.animation-bar')).toHaveAttribute('aria-label', 'Circle 1 Opacity: 0–300 ms');
    const preview = page.getByRole('slider', { name: 'Transition preview position', exact: true });
    const rendered = page.locator(`[data-testid="stage-to"] .scene-svg [data-object-id="${room.objectId}"]`);
    await preview.fill('300');
    await expect(rendered).toHaveAttribute('transform', 'translate(320 240) rotate(0)');
    await expect(rendered).toHaveAttribute('opacity', '0.2');
    await preview.fill('1000');
    await expect(rendered).toHaveAttribute('transform', 'translate(600 240) rotate(0)');
    await expect(rendered).toHaveAttribute('opacity', '0.2');
    await expect(opacityRow).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('independent-position-opacity.png') });
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(opacityRow).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'プロジェクトを開く', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('independent-position-opacity-narrow.png') });
    await page.setViewportSize({ width: 1440, height: 900 });

    await field(page, 'Animation duration', 1500);
    await expect.poll(() => room.track().duration).toBe(1500);
    expect(room.track().positionTiming?.duration).toBe(2000);
    expect(room.track().opacityTiming?.duration).toBe(300);
    await page.getByRole('button', { name: '共通の時間に戻す', exact: true }).click();
    await expect(opacityRow).toHaveCount(0);
    await expect(page.getByRole('spinbutton', { name: 'Opacity animation duration', exact: true })).toHaveValue('1500');
    await undo(page);
    await expect(opacityRow).toHaveCount(1);
    await expect.poll(() => room.track().opacityTiming?.duration).toBe(300);

    const base = ['scenes', room.sceneId, 'transitions', room.transitionId, 'tracks', room.objectId];
    applyChanges(room.doc, [{ path: [...base, 'positionTiming', 'duration'], value: 1600 }], 'peer');
    await expect(page.locator(`[data-property-channel="position"] .animation-bar`)).toHaveAttribute('aria-label', 'Circle 1 Position: 0–1,600 ms');
    await undo(page); // Base duration only: the peer's independent timing remains.
    await expect.poll(() => room.track().implicit).toBe(true);
    await expect(page.getByRole('spinbutton', { name: 'Animation duration', exact: true })).toHaveValue('2000');
    expect(room.track().positionTiming?.duration).toBe(1600);
  } finally { room.close(); }
});

test('property bars move and trim independently, cancel safely, preserve peer channels, and respect locks', async ({ page }) => {
  const room = await setup(page);
  try {
    await property(page, 'position', 'Position', 2000);
    await property(page, 'opacity', 'Opacity', 300);
    const opacity = page.locator(`[data-property-object-id="${room.objectId}"][data-property-channel="opacity"]`);
    await drag(page, opacity, 200); await page.mouse.up();
    await expect.poll(() => room.track().opacityTiming?.start).toBe(200);
    await drag(page, opacity, 200, 'end'); await page.mouse.up();
    await expect.poll(() => room.track().opacityTiming?.duration).toBe(500);
    const base = ['scenes', room.sceneId, 'transitions', room.transitionId, 'tracks', room.objectId];
    applyChanges(room.doc, [{ path: [...base, 'positionTiming', 'duration'], value: 1800 }], 'peer');
    await undo(page);
    await expect.poll(() => room.track().opacityTiming?.duration).toBe(300);
    expect(room.track().positionTiming?.duration).toBe(1800);
    for (const cancellation of ['Escape', 'pointercancel']) {
      await drag(page, opacity, 100);
      await expect.poll(() => room.track().opacityTiming?.start).toBe(300);
      if (cancellation === 'Escape') await page.keyboard.press('Escape');
      else await opacity.locator('.animation-bar').dispatchEvent('pointercancel', { pointerId: 1 });
      await page.mouse.up();
      await expect.poll(() => room.track().opacityTiming?.start).toBe(200);
    }
    // A pending numeric edit commits before the pointer gesture reads its baseline.
    await page.getByRole('spinbutton', { name: 'Opacity animation duration', exact: true }).fill('500');
    await drag(page, opacity, 100, 'end'); await page.mouse.up();
    await expect.poll(() => room.track().opacityTiming?.duration).toBe(600);
    await undo(page); await expect.poll(() => room.track().opacityTiming?.duration).toBe(500);
    applyChanges(room.doc, [{ path: ['scenes', room.sceneId, 'objects', room.objectId, 'locked'], value: true }], 'peer');
    await expect(opacity.locator('.animation-bar')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('spinbutton', { name: 'Opacity animation duration', exact: true })).toBeDisabled();
    await drag(page, opacity, 100); await page.mouse.up();
    expect(room.track().opacityTiming?.start).toBe(200);
    expect(room.track().opacityTiming?.duration).toBe(500);
  } finally { room.close(); }
});
