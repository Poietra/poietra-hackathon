import { expect, test } from 'vitest';
import * as Y from 'yjs';
import { compileProposal, placeholderImage, withGeneratedImages, type CompilableProposal } from '../shared/ai';
import { applyChanges, initializeDocument, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';

const fixture = () => { const doc = new Y.Doc(); initializeDocument(doc, makeDemoProject()); return doc; };
const request = { action: 'generateImage' as const, ref: '@star', compositionId: 'comp-1', name: 'Star', prompt: 'a star', size: 'portrait' as const, transparent: false, x: 300, y: 300, width: 200 };
const placeholders = (operation: { size: 'square' | 'landscape' | 'portrait' }) => placeholderImage(operation.size);

test('withGeneratedImages keeps the aspect ratio of the asset and limits the count', () => {
  const resolved = withGeneratedImages({ message: 'm', operations: [request] }, placeholders);
  expect(resolved.operations[0]).toMatchObject({ action: 'createImage', ref: '@star', width: 200, height: 300, image: { width: 1024, height: 1536 } });
  expect(() => withGeneratedImages({ message: 'm', operations: [request, { ...request, ref: '@b' }, { ...request, ref: '@c' }] }, placeholders)).toThrow('2 枚');
  expect(() => withGeneratedImages({ message: 'm', operations: [request] }, () => undefined)).toThrow('完了していません');
});

test('a createImage operation compiles into an image object that later operations can animate', () => {
  const doc = fixture();
  const proposal = compileProposal(doc, readProject(doc)!, 'scene-1', withGeneratedImages({ message: 'm', operations: [request,
    { action: 'setState', compositionId: 'comp-2', objectId: '@star', property: 'visible', value: true },
    { action: 'setState', compositionId: 'comp-2', objectId: '@star', property: 'x', value: 900 },
    { action: 'setTrack', transitionId: 'transition-1', objectId: '@star', property: 'type', value: 'fade' },
  ] }, placeholders));
  applyChanges(doc, proposal.changes);
  const scene = readProject(doc)!.scenes['scene-1'];
  const star = Object.values(scene.objects).find(object => object.name === 'Star')!;
  expect(star).toMatchObject({ kind: 'image', image: { width: 1024, height: 1536 } });
  expect(scene.compositions['comp-1'].states[star.id]).toMatchObject({ x: 300, y: 300, width: 200, height: 300, visible: true, fill: 'none', strokeWidth: 0, cornerRadius: 0 });
  expect(scene.compositions['comp-2'].states[star.id]).toMatchObject({ x: 900, visible: true });
  expect(scene.transitions['transition-1'].tracks[star.id]).toMatchObject({ type: 'fade' });
});

test('compileProposal refuses unresolved image requests and image color edits', () => {
  const doc = fixture();
  expect(() => compileProposal(doc, readProject(doc)!, 'scene-1', { message: 'm', operations: [request] })).toThrow('画像の生成が完了していません');
  const recolored: CompilableProposal = { message: 'm', operations: [...withGeneratedImages({ message: 'm', operations: [request] }, placeholders).operations, { action: 'setState', compositionId: 'comp-1', objectId: '@star', property: 'fill', value: '#ff0000' }] };
  expect(() => compileProposal(doc, readProject(doc)!, 'scene-1', recolored)).toThrow('画像の色や内容は変更できません');
});
