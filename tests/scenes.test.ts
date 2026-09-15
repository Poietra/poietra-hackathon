import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeBlankScene, makeDemoProject } from '../shared/demo';
import { applyChanges, getShared, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { parseProjectFile } from '../shared/project-file';
import { deleteScene, duplicateScene, renameScene } from '../src/editor/scenes';
import { deleteComposition } from '../src/editor/structure';

function document(count = 2) {
  const project = makeDemoProject();
  for (let index = 2; index <= count; index++) {
    const id = `scene-${index}`;
    project.scenes[id] = makeBlankScene(id, `Scene ${index}`); project.sceneOrder.push(id);
  }
  const doc = new Y.Doc(); initializeDocument(doc, project); return doc;
}
const project = (doc: Y.Doc) => readProject(doc)!;
const undoManager = (doc: Y.Doc) => new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
function fork(doc: Y.Doc) { const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc)); return peer; }
function merge(first: Y.Doc, second: Y.Doc) {
  const firstUpdate = Y.encodeStateAsUpdate(first), secondUpdate = Y.encodeStateAsUpdate(second);
  Y.applyUpdate(first, secondUpdate); Y.applyUpdate(second, firstUpdate);
  expect(project(first)).toEqual(project(second));
}
function portable(doc: Y.Doc) {
  const value = project(doc), text = JSON.stringify(value);
  expect(value.sceneOrder.length).toBeGreaterThan(0);
  expect(Object.keys(value.scenes)).toEqual(value.sceneOrder);
  expect(text).not.toContain('"deleted":'); expect(text).not.toContain('"incomingTransitionId":');
  for (const id of value.sceneOrder) expect(getShared(doc, ['scenes', id])).toBeInstanceOf(Y.Map);
  const copy = new Y.Doc(); initializeDocument(copy, parseProjectFile(text));
  expect(project(copy)).toEqual(value); copy.destroy();
}

