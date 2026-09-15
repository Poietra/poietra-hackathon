import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyChanges, getShared, initializeDocument, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import { parseProjectFile } from '../shared/project-file';
import { EditorStore } from '../src/editor/store';
import { EditorUndoManager, undoPreservingPeerTracks } from '../src/editor/undo';

const documents: Y.Doc[] = [];
afterEach(() => { for (const doc of documents.splice(0)) doc.destroy(); });
function replicas() {
  const seed = new Y.Doc(); documents.push(seed); initializeDocument(seed, makeDemoProject());
  const stores = [100, 200].map(clientID => {
    const doc = new Y.Doc(); documents.push(doc); doc.clientID = clientID;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    // Exercise real store edit methods and UndoManager without networking/IndexedDB.
    return Object.assign(Object.create(EditorStore.prototype), { doc, undoManager: new EditorUndoManager(doc) }) as EditorStore;
  });
  const sync = () => {
    Y.applyUpdate(stores[0].doc, Y.encodeStateAsUpdate(stores[1].doc));
    Y.applyUpdate(stores[1].doc, Y.encodeStateAsUpdate(stores[0].doc));
    expect(readProject(stores[0].doc)).toEqual(readProject(stores[1].doc));
    expect(() => parseProjectFile(JSON.stringify(readProject(stores[0].doc)))).not.toThrow();
  };
  return { alice: stores[0], bob: stores[1], sync };
}
const transition = (store: EditorStore) => store.scene('scene-1').transitions['transition-1'];
const circle = (store: EditorStore) => store.scene('scene-1').compositions['comp-1'].states.circle;

it('does not erase a peer Circle timing edit when independently extending the Transition', () => {
  const { alice, bob, sync } = replicas();
  alice.setTrack('scene-1', 'transition-1', 'circle', { duration: 700 });
  bob.setTransitionDuration('scene-1', 'transition-1', 1000);
  sync();
  expect(transition(alice).duration).toBe(1000);
  expect(transition(alice).tracks.circle.duration).toBe(700);
  undoPreservingPeerTracks(bob.undoManager); sync();
  expect(transition(alice).duration).toBe(800);
  expect(transition(alice).tracks.circle.duration).toBe(700);
});
it('retains independent horizontal and vertical movement instead of publishing unchanged axes', () => {
  const { alice, bob, sync } = replicas(), start = { circle: { x: 245, y: 520 } };
  alice.translate('scene-1', 'comp-1', start, 100, 0);
  bob.translate('scene-1', 'comp-1', start, 0, 80);
  sync(); expect(circle(alice)).toMatchObject({ x: 345, y: 600 });
  undoPreservingPeerTracks(alice.undoManager); sync(); expect(circle(alice)).toMatchObject({ x: 245, y: 600 });
});
it('keeps actual clamps and peer edits to other objects when shortening a Transition', () => {
  const { alice, bob, sync } = replicas();
  alice.updateState('scene-1', 'comp-1', 'circle', { x: 390 });
  bob.setTransitionDuration('scene-1', 'transition-1', 500);
  sync();
  expect(circle(alice).x).toBe(390);
  expect(transition(alice).tracks.circle).toMatchObject({ start: 0, duration: 500 });
  expect(transition(alice).tracks.equation).toMatchObject({ start: 400, duration: 100 });
  undoPreservingPeerTracks(bob.undoManager); sync();
  expect(circle(alice).x).toBe(390); expect(transition(alice).tracks.circle.duration).toBe(600);
});
it('creates no update or Undo item for a repeated primitive value', () => {
  const { alice } = replicas(); let updates = 0; alice.doc.on('update', () => updates++);
  alice.updateState('scene-1', 'comp-1', 'circle', { x: 245 });
  alice.setTrack('scene-1', 'transition-1', 'circle', { start: 0 });
  expect(updates).toBe(0); expect(alice.undoManager.canUndo()).toBe(false);
});
it('preserves create/delete/null, explicit array/map replacement and ordered repeated changes', () => {
  const { alice } = replicas(), base = ['scenes', 'scene-1'];
  applyChanges(alice.doc, [{ path: [...base, 'objects', 'circle', 'groupId'], value: 'g' }, { path: [...base, 'objects', 'circle', 'groupId'], value: null }]);
  expect(getShared(alice.doc, [...base, 'objects', 'circle', 'groupId'])).toBeNull();
  const original = getShared(alice.doc, [...base, 'compositionOrder']);
  applyChanges(alice.doc, [{ path: [...base, 'compositionOrder'], value: ['comp-1', 'comp-2'] }]);
  expect(getShared(alice.doc, [...base, 'compositionOrder'])).toBeInstanceOf(Y.Array);
  expect(getShared(alice.doc, [...base, 'compositionOrder'])).not.toBe(original);
  const path = [...base, 'transitions', 'transition-1', 'tracks', 'sigmoid'];
  alice.setTrack('scene-1', 'transition-1', 'sigmoid', { path: null });
  expect(getShared(alice.doc, path)).toBeInstanceOf(Y.Map);
  expect(getShared(alice.doc, [...path, 'path'])).toBeNull();
  applyChanges(alice.doc, [{ path, value: undefined }]); expect(getShared(alice.doc, path)).toBeUndefined();
  applyChanges(alice.doc, [{ path: [...base, 'compositions', 'comp-1', 'states', 'circle', 'x'], value: 500 }, { path: [...base, 'compositions', 'comp-1', 'states', 'circle', 'x'], value: 245 }]);
  expect(circle(alice).x).toBe(245);
});
