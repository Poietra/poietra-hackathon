import { beforeEach, expect, it, vi } from 'vitest';
import { makeDemoProject } from '../shared/demo';
import { defaultState } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import type { MediaAsset } from '../shared/media';

const media = vi.hoisted(() => ({ mediaBlob: vi.fn(), prepareMedia: vi.fn(), uploadMedia: vi.fn() }));
vi.mock('../src/editor/media', () => media);
vi.mock('../src/engine/rendering/image-source', () => ({ imageBlob: vi.fn(), blobDataUrl: async (blob: Blob) => `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}` }));
import { portableProject, rehostImageAssets, storeProjectImages } from '../src/editor/images';

const sourceRoom = 'a'.repeat(32), targetRoom = 'b'.repeat(32), digest = 'f'.repeat(64);
const asset: MediaAsset = { src: `/api/rooms/${sourceRoom}/media/${digest}`, mime: 'video/mp4', width: 320, height: 180, duration: 2000, hasAudio: true, waveform: [0, .4, 1] };
const blob = new Blob(['decoded elsewhere'], { type: asset.mime });
function project() {
  const project = makeDemoProject(), scene = project.scenes['scene-1'];
  scene.objects.movie = { id: 'movie', name: 'Movie', kind: 'video', groupId: null, order: 3, locked: false, media: structuredClone(asset), playback: { start: 500, offset: 100, duration: 1500 } };
  for (const comp of Object.values(scene.compositions)) comp.states.movie = defaultState('video');
  scene.audioTracks = { sound: { id: 'sound', name: 'Movie sound', asset: structuredClone(asset), start: 500, offset: 200, duration: 1200, volume: .3, muted: true } };
  return project;
}
beforeEach(() => {
  vi.clearAllMocks();
  media.mediaBlob.mockResolvedValue(blob);
  const { src: _src, ...metadata } = asset;
  media.prepareMedia.mockResolvedValue({ asset: structuredClone(metadata), blob, kind: 'video' });
  media.uploadMedia.mockResolvedValue(`/api/rooms/${targetRoom}/media/${digest}`);
});
it('embeds shared visual/audio bytes once fetched and preserves independent timing through JSON', async () => {
  const original = project(), portable = await portableProject(original), scene = portable.scenes['scene-1'];
  const src = scene.objects.movie.media!.src;
  expect(src).toMatch(/^data:video\/mp4;base64,/);
  expect(scene.audioTracks!.sound.asset.src).toBe(src);
  expect(media.mediaBlob).toHaveBeenCalledTimes(1);
  expect(original.scenes['scene-1'].objects.movie.media!.src).toBe(asset.src);
  expect(parseProjectFile(JSON.stringify(portable))).toEqual(portable);
  const restored = await storeProjectImages(portable, targetRoom);
  expect(media.prepareMedia).toHaveBeenCalledTimes(1); expect(media.uploadMedia).toHaveBeenCalledTimes(1);
  expect(restored.scenes['scene-1'].objects.movie.media!.src).toBe(`/api/rooms/${targetRoom}/media/${digest}`);
  expect(restored.scenes['scene-1'].audioTracks!.sound).toMatchObject({ start: 500, offset: 200, duration: 1200, volume: .3, muted: true, asset: { src: `/api/rooms/${targetRoom}/media/${digest}` } });
  expect(restored.scenes['scene-1'].objects.movie.playback).toEqual({ start: 500, offset: 100, duration: 1500 });
  expect(() => parseProjectFile(JSON.stringify(restored))).not.toThrow();
});
it('rehosts video clipboard objects across rooms and skips sources already owned by the destination', async () => {
  const objects = [project().scenes['scene-1'].objects.movie];
  await rehostImageAssets(objects, targetRoom); expect(media.uploadMedia).toHaveBeenCalledTimes(1);
  await rehostImageAssets(objects, targetRoom); expect(media.uploadMedia).toHaveBeenCalledTimes(1);
  expect(objects[0].media!.src).toBe(`/api/rooms/${targetRoom}/media/${digest}`);
});
it('rejects mismatched media metadata before publishing a project and does not alter its source', async () => {
  const original = project(); original.scenes['scene-1'].objects.movie.media!.duration = 3000;
  await expect(storeProjectImages(original, targetRoom)).rejects.toThrow('長さや形式');
  expect(media.uploadMedia).not.toHaveBeenCalled();
  expect(original.scenes['scene-1'].objects.movie.media!.src).toBe(asset.src);
});
it('initializes the audio parent when reopening old projects with no media', async () => {
  const original = makeDemoProject(); delete original.scenes['scene-1'].audioTracks;
  const restored = await storeProjectImages(original, targetRoom);
  expect(restored.scenes['scene-1'].audioTracks).toEqual({});
  expect(original.scenes['scene-1'].audioTracks).toBeUndefined(); expect(media.uploadMedia).not.toHaveBeenCalled();
});