describe('scene management', () => {
  it('copies complete animation data independently and remaps every internal ID in one transaction', () => {
    const doc = document();
    applyChanges(doc, [
      { path: ['scenes', 'scene-1', 'objects', 'circle', 'groupId'], value: 'linked' },
      { path: ['scenes', 'scene-1', 'objects', 'sigmoid', 'groupId'], value: 'linked' },
      { path: ['scenes', 'scene-1', 'objects', 'circle', 'locked'], value: true },
    ]);
    const source = project(doc).scenes['scene-1'];
    const updates: unknown[] = []; doc.on('update', (_update, origin) => { updates.push(origin); portable(doc); });
    const copyId = duplicateScene(doc, 'scene-1');
    expect(updates).toEqual([LOCAL_ORIGIN]);
    const copy = project(doc).scenes[copyId];
    expect(project(doc).sceneOrder).toEqual(['scene-1', copyId, 'scene-2']);
    expect(copy.name).toBe('Scene 1 copy');
    const oldIds = new Set([source.id, ...Object.keys(source.objects), ...source.compositionOrder, ...Object.keys(source.transitions), 'linked']);
    const newIds = [copy.id, ...Object.keys(copy.objects), ...copy.compositionOrder, ...Object.keys(copy.transitions), ...Object.values(copy.objects).flatMap(object => object.groupId ? [object.groupId] : [])];
    expect(newIds.every(id => !oldIds.has(id))).toBe(true);
    const mapping = new Map(Object.values(source.objects).map(object => [object.id, Object.values(copy.objects).find(candidate => candidate.name === object.name)!.id]));
    for (const object of Object.values(source.objects)) expect(copy.objects[mapping.get(object.id)!]).toMatchObject({ kind: object.kind, locked: object.locked, order: object.order });
    expect(copy.objects[mapping.get('circle')!].groupId).toBe(copy.objects[mapping.get('sigmoid')!].groupId);
    source.compositionOrder.forEach((id, index) => {
      const original = source.compositions[id], state = copy.compositions[copy.compositionOrder[index]];
      expect(state.duration).toBe(original.duration);
      for (const [objectId, value] of Object.entries(original.states)) expect(state.states[mapping.get(objectId)!]).toEqual(value);
    });
    const transition = Object.values(copy.transitions)[0];
    expect(transition.fromId).toBe(copy.compositionOrder[0]); expect(transition.toId).toBe(copy.compositionOrder[1]);
    for (const [id, track] of Object.entries(source.transitions['transition-1'].tracks)) expect(transition.tracks[mapping.get(id)!]).toEqual({ ...track, objectId: mapping.get(id) });
    applyChanges(doc, [{ path: ['scenes', copyId, 'compositions', copy.compositionOrder[0], 'states', mapping.get('circle')!, 'x'], value: 777 }]);
    expect(project(doc).scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(245);
    doc.destroy();
  });

  it('copies only visible compositions and keeps long names within the portable limit', () => {
    const doc = document(); renameScene(doc, 'scene-1', 'A'.repeat(220));
    deleteComposition(doc, 'scene-1', 'comp-1');
    const id = duplicateScene(doc, 'scene-1'), copy = project(doc).scenes[id];
    expect(copy.name).toHaveLength(200); expect(copy.name.endsWith(' copy')).toBe(true);
    expect(copy.compositionOrder).toHaveLength(1); expect(Object.keys(copy.transitions)).toHaveLength(0);
    expect(Object.values(copy.compositions)[0].states[Object.values(copy.objects).find(object => object.name === 'Circle')!.id].x).toBe(955);
    portable(doc); doc.destroy();
  });

  it('deletion Undo restores the same shared Scene with edits made by an offline peer', () => {
    const alice = document(), bob = fork(alice), undo = undoManager(alice);
    const originalMap = getShared(alice, ['scenes', 'scene-1']);
    deleteScene(alice, 'scene-1');
    renameScene(bob, 'scene-1', 'Peer title');
    applyChanges(bob, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', 'x'], value: 444 }]);
    merge(alice, bob);
    expect(project(alice).sceneOrder).toEqual(['scene-2']);
    undo.undo(); merge(alice, bob);
    expect(getShared(alice, ['scenes', 'scene-1'])).toBe(originalMap);
    expect(project(alice).scenes['scene-1'].name).toBe('Peer title');
    expect(project(alice).scenes['scene-1'].compositions['comp-1'].states.circle.x).toBe(444);
    portable(alice); undo.destroy(); alice.destroy(); bob.destroy();
  });

  it('rename Undo preserves a later peer name and duplicate Undo preserves peer edits to the source', () => {
    const alice = document(), bob = fork(alice), undo = undoManager(alice);
    renameScene(alice, 'scene-1', 'My title'); merge(alice, bob);
    renameScene(bob, 'scene-1', 'Peer title'); merge(alice, bob);
    undo.undo(); merge(alice, bob); expect(project(alice).scenes['scene-1'].name).toBe('Peer title');
    const id = duplicateScene(alice, 'scene-1'); merge(alice, bob);
    applyChanges(bob, [{ path: ['scenes', 'scene-1', 'compositions', 'comp-1', 'states', 'circle', 'fill'], value: '#ff0000' }]); merge(alice, bob);
    undo.undo(); merge(alice, bob);
    expect(project(alice).scenes[id]).toBeUndefined(); expect(project(alice).scenes['scene-1'].compositions['comp-1'].states.circle.fill).toBe('#ff0000');
    portable(alice); undo.destroy(); alice.destroy(); bob.destroy();
  });

  it('opposite offline deletes retain one deterministic editable Scene without repair writes', () => {
    const alice = document(), bob = fork(alice), undo = undoManager(alice);
    deleteScene(alice, 'scene-1'); deleteScene(bob, 'scene-2'); merge(alice, bob);
    expect(project(alice).sceneOrder).toEqual(['scene-1']);
    expect(getShared(alice, ['scenes', 'scene-1', 'deleted'])).toBe(true);
    let repairs = 0; alice.on('update', () => repairs++);
    portable(alice); expect(repairs).toBe(0);
    expect(() => deleteScene(alice, 'scene-1')).toThrow('最後');
    renameScene(alice, 'scene-1', 'Retained scene');
    const copy = duplicateScene(alice, 'scene-1');
    expect(project(alice).sceneOrder).toEqual(['scene-1', copy]);
    undo.undo(); merge(alice, bob);
    expect(project(alice).sceneOrder).toEqual(['scene-1']); portable(alice);
    undo.destroy(); alice.destroy(); bob.destroy();
  });

  it('rejects stale menu targets and refuses to delete the last Scene without updates', () => {
    const doc = document(); deleteScene(doc, 'scene-1'); const before = project(doc);
    expect(() => renameScene(doc, 'scene-1', 'Stale')).toThrow('もう存在');
    expect(() => duplicateScene(doc, 'scene-1')).toThrow('もう存在');
    expect(() => deleteScene(doc, 'scene-1')).toThrow('もう存在');
    expect(() => deleteScene(doc, 'scene-2')).toThrow('最後');
    expect(() => renameScene(doc, 'scene-2', '   ')).toThrow('名前');
    expect(project(doc)).toEqual(before); doc.destroy();
  });

  it('keeps concurrent Scene operations portable after either Undo order', () => {
    for (const firstKind of ['duplicate', 'delete']) for (const secondKind of ['duplicate', 'delete']) for (let firstIndex = 0; firstIndex < 3; firstIndex++) for (let secondIndex = 0; secondIndex < 3; secondIndex++) {
      const alice = document(3), bob = fork(alice), ids = project(alice).sceneOrder;
      const aliceUndo = undoManager(alice), bobUndo = undoManager(bob);
      (firstKind === 'duplicate' ? duplicateScene : deleteScene)(alice, ids[firstIndex]);
      (secondKind === 'duplicate' ? duplicateScene : deleteScene)(bob, ids[secondIndex]);
      merge(alice, bob); portable(alice);
      aliceUndo.undo(); merge(alice, bob); portable(alice);
      bobUndo.undo(); merge(alice, bob); portable(alice); expect(project(alice).sceneOrder).toEqual(ids);
      bobUndo.redo(); merge(alice, bob); portable(alice);
      aliceUndo.redo(); merge(alice, bob); portable(alice);
      aliceUndo.destroy(); bobUndo.destroy(); alice.destroy(); bob.destroy();
    }
  });
});
