import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { AudioTrackSchema, MEDIA_CHUNK_BYTES, MEDIA_FILE_LIMIT, MediaAssetSchema, mediaByteRange, mediaMime, mediaResponsePlan, writeMediaChunks, type AudioTrack, type MediaAsset } from '../shared/media';
import { makeDemoProject } from '../shared/demo';
import { defaultState, sceneDuration, sceneSegments } from '../shared/model';
import { ensureSceneAudioTracks, getShared, initializeDocument, readProject, toShared } from '../shared/document';
import { parseProjectFile } from '../shared/project-file';
import { copyObjects, parseObjects, pasteObjectChanges, serializeObjects } from '../shared/clipboard';
import { duplicateScene } from '../src/editor/scenes';

const src = `/api/rooms/${'a'.repeat(32)}/media/${'f'.repeat(64)}`;
const asset: MediaAsset = { src, mime: 'audio/wav', duration: 8000, hasAudio: true, waveform: [0, .5, 1] };
const audio: AudioTrack = { id: 'audio-1', name: 'Voice', asset, start: 1000, offset: 2000, duration: 5000, volume: .8, muted: false };
function project() {
  const project = makeDemoProject(), scene = project.scenes['scene-1'];
  scene.audioTracks = { [audio.id]: structuredClone(audio) };
  scene.objects.video = { id: 'video', name: 'Video', kind: 'video', order: 4, groupId: null, locked: false,
    media: { ...structuredClone(asset), mime: 'video/mp4', width: 640, height: 360 }, playback: { start: 0, offset: 0, duration: 7000 } };
  for (const comp of Object.values(scene.compositions)) comp.states.video = defaultState('video');
  return project;
}
function wav(size: number) { const bytes = new Uint8Array(size); bytes.set(new TextEncoder().encode('RIFF0000WAVE')); return bytes; }
async function* chunks(bytes: Uint8Array, count = 31) { for (let offset = 0; offset < bytes.length; offset += count) yield bytes.subarray(offset, offset + count); }

