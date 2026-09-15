import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { readProject } from '../../shared/document';
import { parseProjectFile } from '../../shared/project-file';

function wave(name = 'Tone.wav') {
  const samples = 16000 * 2, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 440 * Math.PI * 2 / 16000) * 14000), 44 + i * 2);
  return { name, mimeType: 'audio/wav', buffer: bytes };
}
async function open(page: Page, room = crypto.randomUUID()) { await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible(); return room; }
async function observer(page: Page, room: string) {
  const endpoint = new URL(page.url()); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'; endpoint.pathname = '/sync'; endpoint.search = '';
  const doc = new Y.Doc(), provider = new WebsocketProvider(endpoint.toString(), room, doc, { WebSocketPolyfill: WebSocket as never, disableBc: true });
  await new Promise<void>(resolve => provider.on('sync', value => { if (value) resolve(); }));
  return { project: () => readProject(doc)!, close: () => { provider.destroy(); doc.destroy(); } };
}
async function field(page: Page, name: string, value: string) { const input = page.getByRole('spinbutton', { name, exact: true }); await input.fill(value); await input.press('Tab'); }
async function uploadWave(page: Page) { await page.getByLabel('音声・動画ファイル', { exact: true }).setInputFiles(wave()); await expect(page.getByTestId('audio-track')).toHaveCount(1); }

test('audio is a shared independent waveform track with trim, volume, mute, and undo', async ({ page, browser }, info) => {
  const room = await open(page), watch = await observer(page, room), context = await browser.newContext(), peer = await context.newPage();
  try {
    await open(peer, room); await uploadWave(page);
    await expect(peer.getByTestId('audio-track')).toHaveCount(1);
    expect(await page.locator('.media-waveform line').count()).toBeGreaterThan(50);
    const track = Object.values(watch.project().scenes['scene-1'].audioTracks!)[0];
    expect(track.asset.src).toContain(`/api/rooms/${room}/media/`);
    expect(Object.values(watch.project().scenes['scene-1'].objects).some(object => object.name === 'Tone')).toBe(false);
    await page.getByRole('button', { name: '音声クリップ Tone', exact: true }).click();
    await field(page, '素材の開始位置', '500'); await field(page, '素材のトリム開始', '250'); await field(page, '素材の再生時間', '1000'); await field(page, '音量', '35');
    await peer.getByRole('button', { name: '音声クリップ Tone', exact: true }).click();
    await expect(peer.getByRole('spinbutton', { name: '素材の開始位置', exact: true })).toHaveValue('500');
    await expect(peer.getByRole('spinbutton', { name: '音量', exact: true })).toHaveValue('35');
    await page.getByRole('button', { name: 'Tone をミュート', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'Tone のミュートを解除', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'Tone をミュート', exact: true })).toBeVisible();
    // Request partial bytes as a second client would when seeking in a media element.
    const response = await peer.request.get(track.asset.src, { headers: { Range: 'bytes=0-43' } });
    expect(response.status()).toBe(206); expect((await response.body()).length).toBe(44);
    await page.screenshot({ path: info.outputPath('audio-track.png'), fullPage: true });
  } finally { watch.close(); await context.close(); }
});

test('media save embeds source and opening restores independent room assets', async ({ page }, info) => {
  const room = await open(page); await uploadWave(page);
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save project', exact: true }).click()]);
  const path = info.outputPath('audio.poietra.json'); await download.saveAs(path);
  const project = parseProjectFile(await readFile(path, 'utf8'));
  expect(Object.values(project.scenes['scene-1'].audioTracks!)[0].asset.src).toMatch(/^data:audio\/wav;base64,/);
  await page.route(`**/api/rooms/${room}/media/**`, route => route.abort());
  await page.getByLabel('プロジェクトファイル', { exact: true }).setInputFiles(path);
  await expect(page).not.toHaveURL(new RegExp(room)); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByTestId('audio-track')).toHaveCount(1);
  const nextRoom = new URL(page.url()).searchParams.get('room')!, watch = await observer(page, nextRoom);
  try { expect(Object.values(watch.project().scenes['scene-1'].audioTracks!)[0].asset.src).toContain(`/api/rooms/${nextRoom}/media/`); } finally { watch.close(); }
});

test('invalid and cancelled imports provide local feedback without adding tracks', async ({ page }) => {
  await open(page);
  await page.getByLabel('音声・動画ファイル', { exact: true }).setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a movie') });
  await expect(page.locator('.media-import-status.is-error')).toBeVisible(); await expect(page.getByTestId('audio-track')).toHaveCount(0);
  let requested = false;
  await page.route('**/api/rooms/*/media', async route => { requested = true; await new Promise(resolve => setTimeout(resolve, 1200)); await route.abort().catch(() => {}); });
  await page.getByLabel('音声・動画ファイル', { exact: true }).setInputFiles(wave());
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByRole('progressbar', { name: '素材の読み込み進捗' })).toBeVisible();
  await page.getByRole('button', { name: '中止', exact: true }).click();
  await expect(page.getByTestId('audio-track')).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('中止');
});

test('MP4 import creates a visible video object and a separate soundtrack', async ({ page }, info) => {
  const file = info.outputPath('Clip.mp4');
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const room = await open(page), watch = await observer(page, room);
  try {
    await page.getByLabel('音声・動画ファイル', { exact: true }).setInputFiles(file);
    await expect(page.getByTestId('video-track')).toHaveCount(1); await expect(page.getByTestId('audio-track')).toHaveCount(1);
    const scene = watch.project().scenes['scene-1'], video = Object.values(scene.objects).find(object => object.kind === 'video')!;
    expect(video.media).toMatchObject({ width: 160, height: 90, hasAudio: true });
    expect(Object.values(scene.audioTracks!)[0].asset.src).toBe(video.media!.src);
    await expect(page.locator('.scene-svg image').first()).toHaveAttribute('href', /^data:image\//);
    await page.getByRole('button', { name: '動画クリップ Clip', exact: true }).click();
    await field(page, '素材のトリム開始', '500'); await field(page, '素材の再生時間', '1000');
    await page.getByRole('button', { name: 'シーンを再生', exact: true }).click();
    await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '一時停止', exact: true }).click();
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('video-audio-tracks.png'), fullPage: true });
  } finally { watch.close(); }
});
