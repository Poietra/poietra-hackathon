import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { IMAGE_ASSET_PATH, IMAGE_BYTES_LIMIT, ImageAssetSchema, imageDigest, imageMime, readImageBody } from '../shared/images';
import { makeDemoProject } from '../shared/demo';
import { defaultState } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import { copyObjects, parseObjects, pasteObjectChanges, serializeObjects } from '../shared/clipboard';
import { frameToSvg, objectBounds } from '../src/engine/renderer';
import { compositionFrame } from '../src/engine/evaluate';
import { compileProposal, validateStateValue } from '../shared/ai';
import { initializeDocument, readProject } from '../shared/document';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==', 'base64'));
const source = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
function project() {
  const project = makeDemoProject(), scene = project.scenes['scene-1'];
  scene.objects.photo = { id: 'photo', name: 'Photo', kind: 'image', order: 4, groupId: null, locked: false, image: { src: source, width: 1, height: 1 } };
  for (const comp of Object.values(scene.compositions)) comp.states.photo = defaultState('image', { x: 640, y: 360, width: 320, height: 160, strokeWidth: 0 });
  return project;
}

it('accepts only embedded raster data or immutable room image paths', () => {
  expect(ImageAssetSchema.parse({ src: source, width: 80, height: 40 }).src).toBe(source);
  const path = `/api/rooms/${crypto.randomUUID()}/images/${'a'.repeat(64)}`;
  expect(IMAGE_ASSET_PATH.test(path)).toBe(true);
  for (const src of ['https://evil.test/a.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', '/api/rooms/../../secret', source + '" onload="evil']) expect(ImageAssetSchema.safeParse({ src, width: 80, height: 40 }).success).toBe(false);
  expect(ImageAssetSchema.safeParse({ src: source, width: 99999, height: 40 }).success).toBe(false);
});
it('sniffs raster MIME and deterministically addresses identical bytes', async () => {
  expect(imageMime(png)).toBe('image/png'); expect(imageMime(new TextEncoder().encode('<svg onload="evil"/>'))).toBeNull();
  expect(await imageDigest(png)).toMatch(/^[a-f0-9]{64}$/); expect(await imageDigest(png)).toBe(await imageDigest(new Uint8Array(png)));
});
it('rejects oversized or non-image request bodies before accepting an asset', async () => {
  expect(await readImageBody(new Request('http://local', { method: 'POST', body: png }))).toEqual(png);
  await expect(readImageBody(new Request('http://local', { method: 'POST', body: new Uint8Array(IMAGE_BYTES_LIMIT + 1) }))).rejects.toThrow('1 MB');
  await expect(readImageBody(new Request('http://local', { method: 'POST', body: '<script>bad</script>' }))).rejects.toThrow('PNG');
});
it('keeps source identity through project save, clipboard copy/paste, and independent composition states', () => {
  const original = project(), scene = original.scenes['scene-1'];
  expect(parseProjectFile(JSON.stringify(original))).toEqual(original);
  const clipboard = parseObjects(serializeObjects(copyObjects(scene, 'comp-1', ['photo'])))!;
  expect(clipboard.objects[0].image?.src).toBe(source);
  const pasted = pasteObjectChanges(scene, 'comp-2', clipboard);
  expect(pasted.changes[0].value).toMatchObject({ kind: 'image', image: { src: source } });
  expect(pasted.changes.find(change => change.path[3] === 'comp-1')?.value).toMatchObject({ visible: false });
  delete scene.objects.photo.image; expect(() => parseProjectFile(JSON.stringify(original))).toThrow('形式');
});
it('renders self-contained raster markup with bounds, rounded crop and Write reveal', () => {
  const scene = project().scenes['scene-1'], frame = compositionFrame(scene, scene.compositions['comp-1']), item = frame.objects.find(item => item.object.id === 'photo')!;
  item.writeProgress = 0.5;
  expect(objectBounds(item)).toEqual({ x: 480, y: 280, width: 320, height: 160 });
  const svg = frameToSvg({ ...frame, objects: [item] });
  expect(svg).toContain(`<image href="${source}"`); expect(svg).toContain('width="160" height="160"'); expect(svg).toContain('clip-path=');
  item.object.image = { src: 'javascript:alert(1)', width: 1, height: 1 };
  expect(frameToSvg({ ...frame, objects: [item] })).not.toContain('javascript:');
});
it('AI can position and animate an uploaded image but cannot claim to recolor its pixels', () => {
  const doc = new Y.Doc(); initializeDocument(doc, project());
  const proposal = compileProposal(doc, readProject(doc)!, 'scene-1', { message: '画像を移動', operations: [{ action: 'setState', compositionId: 'comp-2', objectId: 'photo', property: 'x', value: 900 }, { action: 'setTrack', transitionId: 'transition-1', objectId: 'photo', property: 'type', value: 'move' }] });
  expect(proposal.changes.length).toBeGreaterThan(0);
  expect(() => validateStateValue('fill', '#ff0000', 'image')).toThrow('画像'); expect(() => validateStateValue('width', -1, 'image')).toThrow('サイズ');
});
