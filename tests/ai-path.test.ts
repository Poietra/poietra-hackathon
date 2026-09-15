import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import type { z } from 'zod';
import { compileProposal, validateProposalForApply, type EditProposalSchema, type EditScope } from '../shared/ai';
import { applyChanges, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';

const curve = { c1: { x: 500, y: 100 }, c2: { x: 750, y: 100 } };
const relative = { c1: { x: 120, y: -250 }, c2: { x: 600, y: -20 } };
const original = { c1: { x: 505, y: 520 }, c2: { x: 665, y: 190 } };
type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const docs: Y.Doc[] = [];
const fixture = (project = makeDemoProject()) => { const doc = new Y.Doc(); initializeDocument(doc, project); docs.push(doc); return doc; };
const compile = (doc: Y.Doc, operations: Operation[], scope?: EditScope) => compileProposal(doc, readProject(doc)!, 'scene-1', { message: 'ベジェ曲線を調整します。', operations }, scope);
const motion = (path: typeof curve | null = curve, objectId = 'circle'): Operation => ({ action: 'setMotionPath', transitionId: 'transition-1', objectId, path });
const shape = (): Operation => ({ action: 'setShapePath', compositionId: 'comp-1', objectId: 'sigmoid', path: relative });
const trackPath = ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', 'circle'];
const statePath = ['scenes', 'scene-1', 'compositions', 'comp-1', 'states'];
const edit = (doc: Y.Doc, operations: Operation[]) => { const proposal = compile(doc, operations); validateProposalForApply(doc, proposal); applyChanges(doc, proposal.changes); return proposal; };
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });

describe('AI Bézier path editing', () => {
  test('sets only the chosen motion path and preserves existing Bézier shape geometry and anchors', () => {
    const doc = fixture(); const before = readProject(doc)!;
    const proposal = edit(doc, [motion()]);
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0].path).toEqual([...trackPath, 'path']);
    const after = readProject(doc)!;
    expect(after.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(curve);
    expect(after.scenes['scene-1'].compositions).toEqual(before.scenes['scene-1'].compositions);
    expect(after.scenes['scene-1'].transitions['transition-1'].tracks.equation).toEqual(before.scenes['scene-1'].transitions['transition-1'].tracks.equation);
  });

  test('null explicitly restores a straight motion path', () => {
    const doc = fixture(); edit(doc, [motion(null)]);
    expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toBeNull();
  });

  test.each([false, true])('combines missing-track path and timing edits in either order (%s)', reverse => {
    const doc = fixture(); applyChanges(doc, [{ path: trackPath, value: undefined }]);
    const operations: Operation[] = [motion(), { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'start', value: 250 }, { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'duration', value: 550 }];
    const proposal = edit(doc, reverse ? operations.reverse() : operations);
    expect(proposal.changes).toHaveLength(1);
    expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle).toEqual({ objectId: 'circle', type: 'move', start: 250, duration: 550, easing: 'easeInOut', order: 'together', path: curve });
  });

  test('multiple path operations use the final path and invalid final timing rejects the whole batch', () => {
    const doc = fixture(); const proposal = edit(doc, [motion(), motion(null), motion(relative)]);
    expect(proposal.changes).toHaveLength(1);
    expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(relative);
    expect(() => compile(doc, [motion(), { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'start', value: 700 }])).toThrow('範囲');
  });

  test.each([
    ['motion control', [...trackPath, 'path', 'c1', 'y'], 90],
    ['source anchor', [...statePath, 'circle', 'x'], 300],
    ['destination anchor', ['scenes', 'scene-1', 'compositions', 'comp-2', 'states', 'circle', 'y'], 220],
    ['source presence', [...statePath, 'circle', 'visible'], false],
    ['track type', [...trackPath, 'type'], 'fade'],
    ['lock', ['scenes', 'scene-1', 'objects', 'circle', 'locked'], true],
  ])('rejects a stale %s dependency without touching the project', (_, path, value) => {
    const doc = fixture(); const proposal = compile(doc, [motion()]);
    applyChanges(doc, [{ path: path as string[], value }], 'peer'); const before = readProject(doc);
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後'); expect(readProject(doc)).toEqual(before);
  });

  test('path proposals from a synced replica retain parent identities and preserve peer color edits', () => {
    const doc = fixture(); const peer = new Y.Doc(); docs.push(peer); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const proposal = compile(doc, [motion()]);
    applyChanges(peer, [{ path: [...statePath, 'circle', 'fill'], value: '#f4ce55' }]);
    validateProposalForApply(peer, JSON.parse(JSON.stringify(proposal))); applyChanges(peer, proposal.changes);
    expect(readProject(peer)!.scenes['scene-1'].compositions['comp-1'].states.circle.fill).toBe('#f4ce55');
    expect(readProject(peer)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(curve);
  });

  test('rejects deleting and recreating the same track even with identical path values', () => {
    const doc = fixture(); const proposal = compile(doc, [motion()]);
    const track = readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle;
    applyChanges(doc, [{ path: trackPath, value: structuredClone(track) }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  });

  test('a path-only new track has valid default timing and cannot replace a collaborator’s new track', () => {
    const doc = fixture(); applyChanges(doc, [{ path: trackPath, value: undefined }]);
    const proposal = compile(doc, [motion()]);
    expect(proposal.changes[0].value).toMatchObject({ type: 'move', start: 0, duration: 800, path: curve });
    edit(doc, [motion(original)]);
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  });

  test('requires Move and visible endpoints for a non-null motion path, using final proposal state', () => {
    const doc = fixture();
    applyChanges(doc, [{ path: [...trackPath, 'type'], value: 'fade' }]);
    expect(() => compile(doc, [motion()])).toThrow('Move');
    const move: Operation = { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'type', value: 'move' };
    edit(doc, [motion(), move]);
    applyChanges(doc, [{ path: [...statePath, 'circle', 'visible'], value: false }]);
    expect(() => compile(doc, [motion(original)])).toThrow('両方');
    edit(doc, [motion(original), { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'visible', value: true }]);
    expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(original);
  });

  test('shape paths use relative controls in one composition and guard the source geometry', () => {
    const doc = fixture(); const before = readProject(doc)!.scenes['scene-1'].compositions['comp-2'].states.sigmoid;
    edit(doc, [shape()]);
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-1'].states.sigmoid).toMatchObject({ x: 245, y: 520, width: 710, height: -330, path: relative });
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-2'].states.sigmoid).toEqual(before);
    const proposal = compile(doc, [{ ...shape(), path: curve } as Operation]);
    applyChanges(doc, [{ path: [...statePath, 'sigmoid', 'rotation'], value: 30 }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
    expect(() => compile(doc, [{ action: 'setShapePath', compositionId: 'comp-1', objectId: 'circle', path: relative }])).toThrow('ベジェ曲線');
  });

  test('rejects invalid controls, protected identifiers, and locked objects', () => {
    const doc = fixture();
    for (const x of [Number.NaN, Infinity, 10001]) expect(() => compile(doc, [motion({ c1: { x, y: 100 }, c2: curve.c2 })])).toThrow();
    expect(() => compile(doc, [motion(curve, 'constructor')])).toThrow();
    applyChanges(doc, [{ path: ['scenes', 'scene-1', 'objects', 'circle', 'locked'], value: true }]);
    expect(() => compile(doc, [motion()])).toThrow('ロック');
  });

  test('Composition selection permits an identified Transition, with peer-safe Apply and Undo', () => {
    const doc = fixture(); const before = readProject(doc)!;
    const scope: EditScope = { selectedIds: ['circle'], compositionId: 'comp-1', transitionId: null };
    const proposal = compile(doc, [motion()], scope);
    const manager = new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    applyChanges(doc, [{ path: [...statePath, 'circle', 'fill'], value: '#f4ce55' }], 'peer');
    validateProposalForApply(doc, proposal); applyChanges(doc, proposal.changes);
    expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks.circle.path).toEqual(curve);
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-2']).toEqual(before.scenes['scene-1'].compositions['comp-2']);
    manager.undo();
    expect(readProject(doc)!.scenes['scene-1'].transitions).toEqual(before.scenes['scene-1'].transitions);
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-1'].states.circle.fill).toBe('#f4ce55');
  });

  test('explicit targets can span objects, compositions and transitions beyond the selection', () => {
    const project = makeDemoProject(); const scene = project.scenes['scene-1'];
    scene.compositionOrder.push('comp-3');
    scene.compositions['comp-3'] = { ...structuredClone(scene.compositions['comp-2']), id: 'comp-3', name: 'Composition 3' };
    scene.transitions['transition-2'] = { ...structuredClone(scene.transitions['transition-1']), id: 'transition-2', fromId: 'comp-2', toId: 'comp-3' };
    const doc = fixture(project); const before = readProject(doc)!;
    const scope: EditScope = { selectedIds: ['circle'], compositionId: 'comp-1', transitionId: null };
    const operations: Operation[] = [motion(), shape(),
      { action: 'setState', compositionId: 'comp-2', objectId: 'circle', property: 'x', value: 950 },
      { action: 'setCompositionDuration', compositionId: 'comp-3', duration: 2000 },
      { action: 'setMotionPath', transitionId: 'transition-2', objectId: 'circle', path: curve },
      { action: 'setTrack', transitionId: 'transition-2', objectId: 'circle', property: 'easing', value: 'linear' },
    ];
    const proposal = compile(doc, operations, scope);
    validateProposalForApply(doc, proposal); applyChanges(doc, proposal.changes);
    const after = readProject(doc)!.scenes['scene-1'];
    expect(after.compositions['comp-1'].states.sigmoid.path).toEqual(relative);
    expect(after.compositions['comp-2'].states.circle.x).toBe(950);
    expect(after.compositions['comp-3'].duration).toBe(2000);
    for (const id of ['transition-1', 'transition-2']) {
      expect(after.transitions[id].tracks.circle.path).toEqual(curve);
      expect(after.transitions[id].tracks.equation).toEqual(before.scenes['scene-1'].transitions[id].tracks.equation);
    }
    expect(after.transitions['transition-2'].tracks.circle.easing).toBe('linear');
    for (const id of scene.compositionOrder) expect(after.compositions[id].states.equation).toEqual(before.scenes['scene-1'].compositions[id].states.equation);
    const late = compile(doc, [{ action: 'setMotionPath', transitionId: 'transition-2', objectId: 'circle', path: relative }], scope);
    applyChanges(doc, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-3', 'states', 'circle', 'y'], value: 300 }], 'peer');
    expect(() => validateProposalForApply(doc, late)).toThrow('提案後');
  });

  test('selection context never relaxes locked targets, actual IDs or final timing validation', () => {
    const doc = fixture(); const scope: EditScope = { selectedIds: ['circle'], compositionId: 'comp-1', transitionId: null };
    applyChanges(doc, [{ path: ['scenes', 'scene-1', 'objects', 'sigmoid', 'locked'], value: true }]);
    expect(() => compile(doc, [motion(), shape()], scope)).toThrow('ロック');
    expect(() => compile(doc, [{ action: 'setState', compositionId: 'another-scene-comp', objectId: 'circle', property: 'x', value: 950 }], scope)).toThrow('Composition');
    expect(() => compile(doc, [{ action: 'setTrack', transitionId: 'another-scene-transition', objectId: 'circle', property: 'duration', value: 400 }], scope)).toThrow('Transition');
    expect(() => compile(doc, [motion(), { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'start', value: 700 }], scope)).toThrow('範囲');
    expect(() => compile(doc, [{ action: 'addObject', compositionId: 'comp-2', name: 'New text', kind: 'text', x: 500, y: 100, width: 200, height: 40, fill: '#ffffff', text: 'Hello', fontSize: 30 }], scope)).not.toThrow();
  });
});
