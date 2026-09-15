import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { compileProposal, validateProposalForApply } from '../shared/ai';
import { applyChanges, getShared, getValue, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import { defaultTrack } from '../shared/model';
import { deleteComposition } from '../src/editor/structure';
import { duplicateScene, deleteScene } from '../src/editor/scenes';

const docs: Y.Doc[] = [];
const fixture = (three = false) => {
  const project = makeDemoProject();
  if (three) {
    const scene = project.scenes['scene-1'];
    scene.compositionOrder.push('comp-3');
    scene.compositions['comp-3'] = { ...structuredClone(scene.compositions['comp-2']), id: 'comp-3', name: 'Composition 3' };
    scene.compositions['comp-3'].states.circle.x = 1100;
    scene.compositions['comp-3'].states.circle.y = 260;
    scene.transitions['transition-2'] = { id: 'transition-2', fromId: 'comp-2', toId: 'comp-3', duration: 900, tracks: { circle: defaultTrack('circle', { duration: 900 }) } };
  }
  const doc = new Y.Doc(); initializeDocument(doc, project); docs.push(doc); return doc;
};
const composition = (id: string, property: string) => ['scenes', 'scene-1', 'compositions', id, property];
const state = (id: string, property: string) => [...composition(id, 'states'), 'circle', property];
const proposeState = (doc: Y.Doc) => compileProposal(doc, readProject(doc)!, 'scene-1', { message: '円を移動します。', operations: [{ action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 500 }] });
const proposePath = (doc: Y.Doc) => compileProposal(doc, readProject(doc)!, 'scene-1', { message: '弧を描いて移動します。', operations: [{ action: 'setMotionPath', transitionId: 'transition-2', objectId: 'circle', path: { c1: { x: 450, y: 200 }, c2: { x: 800, y: 100 } } }] });
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });

describe('AI proposals across projected composition structure', () => {
  test('a deleted scene rejects both current and legacy proposals, and Undo restores the original guards', () => {
    const doc = fixture(); duplicateScene(doc, 'scene-1');
    const proposal = proposeState(doc);
    const undo = new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    deleteScene(doc, 'scene-1');
    expect(readProject(doc)!.scenes['scene-1']).toBeUndefined();
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
    expect(() => validateProposalForApply(doc, { ...proposal, guards: [] })).toThrow('Scene が削除');
    undo.undo();
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    undo.destroy();
  });

  test('an unchanged fallback scene stays editable, while disappearing from the project rejects its proposal', () => {
    const doc = fixture(); const other = duplicateScene(doc, 'scene-1');
    applyChanges(doc, [{ path: ['scenes', 'scene-1', 'deleted'], value: true }, { path: ['scenes', other, 'deleted'], value: true }]);
    const proposal = proposeState(doc);
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    // The fallback's own raw map does not change when another scene is revived.
    applyChanges(doc, [{ path: ['scenes', other, 'deleted'], value: false }]);
    expect(() => validateProposalForApply(doc, proposal)).toThrow('Scene が削除');
  });

  test('legacy metadata is guarded as absent; logical deletion rejects a proposal and undo restores its validity', () => {
    const doc = fixture(); const proposal = proposeState(doc);
    expect(proposal.guards).toContainEqual(expect.objectContaining({ path: composition('comp-1', 'deleted'), expected: null, existed: false }));
    expect(proposal.guards).toContainEqual(expect.objectContaining({ path: composition('comp-2', 'incomingTransitionId'), expected: null, existed: false }));
    const undo = new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    const objectMap = getShared(doc, state('comp-1', 'x').slice(0, -1));
    applyChanges(doc, [{ path: composition('comp-1', 'deleted'), value: true }]);
    expect(getShared(doc, state('comp-1', 'x').slice(0, -1))).toBe(objectMap);
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
    undo.undo();
    expect(getValue(doc, composition('comp-1', 'deleted'))).toBeUndefined();
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    undo.destroy();
  });

  test('the actual delete command invalidates a path proposal and one Undo restores the original structure and guards', () => {
    const doc = fixture(true); const proposal = proposePath(doc); const before = readProject(doc);
    const undo = new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    deleteComposition(doc, 'scene-1', 'comp-2');
    expect(readProject(doc)!.scenes['scene-1'].compositionOrder).toEqual(['comp-1', 'comp-3']);
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
    undo.undo();
    expect(readProject(doc)).toEqual(before);
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    undo.destroy();
  });

  test('a raw ordering change invalidates a proposal even if its own fields are untouched', () => {
    const doc = fixture(true); const proposal = proposeState(doc);
    const order = getShared(doc, ['scenes', 'scene-1', 'compositionOrder']) as Y.Array<string>;
    doc.transact(() => { order.delete(1, 2); order.insert(1, ['comp-3', 'comp-2']); }, 'peer');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
    expect(getValue(doc, state('comp-1', 'x'))).toBe(245);
  });

  test('a different composition incoming transition pointer is a structural dependency', () => {
    const doc = fixture(true); const proposal = proposeState(doc);
    applyChanges(doc, [{ path: composition('comp-3', 'incomingTransitionId'), value: 'transition-2' }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  });

  test('metadata of raw hidden compositions is guarded while unrelated property edits stay valid', () => {
    const doc = fixture(true);
    applyChanges(doc, [{ path: composition('comp-2', 'deleted'), value: true }]);
    const proposal = proposeState(doc);
    expect(proposal.guards).toContainEqual(expect.objectContaining({ path: composition('comp-2', 'deleted'), expected: true, existed: true }));
    applyChanges(doc, [{ path: state('comp-3', 'fill'), value: '#f4ce55' }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    applyChanges(doc, [{ path: composition('comp-2', 'deleted'), value: false }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  });

  test('a new proposal uses the projected source anchors instead of the raw deleted source', () => {
    const doc = fixture(true);
    applyChanges(doc, [{ path: composition('comp-2', 'deleted'), value: true }, { path: composition('comp-3', 'incomingTransitionId'), value: 'transition-2' }]);
    const view = readProject(doc)!;
    expect(getValue(doc, ['scenes', 'scene-1', 'transitions', 'transition-2', 'fromId'])).toBe('comp-2');
    expect(view.scenes['scene-1'].transitions['transition-2'].fromId).toBe('comp-1');
    const proposal = proposePath(doc);
    expect(proposal.guards).toContainEqual(expect.objectContaining({ path: state('comp-1', 'x'), expected: 245 }));
    expect(proposal.guards).not.toContainEqual(expect.objectContaining({ path: state('comp-2', 'x') }));
    applyChanges(doc, [{ path: state('comp-2', 'x'), value: 880 }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    applyChanges(doc, [{ path: state('comp-1', 'x'), value: 320 }], 'peer');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  });

  test('deleting the intermediate composition after a path proposal invalidates the changed visible source', () => {
    const doc = fixture(true); const proposal = proposePath(doc);
    applyChanges(doc, [{ path: composition('comp-2', 'deleted'), value: true }], 'peer');
    expect(readProject(doc)!.scenes['scene-1'].transitions['transition-2'].fromId).toBe('comp-1');
    expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  });

  test('the last visible fallback remains editable when every raw composition has deleted=true', () => {
    const doc = fixture();
    applyChanges(doc, [{ path: composition('comp-1', 'deleted'), value: true }, { path: composition('comp-2', 'deleted'), value: true }]);
    const project = readProject(doc)!;
    expect(project.scenes['scene-1'].compositionOrder).toEqual(['comp-1']);
    const proposal = proposeState(doc);
    expect(proposal.guards).toContainEqual(expect.objectContaining({ path: composition('comp-1', 'deleted'), expected: true, existed: true }));
    expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
    applyChanges(doc, proposal.changes);
    expect(readProject(doc)!.scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(500);
  });
});
