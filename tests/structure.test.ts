import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, getShared, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { parseProjectFile } from '../shared/project-file';
import { duplicateComposition, deleteComposition } from '../src/editor/structure';

function document() { const doc = new Y.Doc(); initializeDocument(doc, makeDemoProject()); return doc; }
const scene = (doc: Y.Doc) => readProject(doc)!.scenes['scene-1'];
const statePath = (id: string, key: string) => ['scenes', 'scene-1', 'compositions', id, 'states', 'circle', key];
const undoManager = (doc: Y.Doc) => new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
function fork(doc: Y.Doc) { const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc)); return copy; }
function merge(first: Y.Doc, second: Y.Doc) {
  const firstUpdate = Y.encodeStateAsUpdate(first), secondUpdate = Y.encodeStateAsUpdate(second);
  Y.applyUpdate(first, secondUpdate); Y.applyUpdate(second, firstUpdate);
  expect(readProject(first)).toEqual(readProject(second));
}
function assertEditableAndPortable(doc: Y.Doc) {
  const project = readProject(doc)!;
  const current = project.scenes['scene-1'];
  expect(current.compositionOrder.length).toBeGreaterThan(0);
  expect(Object.keys(current.transitions)).toHaveLength(current.compositionOrder.length - 1);
  for (const transition of Object.values(current.transitions)) {
    expect(getShared(doc, ['scenes', current.id, 'transitions', transition.id])).toBeInstanceOf(Y.Map);
    expect(current.compositionOrder[current.compositionOrder.indexOf(transition.fromId) + 1]).toBe(transition.toId);
  }
  const saved = JSON.stringify(project);
  expect(saved).not.toContain('"deleted":');
  expect(saved).not.toContain('"incomingTransitionId":');
  const imported = new Y.Doc(); initializeDocument(imported, parseProjectFile(saved));
  expect(readProject(imported)).toEqual(project);
  imported.destroy();
}

