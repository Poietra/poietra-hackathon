import { beforeAll, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { makeDemoProject } from '../shared/demo';
import { defaultState } from '../shared/model';
import { compositionFrame, evaluateScene, transitionFrame } from '../src/engine/evaluate';
import type { MotionKernel } from '../src/engine/kernel';

let kernel: MotionKernel;
beforeAll(async () => { const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url))); kernel = instance.exports as unknown as MotionKernel; });
function sceneWithVideo() {
  const scene = makeDemoProject().scenes['scene-1'];
  scene.objects.video = { id: 'video', name: 'Video', kind: 'video', groupId: null, order: 4, locked: false, media: { src: 'data:video/mp4;base64,AAAA', mime: 'video/mp4', width: 160, height: 90, duration: 5000, hasAudio: false }, playback: { start: 1100, offset: 2000, duration: 1000 } };
  for (const composition of Object.values(scene.compositions)) composition.states.video = defaultState('video');
  return scene;
}
test('Scene playback clips both visual boundaries and maps global time through trim across transition and hold', () => {
  const scene = sceneWithVideo();
  const video = (time: number) => evaluateScene(scene, time, kernel).objects.find(item => item.object.id === 'video');
  expect(video(1099)).toBeUndefined();
  expect(video(1100)?.videoTimeMs).toBe(2000);
  expect(video(1500)?.videoTimeMs).toBe(2400);
  expect(video(2000)?.videoTimeMs).toBe(2900);
  expect(video(2100)).toBeUndefined();
});
test('static composition keeps editable poster while transition local time uses its global segment start', () => {
  const scene = sceneWithVideo();
  expect(compositionFrame(scene, scene.compositions[scene.compositionOrder[0]]).objects.find(item => item.object.id === 'video')?.videoTimeMs).toBe(2000);
  const transition = Object.values(scene.transitions)[0];
  expect(transitionFrame(scene, transition, 99, kernel).objects.find(item => item.object.id === 'video')).toBeUndefined();
  expect(transitionFrame(scene, transition, 200, kernel).objects.find(item => item.object.id === 'video')?.videoTimeMs).toBe(2100);
});
