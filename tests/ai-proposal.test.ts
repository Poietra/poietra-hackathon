import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { compileProposal, validateProposalForApply, type EditProposal, type EditProposalSchema } from '../shared/ai';
import { applyChanges, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import type { z } from 'zod';

type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const docs: Y.Doc[] = [];
const doc = () => { const value = new Y.Doc(); initializeDocument(value, makeDemoProject()); docs.push(value); return value; };
const state = (property: string) => ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', property];
const track = (property: string, objectId = 'circle') => ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', objectId, property];
const proposal = (document: Y.Doc, operations: Operation[]) => compileProposal(document, readProject(document)!, 'scene-1', { message: '変更案', operations });
const setTrack = (property: 'start' | 'duration' | 'type', value: number | string, objectId = 'circle'): Operation => ({ action: 'setTrack', transitionId: 'transition-1', objectId, property, value });
const apply = (document: Y.Doc, changes: EditProposal) => { validateProposalForApply(document, changes); applyChanges(document, changes.changes); };
afterEach(() => { for (const document of docs.splice(0)) document.destroy(); });

describe('AI proposal validity', () => {
  test('rejects the whole proposal if final timing exceeds the transition', () => {
    const document = doc(); const before = readProject(document);
    expect(() => proposal(document, [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'fill', value: '#f4ce55' }, setTrack('start', 500)])).toThrow('範囲を超え');
    expect(readProject(document)).toEqual(before);
  });

  test.each([false, true])('validates combined final timing independent of operation order (reverse: %s)', reverse => {
    const document = doc(); const operations = [setTrack('start', 500), setTrack('duration', 300)];
    apply(document, proposal(document, reverse ? operations.reverse() : operations));
    expect(readProject(document)!.scenes['scene-1'].transitions['transition-1'].tracks.circle).toMatchObject({ start: 500, duration: 300 });
  });

  test('creates a complete track in an empty tracks map', () => {
    const document = doc(); applyChanges(document, [{ path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks'], value: {} }]);
    const edits = proposal(document, [setTrack('start', 300), setTrack('duration', 500), setTrack('type', 'fade')]);
    expect(edits.changes).toHaveLength(1);
    apply(document, edits);
    expect(readProject(document)!.scenes['scene-1'].transitions['transition-1'].tracks.circle).toEqual({ objectId: 'circle', type: 'fade', start: 300, duration: 500, easing: 'easeInOut', order: 'together', path: null });
  });

  test('uses the last value for a field, without imposing intermediate timing', () => {
    const document = doc(); const edits = proposal(document, [setTrack('start', 500), setTrack('start', 100)]);
    expect(edits.changes).toHaveLength(1); apply(document, edits);
    expect(readProject(document)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.start).toBe(100);
  });

  test.each([
    ['transition duration', ['scenes', 'scene-1', 'transitions', 'transition-1', 'duration'], 500],
    ['coupled track duration', track('duration'), 700],
    ['object lock', ['scenes', 'scene-1', 'objects', 'circle', 'locked'], true],
  ])('rejects a proposal when its %s dependency changes', (_, path, value) => {
    const document = doc(); const edits = proposal(document, [setTrack('start', 100)]);
    applyChanges(document, [{ path: path as string[], value }]);
    expect(() => apply(document, edits)).toThrow('提案後');
    expect(readProject(document)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.start).toBe(0);
  });

  test('guards structural identity even when a replacement has identical values', () => {
    const document = doc(); const edits = proposal(document, [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 600 }]);
    const original = readProject(document)!.scenes['scene-1'].objects.circle;
    applyChanges(document, [{ path: ['scenes', 'scene-1', 'objects', 'circle'], value: structuredClone(original) }]);
    expect(() => apply(document, edits)).toThrow('提案後');
  });

  test('rejects all changes when one field becomes stale, preserving peer edits', () => {
    const document = doc(); const edits = proposal(document, [
      { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 600 },
      { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'fill', value: '#ffffff' },
    ]);
    applyChanges(document, [{ path: state('fill'), value: '#f4ce55' }], 'peer');
    expect(() => apply(document, edits)).toThrow('提案後');
    expect(readProject(document)!.scenes['scene-1'].compositions['comp-1'].states.circle).toMatchObject({ x: 245, fill: '#f4ce55' });
  });

  test('proposal from one replica applies in another and undo keeps unrelated peer changes', () => {
    const alice = doc(); const bob = new Y.Doc(); docs.push(bob); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    const edits = proposal(alice, [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 600 }]);
    applyChanges(alice, [{ path: state('fill'), value: '#f4ce55' }], 'peer'); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    const undo = new Y.UndoManager(bob.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    apply(bob, JSON.parse(JSON.stringify(edits)));
    expect(readProject(bob)!.scenes['scene-1'].compositions['comp-1'].states.circle).toMatchObject({ x: 600, fill: '#f4ce55' });
    undo.undo();
    expect(readProject(bob)!.scenes['scene-1'].compositions['comp-1'].states.circle).toMatchObject({ x: 245, fill: '#f4ce55' });
    undo.destroy();
  });

  test('does not replace a track that a collaborator added after the request', () => {
    const document = doc(); const edits = proposal(document, [setTrack('type', 'write', 'sigmoid')]);
    applyChanges(document, [{ path: track('type', 'sigmoid').slice(0, -1), value: { objectId: 'sigmoid', type: 'fade', start: 0, duration: 400, easing: 'linear', order: 'together', path: null } }], 'peer');
    expect(() => apply(document, edits)).toThrow('提案後');
    expect(readProject(document)!.scenes['scene-1'].transitions['transition-1'].tracks.sigmoid.type).toBe('fade');
  });

  test('addition has one shared identity and independent presence in every composition', () => {
    const document = doc();
    const edits = proposal(document, [{ action: 'addObject', compositionId: 'comp-2', name: 'Hello', kind: 'text', x: 640, y: 360, width: 400, height: 80, fill: '#ffffff', text: 'Hello', fontSize: 50 }]);
    applyChanges(document, [{ path: state('fill'), value: '#f4ce55' }], 'peer');
    apply(document, edits);
    const scene = readProject(document)!.scenes['scene-1']; const id = Object.keys(scene.objects).find(id => !['circle', 'equation', 'sigmoid'].includes(id))!;
    expect(scene.objects[id]).toMatchObject({ name: 'Hello', order: 3, kind: 'text' });
    expect(scene.compositions['comp-1'].states[id].visible).toBe(false);
    expect(scene.compositions['comp-2'].states[id]).toMatchObject({ visible: true, text: 'Hello' });
    expect(scene.compositions['comp-1'].states.circle.fill).toBe('#f4ce55');
  });

  test('rejects a batch containing invalid shapes or unknown operations before applying', () => {
    const document = doc();
    expect(() => proposal(document, [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'height', value: -1 }])).toThrow('サイズ');
    expect(() => proposal(document, [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'opacity', value: '1' }])).toThrow();
    expect(() => proposal(document, [{ action: 'deleteScene' } as unknown as Operation])).toThrow();
    expect(() => proposal(document, [setTrack('start', Number.NaN)])).toThrow();
    expect(() => proposal(document, [{ action: 'setState', compositionId: 'comp-1', objectId: 'constructor', property: 'x', value: 1 }])).toThrow();
  });

  test('a no-op proposal is not presented as an applicable edit', () => {
    const document = doc(); const edits = proposal(document, [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 245 }]);
    expect(edits.count).toBe(0); expect(edits.changes).toEqual([]);
  });
});