describe('composition structure', () => {
  it('duplicates states independently in one transaction, preserving locked objects and outgoing animation identity', () => {
    const doc = document();
    applyChanges(doc, [{ path: ['scenes', 'scene-1', 'objects', 'circle', 'locked'], value: true }]);
    const original = scene(doc);
    const transitionMap = getShared(doc, ['scenes', 'scene-1', 'transitions', 'transition-1']);
    const updates: unknown[] = [];
    doc.on('update', (_update, origin) => {
      updates.push(origin);
      parseProjectFile(JSON.stringify(readProject(doc)));
    });
    const copyId = duplicateComposition(doc, 'scene-1', 'comp-1');
    expect(updates).toEqual([LOCAL_ORIGIN]);
    const changed = scene(doc);
    expect(changed.compositionOrder).toEqual(['comp-1', copyId, 'comp-2']);
    expect(changed.compositions[copyId].states).toEqual(original.compositions['comp-1'].states);
    expect(changed.objects).toEqual(original.objects);
    expect(changed.compositions[copyId].duration).toBe(1000);
    expect(changed.transitions['transition-1']).toEqual({ ...original.transitions['transition-1'], fromId: copyId });
    expect(getShared(doc, ['scenes', 'scene-1', 'transitions', 'transition-1'])).toBe(transitionMap);
    expect(Object.values(changed.transitions).find(transition => transition.toId === copyId)).toMatchObject({ fromId: 'comp-1', duration: 800, tracks: {} });
    applyChanges(doc, [{ path: statePath(copyId, 'x'), value: 777 }, { path: [...statePath(copyId, 'path'), 'c1', 'x'], value: 123 }]);
    expect(scene(doc).compositions['comp-1'].states.circle.x).toBe(245);
    expect(scene(doc).compositions['comp-1'].states.circle.path.c1.x).toBe(140);
    expect(scene(doc).objects.circle.locked).toBe(true);
    doc.destroy();
  });

  it('duplicates the last composition and leaves the preceding animation unchanged', () => {
    const doc = document(); const before = scene(doc);
    const copyId = duplicateComposition(doc, 'scene-1', 'comp-2');
    const after = scene(doc);
    expect(after.compositionOrder).toEqual(['comp-1', 'comp-2', copyId]);
    expect(after.transitions['transition-1']).toEqual(before.transitions['transition-1']);
    expect(Object.values(after.transitions).find(transition => transition.toId === copyId)).toMatchObject({ fromId: 'comp-2', duration: 800, tracks: {} });
    parseProjectFile(JSON.stringify(readProject(doc)));
    doc.destroy();
  });

  it('deletes a middle composition, bridges its neighbors, and undo restores all timing and states', () => {
    const doc = document(); const copyId = duplicateComposition(doc, 'scene-1', 'comp-1');
    const undo = undoManager(doc); const before = readProject(doc);
    const updates: unknown[] = [];
    doc.on('update', (_update, origin) => { updates.push(origin); parseProjectFile(JSON.stringify(readProject(doc))); });
    const removed = deleteComposition(doc, 'scene-1', copyId);
    expect(updates).toEqual([LOCAL_ORIGIN]);
    expect(removed.selectedId).toBe('comp-2');
    expect(removed.removedTransitionIds).toHaveLength(2);
    expect(scene(doc).compositionOrder).toEqual(['comp-1', 'comp-2']);
    expect(Object.values(scene(doc).transitions)).toEqual([expect.objectContaining({ fromId: 'comp-1', toId: 'comp-2', duration: 800, tracks: {} })]);
    undo.undo();
    expect(readProject(doc)).toEqual(before);
    undo.destroy(); doc.destroy();
  });

  it.each(['comp-1', 'comp-2'])('deletes an endpoint %s without leaving a dangling transition and protects the last composition', id => {
    const doc = document();
    const result = deleteComposition(doc, 'scene-1', id);
    expect(Object.keys(scene(doc).transitions)).toHaveLength(0);
    expect(scene(doc).compositionOrder).toEqual([result.selectedId]);
    const before = readProject(doc);
    expect(() => deleteComposition(doc, 'scene-1', result.selectedId)).toThrow('最後');
    expect(readProject(doc)).toEqual(before);
    doc.destroy();
  });

  it('uses the newest remote state and local undo preserves the collaborator’s animation edit', () => {
    const alice = document(); const bob = new Y.Doc(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    applyChanges(bob, [{ path: statePath('comp-1', 'x'), value: 320 }]);
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    const undo = undoManager(alice);
    const copyId = duplicateComposition(alice, 'scene-1', 'comp-1');
    expect(scene(alice).compositions[copyId].states.circle.x).toBe(320);
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    applyChanges(bob, [{ path: ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks', 'circle', 'duration'], value: 500 }]);
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    undo.undo(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    expect(scene(bob).compositionOrder).toEqual(['comp-1', 'comp-2']);
    expect(scene(bob).transitions['transition-1'].fromId).toBe('comp-1');
    expect(scene(bob).transitions['transition-1'].tracks.circle.duration).toBe(500);
    expect(scene(bob).compositions['comp-1'].states.circle.x).toBe(320);
    parseProjectFile(JSON.stringify(readProject(bob)));
    undo.destroy(); alice.destroy(); bob.destroy();
  });

  it('rejects a stale menu target deleted by a collaborator without changing anything', () => {
    const alice = document(); const bob = new Y.Doc(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    deleteComposition(bob, 'scene-1', 'comp-1');
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    const before = readProject(alice);
    expect(() => duplicateComposition(alice, 'scene-1', 'comp-1')).toThrow('もう存在');
    expect(() => deleteComposition(alice, 'scene-1', 'comp-1')).toThrow('もう存在');
    expect(readProject(alice)).toEqual(before);
    alice.destroy(); bob.destroy();
  });

  it('retains one deterministic editable state after concurrent deletion of both endpoints, including undo and redo', () => {
    const alice = document(), bob = fork(alice);
    const aliceUndo = undoManager(alice), bobUndo = undoManager(bob);
    deleteComposition(alice, 'scene-1', 'comp-1');
    deleteComposition(bob, 'scene-1', 'comp-2');
    merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-1']);
    expect(getShared(alice, ['scenes', 'scene-1', 'compositions', 'comp-1', 'deleted'])).toBe(true);
    expect(() => deleteComposition(alice, 'scene-1', 'comp-1')).toThrow('最後');
    assertEditableAndPortable(alice);
    bobUndo.undo(); merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-2']);
    bobUndo.redo(); merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-1']);
    aliceUndo.undo(); merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-1']);
    bobUndo.undo(); merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-1', 'comp-2']);
    expect(scene(alice).transitions['transition-1'].tracks.circle.duration).toBe(600);
    assertEditableAndPortable(alice);
    aliceUndo.destroy(); bobUndo.destroy(); alice.destroy(); bob.destroy();
  });

  it('duplicates the retained fallback without hiding it and readProject never writes repair updates', () => {
    const alice = document(), bob = fork(alice);
    deleteComposition(alice, 'scene-1', 'comp-1'); deleteComposition(bob, 'scene-1', 'comp-2'); merge(alice, bob);
    let updates = 0; alice.on('update', () => updates++);
    assertEditableAndPortable(alice); expect(updates).toBe(0);
    const undo = undoManager(alice);
    const copyId = duplicateComposition(alice, 'scene-1', 'comp-1');
    expect(scene(alice).compositionOrder).toEqual(['comp-1', copyId]);
    expect(getShared(alice, ['scenes', 'scene-1', 'compositions', 'comp-1', 'deleted'])).toBe(false);
    assertEditableAndPortable(alice);
    undo.undo(); merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-1']);
    assertEditableAndPortable(alice);
    undo.destroy(); alice.destroy(); bob.destroy();
  });

  it('keeps both concurrent duplicates with editable adjacent transitions and the original outgoing animation', () => {
    const alice = document(), bob = fork(alice);
    const first = duplicateComposition(alice, 'scene-1', 'comp-1');
    const second = duplicateComposition(bob, 'scene-1', 'comp-1');
    merge(alice, bob);
    const current = scene(alice);
    expect(new Set(current.compositionOrder)).toEqual(new Set(['comp-1', first, second, 'comp-2']));
    expect(current.transitions['transition-1']).toMatchObject({ fromId: current.compositionOrder[2], toId: 'comp-2', tracks: { circle: { duration: 600 } } });
    const projected = Object.values(current.transitions).find(transition => getShared(alice, ['scenes', 'scene-1', 'transitions', transition.id, 'fromId']) !== transition.fromId)!;
    expect(projected).toBeDefined();
    // A transition selected through the view can still be edited in the document.
    applyChanges(alice, [{ path: ['scenes', 'scene-1', 'transitions', projected.id, 'duration'], value: 950 }]);
    merge(alice, bob);
    expect(scene(bob).transitions[projected.id].duration).toBe(950);
    assertEditableAndPortable(alice);
    alice.destroy(); bob.destroy();
  });

  it('keeps adjacency and portable state for every pair of concurrent duplicate/delete operations and either local undo order', () => {
    // Exercise endpoints, neighboring middle states, and identical targets in
    // both CRDT insertion orders; replaying Undo also removes locally made maps.
    for (const reverseIds of [false, true]) for (const firstKind of ['duplicate', 'delete']) for (const secondKind of ['duplicate', 'delete']) for (let firstIndex = 0; firstIndex < 3; firstIndex++) for (let secondIndex = 0; secondIndex < 3; secondIndex++) {
      const alice = document(); duplicateComposition(alice, 'scene-1', 'comp-1');
      const bob = fork(alice), ids = scene(alice).compositionOrder;
      alice.clientID = reverseIds ? 200 : 100; bob.clientID = reverseIds ? 100 : 200;
      const firstUndo = undoManager(alice), secondUndo = undoManager(bob);
      (firstKind === 'duplicate' ? duplicateComposition : deleteComposition)(alice, 'scene-1', ids[firstIndex]);
      (secondKind === 'duplicate' ? duplicateComposition : deleteComposition)(bob, 'scene-1', ids[secondIndex]);
      merge(alice, bob); assertEditableAndPortable(alice);
      firstUndo.undo(); merge(alice, bob); assertEditableAndPortable(alice);
      secondUndo.undo(); merge(alice, bob); assertEditableAndPortable(alice);
      expect(scene(alice).compositionOrder).toEqual(ids);
      secondUndo.redo(); merge(alice, bob); assertEditableAndPortable(alice);
      firstUndo.redo(); merge(alice, bob); assertEditableAndPortable(alice);
      firstUndo.destroy(); secondUndo.destroy(); alice.destroy(); bob.destroy();
    }
  });

  it('retains a collaborator’s new composition when its locally created source is undone', () => {
    const alice = document(), bob = fork(alice), undo = undoManager(alice);
    const source = duplicateComposition(alice, 'scene-1', 'comp-1'); merge(alice, bob);
    const peerCopy = duplicateComposition(bob, 'scene-1', source);
    applyChanges(bob, [{ path: statePath(peerCopy, 'x'), value: 888 }]); merge(alice, bob);
    undo.undo(); merge(alice, bob);
    expect(scene(alice).compositionOrder).toEqual(['comp-1', peerCopy, 'comp-2']);
    expect(scene(alice).compositions[peerCopy].states.circle.x).toBe(888);
    assertEditableAndPortable(alice);
    undo.destroy(); alice.destroy(); bob.destroy();
  });
});
