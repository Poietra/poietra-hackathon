import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { applyChanges, readProject } from '../../shared/document';
import { makeBlankScene } from '../../shared/demo';
import { defaultState, type Project } from '../../shared/model';

const execute = promisify(execFile);
async function open(page: Page, project: Project) {
  const room = crypto.randomUUID(); await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', synced => { if (synced) resolve(); }));
  applyChanges(doc, Object.entries(project).map(([key, value]) => ({ path: [key], value })), 'fixture');
  await expect(page.getByRole('tab', { name: project.scenes[project.sceneOrder[0]].name, exact: true })).toBeVisible();
  await expect(page.getByTestId('stage-main')).toBeVisible();
  return { doc, project: () => readProject(doc)!, close: () => { provider.destroy(); doc.destroy(); } };
}
function blankProject(): Project {
  const scene = makeBlankScene('opening', 'Opening'); scene.width = 640; scene.height = 360;
  scene.compositions[scene.compositionOrder[0]].duration = 400;
  return { version: 1, name: 'Our film', sceneOrder: [scene.id], scenes: { [scene.id]: scene } };
}
async function field(page: Page, name: string, value: number) { const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(String(value)); await input.press('Tab'); }
async function clickScenePoint(page: Page, x: number, y: number, width = 640, height = 360) {
  const box = (await page.getByTestId('stage-main').boundingBox())!;
  await page.mouse.click(box.x + x / width * box.width, box.y + y / height * box.height);
}
async function preview(page: Page) { await page.getByRole('button', { name: 'Preview project', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Project preview', exact: true })).toBeVisible(); }

test('authored Scenes play across exact boundaries, return to the right edit target, and reorder without undoing a peer edit', async ({ page }, testInfo) => {
  const room = await open(page, blankProject()); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('button', { name: '円 (O)', exact: true }).click(); await clickScenePoint(page, 140, 180);
    const circle = (await page.locator('.layer-row.selected').getAttribute('data-layer-id'))!;
    await page.getByRole('button', { name: '色 #f4ce55', exact: true }).click();
    await page.locator('.composition-strip .add-composition').click(); await field(page, 'Position X', 500);
    await clickScenePoint(page, 20, 20); await field(page, 'Composition duration', 400);
    const opening = room.project().scenes.opening;
    const transition = Object.values(opening.transitions)[0];
    await page.locator('.new-scene-button').click();
    await expect.poll(() => room.project().sceneOrder.length).toBe(2);
    const secondId = room.project().sceneOrder[1];
    await page.getByRole('button', { name: '四角形 (R)', exact: true }).click(); await clickScenePoint(page, 640, 360, 1280, 720);
    await page.getByRole('button', { name: '色 #67c4d9', exact: true }).click();
    await clickScenePoint(page, 20, 20, 1280, 720); await field(page, 'Composition duration', 2000);
    const background = page.getByRole('textbox', { name: 'Backgroundのカラーコード', exact: true }); await background.fill('123A55'); await background.press('Tab');
    await preview(page);
    const slider = page.getByRole('slider', { name: 'Project preview position', exact: true });
    const frame = page.getByTestId('project-preview-frame');
    await expect(slider).toHaveAttribute('max', '3600');
    await expect(page.locator('.project-preview-scenes button')).toHaveText(['Opening1.60 s', 'Scene 22.00 s']);
    await expect(frame).toHaveAttribute('data-scene-id', 'opening');
    await slider.fill('1599'); await expect(frame).toHaveAttribute('data-scene-id', 'opening');
    await slider.fill('1600'); await expect(frame).toHaveAttribute('data-scene-id', secondId);
    await expect(frame).toHaveCSS('background-color', 'rgb(18, 58, 85)');
    await slider.fill('1500'); await page.getByRole('button', { name: 'プロジェクトを再生', exact: true }).click();
    await expect(frame).toHaveAttribute('data-scene-id', secondId);
    await page.getByRole('button', { name: 'プロジェクトの再生を停止', exact: true }).click();
    const paused = await slider.inputValue(); await page.waitForTimeout(100); await expect(slider).toHaveValue(paused);
    await slider.fill('600'); await page.getByRole('button', { name: 'この場面を編集', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Opening', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Transition 800 ms', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('stage-to')).toBeVisible();
    expect(room.project().scenes.opening.transitions[transition.id]).toEqual(transition);
    expect(room.project().scenes.opening.compositions[opening.compositionOrder[1]].states[circle].x).toBe(500);

    await preview(page); await page.locator('.project-preview-scenes').getByRole('button', { name: 'Scene 2 2.00 s', exact: true }).click();
    await page.getByRole('button', { name: 'この場面を編集', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Scene 2', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('stage-main')).toBeVisible();
    await page.getByRole('button', { name: 'Scene 2 のシーン操作', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move earlier', exact: true }).click();
    await expect.poll(() => room.project().sceneOrder).toEqual([secondId, 'opening']);
    await expect(page.getByRole('tab', { name: 'Scene 2', exact: true })).toHaveAttribute('aria-selected', 'true');
    applyChanges(room.doc, [{ path: ['scenes', 'opening', 'name'], value: 'Peer title' }], 'peer');
    await expect(page.getByRole('tab', { name: 'Peer title', exact: true })).toBeVisible();
    await preview(page); await expect(frame).toHaveAttribute('data-scene-id', secondId);
    await expect(page.locator('.project-preview-scenes button')).toHaveText(['Scene 22.00 s', 'Peer title1.60 s']);
    await page.screenshot({ path: testInfo.outputPath('project-preview-scenes.png') });
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect.poll(() => room.project().sceneOrder).toEqual(['opening', secondId]);
    expect(room.project().scenes.opening.name).toBe('Peer title');
    expect(errors).toEqual([]);
  } finally { room.close(); }
});

function exportProject(): Project {
  const project = blankProject(), first = project.scenes.opening;
  first.background = '#302030'; first.compositions[first.compositionOrder[0]].duration = 1600;
  first.objects.marker = { id: 'marker', name: 'Opening circle', kind: 'circle', order: 0, locked: false, groupId: null };
  first.compositions[first.compositionOrder[0]].states.marker = defaultState('circle', { x: 320, y: 180, width: 120, height: 120, fill: '#f4ce55' });
  first.objects.title = { id: 'title', name: 'Opening title', kind: 'text', order: 1, locked: false, groupId: null };
  first.compositions[first.compositionOrder[0]].states.title = defaultState('text', { text: 'ふたりの動画', fontSize: 30, x: 320, y: 55, fill: '#ffffff' });
  const second = makeBlankScene('closing', 'Portrait ending'); second.width = 360; second.height = 640; second.background = '#123a55';
  second.compositions[second.compositionOrder[0]].duration = 2000;
  second.objects.marker = { id: 'marker', name: 'Ending rectangle', kind: 'rectangle', order: 0, locked: false, groupId: null };
  second.compositions[second.compositionOrder[0]].states.marker = defaultState('rectangle', { x: 180, y: 320, width: 160, height: 240, fill: '#26b7cc', cornerRadius: 0 });
  project.sceneOrder.push(second.id); project.scenes[second.id] = second;
  return project;
}
function pixel(frame: Buffer, x: number, y: number) { return [...frame.subarray((y * 640 + x) * 3, (y * 640 + x) * 3 + 3)]; }
function near(actual: number[], expected: number[]) { for (const [index, value] of actual.entries()) expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(7); }

for (const format of ['mp4', 'webm'] as const) test(`the actual ${format.toUpperCase()} combines Scenes and preserves snapshot, frame boundaries, aspect and repeat download`, async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const room = await open(page, exportProject());
  try {
    let mutated = false;
    await page.exposeFunction('firstProjectEncode', () => {
      if (mutated) return;
      mutated = true;
      applyChanges(room.doc, [
        { path: ['name'], value: 'Changed while exporting' },
        { path: ['scenes', 'closing', 'background'], value: '#ff0000' },
        { path: ['scenes', 'closing', 'compositions', room.project().scenes.closing.compositionOrder[0], 'states', 'marker', 'fill'], value: '#00ff00' },
        { path: ['scenes', 'closing', 'compositions', room.project().scenes.closing.compositionOrder[0], 'duration'], value: 9000 },
      ], 'peer');
    });
    await page.evaluate(() => {
      const scope = window as typeof window & { firstProjectEncode: () => Promise<void>; projectEncodeTrace: number[]; projectEncodeArmed: boolean };
      scope.projectEncodeTrace = []; scope.projectEncodeArmed = false;
      const encode = VideoEncoder.prototype.encode;
      VideoEncoder.prototype.encode = function(frame, options) {
        const result = encode.call(this, frame, options);
        if (scope.projectEncodeArmed) { scope.projectEncodeTrace.push(frame.timestamp); if (scope.projectEncodeTrace.length === 1) void scope.firstProjectEncode(); }
        return result;
      };
    });
    await page.getByRole('tab', { name: 'Portrait ending', exact: true }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: 'Export range', exact: true })).toHaveValue('project');
    await page.getByRole('combobox', { name: 'Export format', exact: true }).selectOption(format);
    await expect(page.getByRole('combobox', { name: 'Export resolution', exact: true })).toContainText('Source · 640 × 360');
    await expect(page.getByRole('dialog')).toContainText('3.60 seconds');
    await page.evaluate(() => { (window as typeof window & { projectEncodeArmed: boolean }).projectEncodeArmed = true; });
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export video', exact: true }).click();
    const download = await downloading, path = testInfo.outputPath(`two-scenes.${format}`); await download.saveAs(path);
    await expect(page.getByRole('button', { name: 'Download again', exact: true })).toBeVisible();
    expect(mutated).toBe(true); expect(download.suggestedFilename()).toBe(`Our film.${format}`);
    await expect(page.getByRole('dialog')).toContainText('3.60 seconds');
    await expect(page.getByRole('dialog')).toContainText('640 × 360 · 30 fps');
    const timestamps = await page.evaluate(() => (window as typeof window & { projectEncodeTrace: number[] }).projectEncodeTrace);
    expect(timestamps).toHaveLength(108); expect(timestamps[0]).toBe(0);
    expect(Math.abs(timestamps.at(-1)! - 107 / 30 * 1e6)).toBeLessThan(1);
    const again = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download again', exact: true }).click();
    const againPath = testInfo.outputPath(`download-again.${format}`); await (await again).saveAs(againPath);
    expect(await readFile(againPath)).toEqual(await readFile(path));
    expect(await page.evaluate(() => (window as typeof window & { projectEncodeTrace: number[] }).projectEncodeTrace.length)).toBe(108);
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', path]);
    const info = JSON.parse(stdout), video = info.streams[0];
    expect(video.width).toBe(640); expect(video.height).toBe(360); expect(Number(video.nb_read_frames)).toBe(108);
    expect(Number(info.format.duration)).toBeCloseTo(3.6, 2);
    const decoded = await execute('ffmpeg', ['-v', 'error', '-i', path, '-vf', 'select=eq(n\\,0)+eq(n\\,47)+eq(n\\,48)+eq(n\\,107)', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
    const size = 640 * 360 * 3; expect(decoded.stdout.length).toBe(size * 4);
    const frames = [0, 1, 2, 3].map(index => decoded.stdout.subarray(index * size, (index + 1) * size));
    for (const frame of frames.slice(0, 2)) { near(pixel(frame, 20, 20), [48, 32, 48]); near(pixel(frame, 320, 180), [244, 206, 85]); }
    for (const frame of frames.slice(2)) {
      near(pixel(frame, 20, 20), [18, 58, 85]); near(pixel(frame, 320, 180), [38, 183, 204]);
      near(pixel(frame, 350, 180), [38, 183, 204]); near(pixel(frame, 430, 180), [18, 58, 85]); // Fit the portrait scene, without stretching.
    }
    await writeFile(testInfo.outputPath('media-verification.json'), JSON.stringify({ ...info, timestamps, firstBackground: pixel(frames[0], 20, 20), secondBackground: pixel(frames[2], 20, 20), secondMarker: pixel(frames[2], 320, 180) }, null, 2));
    await testInfo.attach(`two-scenes-${format}`, { path, contentType: `video/${format}` });
  } finally { room.close(); }
});