it('preserves old files and roundtrips independent audio/video with clipboard references', () => {
  const old = makeDemoProject(); delete old.scenes['scene-1'].audioTracks;
  expect(parseProjectFile(JSON.stringify(old))).toEqual(old);
  const value = project(); expect(parseProjectFile(JSON.stringify(value))).toEqual(value);
  const copied = parseObjects(serializeObjects(copyObjects(value.scenes['scene-1'], 'comp-1', ['video'])))!;
  const pasted = pasteObjectChanges(value.scenes['scene-1'], 'comp-2', copied);
  expect(pasted.changes[0].value).toMatchObject({ kind: 'video', media: { src }, playback: { duration: 7000 } });
});
it('validates duration/volume/waveform/media references and requires video playback', () => {
  expect(AudioTrackSchema.safeParse(audio).success).toBe(true);
  for (const patch of [{ volume: 2 }, { offset: 4000 }, { asset: { ...asset, hasAudio: false } }]) expect(AudioTrackSchema.safeParse({ ...audio, ...patch }).success).toBe(false);
  for (const patch of [{ src: 'https://external.test/movie.mp4' }, { mime: 'text/html' }, { waveform: Array(161).fill(0) }, { waveform: [1.1] }, { duration: 0 }]) expect(MediaAssetSchema.safeParse({ ...asset, ...patch }).success).toBe(false);
  const value = project(); delete value.scenes['scene-1'].objects.video.playback;
  expect(() => parseProjectFile(JSON.stringify(value))).toThrow('形式');
});
it('scene duration includes independent sound and visible video without changing visual segments', () => {
  const scene = project().scenes['scene-1'];
  expect(sceneSegments(scene).at(-1)).toMatchObject({ start: 1800, duration: 1600 });
  expect(sceneDuration(scene)).toBe(7000);
  for (const comp of Object.values(scene.compositions)) comp.states.video.visible = false;
  expect(sceneDuration(scene)).toBe(6000);
  scene.audioTracks = {}; expect(sceneDuration(scene)).toBe(3400);
});
it('duplicates audio track IDs and independent values while sharing immutable source bytes', () => {
  const doc = new Y.Doc(); initializeDocument(doc, project());
  const id = duplicateScene(doc, 'scene-1'), copy = readProject(doc)!.scenes[id];
  const track = Object.values(copy.audioTracks!)[0];
  expect(track.id).not.toBe(audio.id); expect(track.asset.src).toBe(src); expect(track).toMatchObject({ start: 1000, offset: 2000, duration: 5000, volume: .8 });
  (getShared(doc, ['scenes', id, 'audioTracks', track.id]) as Y.Map<unknown>).set('volume', .1);
  expect(readProject(doc)!.scenes['scene-1'].audioTracks![audio.id].volume).toBe(.8);
  expect(() => parseProjectFile(JSON.stringify(readProject(doc)))).not.toThrow(); doc.destroy();
});
it('authoritative migration gives two old-room clients the same parent and preserves offline first tracks', () => {
  const old = makeDemoProject(); delete old.scenes['scene-1'].audioTracks;
  const server = new Y.Doc(), alice = new Y.Doc(), bob = new Y.Doc(); initializeDocument(server, old);
  expect(ensureSceneAudioTracks(server)).toBe(true); expect(ensureSceneAudioTracks(server)).toBe(false);
  for (const doc of [alice, bob]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  (getShared(alice, ['scenes', 'scene-1', 'audioTracks']) as Y.Map<unknown>).set('alice', toShared({ ...audio, id: 'alice' }));
  (getShared(bob, ['scenes', 'scene-1', 'audioTracks']) as Y.Map<unknown>).set('bob', toShared({ ...audio, id: 'bob' }));
  Y.applyUpdate(server, Y.encodeStateAsUpdate(alice)); Y.applyUpdate(server, Y.encodeStateAsUpdate(bob));
  for (const doc of [alice, bob]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  expect(Object.keys(readProject(server)!.scenes['scene-1'].audioTracks!).sort()).toEqual(['alice', 'bob']);
  expect(readProject(alice)).toEqual(readProject(bob)); expect(() => parseProjectFile(JSON.stringify(readProject(server)))).not.toThrow();
  for (const doc of [server, alice, bob]) doc.destroy();
});
it.each([
  ['bytes=0-0', { start: 0, end: 0 }], ['bytes=4-', { start: 4, end: 9 }], ['bytes=-3', { start: 7, end: 9 }],
  ['bytes=3-100', { start: 3, end: 9 }], ['bytes=-100', { start: 0, end: 9 }], ['bytes=10-', null], ['bytes=3-1', null],
  ['bytes=-0', null], ['bytes=1-2,4-5', null], ['bytes=9007199254740993-', null],
])('single byte range %s', (header, value) => expect(mediaByteRange(header, 10)).toEqual(value));
it('uses immutable validators and ignores stale If-Range instead of sending the wrong partial bytes', () => {
  const request = { range: 'bytes=2-4', ifRange: null, ifNoneMatch: null }, metadata = { size: 10, mime: 'audio/wav' };
  expect(mediaResponsePlan(request, metadata, 'a')).toMatchObject({ status: 206, headers: { 'Content-Range': 'bytes 2-4/10', 'Content-Length': '3' } });
  expect(mediaResponsePlan({ ...request, ifRange: '"old"' }, metadata, 'a')).toMatchObject({ status: 200, range: { start: 0, end: 9 } });
  expect(mediaResponsePlan({ ...request, ifNoneMatch: '"a"' }, metadata, 'a').status).toBe(304);
  expect(mediaResponsePlan({ ...request, ifNoneMatch: 'W/"a"' }, metadata, 'a').status).toBe(304);
  expect(mediaResponsePlan({ ...request, range: 'unknown=2-4' }, metadata, 'a').status).toBe(200);
});
it('sniffs only supported containers including canonical MP4/M4A and WAV aliases', () => {
  expect(mediaMime(wav(44), 'audio/x-wav')).toBe('audio/wav');
  const mp4 = new TextEncoder().encode('0000ftypisom');
  expect(mediaMime(mp4, 'audio/x-m4a')).toBe('audio/mp4'); expect(mediaMime(mp4, 'video/mp4')).toBe('video/mp4');
  expect(mediaMime(new TextEncoder().encode('<svg/>'), 'video/mp4')).toBeNull();
});
it('streams fixed-size chunks and rejects declared, chunked oversized and invalid bodies', async () => {
  const bytes = wav(MEDIA_CHUNK_BYTES * 2 + 31), writes: Uint8Array[] = [];
  expect(await writeMediaChunks(chunks(bytes), 'audio/wav', null, part => { writes.push(part.slice()); })).toEqual({ size: bytes.length, mime: 'audio/wav' });
  expect(writes.map(chunk => chunk.length)).toEqual([MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES, 31]);
  expect(Buffer.concat(writes)).toEqual(Buffer.from(bytes));
  await expect(writeMediaChunks(chunks(bytes), 'audio/wav', String(MEDIA_FILE_LIMIT + 1), () => {})).rejects.toMatchObject({ status: 413 });
  const tooLarge = (async function* () { yield wav(MEDIA_CHUNK_BYTES); for (let i = 1; i <= MEDIA_FILE_LIMIT / MEDIA_CHUNK_BYTES; i++) yield new Uint8Array(MEDIA_CHUNK_BYTES); })();
  await expect(writeMediaChunks(tooLarge, 'audio/wav', null, () => {})).rejects.toMatchObject({ status: 413 });
  await expect(writeMediaChunks(chunks(new TextEncoder().encode('<svg/>')), 'video/mp4', null, () => {})).rejects.toThrow('対応');
});
