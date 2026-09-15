import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, initializeDocument, readProject, type Change } from '../shared/document';
import { defaultTrack } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import { groupAnimationChanges } from '../src/editor/groups';
import { EditorUndoManager, undoPreservingPeerTracks } from '../src/editor/undo';

const docs: Y.Doc[] = [];
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });
const base = ['scenes', 'scene-1', 'transitions', 'transition-1', 'tracks'];
function fixture() {
  const alice = new Y.Doc(), bob = new Y.Doc(); docs.push(alice, bob);
  initializeDocument(alice, makeDemoProject());
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  expect(alice.clientID).not.toBe(bob.clientID);
  const manager = new EditorUndoManager(alice);
  const edit = (changes: Change[]) => { manager.stopCapturing(); applyChanges(alice, changes); manager.stopCapturing(); };
  const sync = () => { Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice)); Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob)); };
  const tracks = (doc = alice) => readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks;
  const valid = () => {
    sync();
    expect(readProject(alice)).toEqual(readProject(bob));
    for (const doc of [alice, bob]) expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
  };
  return { alice, bob, manager, edit, sync, tracks, valid, undo: () => undoPreservingPeerTracks(manager) };
}

describe('Undo of newly shared animation tracks', () => {
  test('removes untouched new tracks, restores existing fields, and recreates them on Redo', () => {
    const f = fixture();
    f.edit(groupAnimationChanges(readProject(f.alice)!.scenes['scene-1'], 'transition-1', ['circle', 'sigmoid'], { duration: 400 }));
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400 }));
    f.sync(); expect(f.undo()).toBe(0);
    expect(f.tracks().sigmoid).toBeUndefined(); expect(f.tracks().circle.duration).toBe(600);
    f.valid(); f.manager.redo();
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400 }));
    expect(f.tracks().circle.duration).toBe(400); f.valid();
  });

  test('peer edits to another track or the project name do not protect an untouched new track', () => {
    const f = fixture();
    f.edit([{ path: [...base, 'sigmoid'], value: defaultTrack('sigmoid', { duration: 400 }) }]); f.sync();
    applyChanges(f.bob, [{ path: ['name'], value: 'Peer title' }, { path: [...base, 'circle', 'easing'], value: 'easeOut' }]); f.sync();
    expect(f.undo()).toBe(0); expect(f.tracks().sigmoid).toBeUndefined();
    expect(readProject(f.alice)!.name).toBe('Peer title'); expect(f.tracks().circle.easing).toBe('easeOut'); f.valid();
  });

  test('retains a complete peer-edited new track while undoing the existing track in the same group operation', () => {
    const f = fixture();
    f.edit(groupAnimationChanges(readProject(f.alice)!.scenes['scene-1'], 'transition-1', ['circle', 'sigmoid'], { duration: 400 }));
    f.sync(); applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'easing'], value: 'easeOut' }]); f.sync();
    expect(f.undo()).toBe(1);
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut' }));
    expect(f.tracks().circle.duration).toBe(600); f.valid();
    f.manager.redo(); expect(f.tracks().circle.duration).toBe(400);
    expect(f.tracks().sigmoid.easing).toBe('easeOut'); f.valid();
    expect(f.undo()).toBe(0); expect(f.tracks().circle.duration).toBe(600); f.valid();
  });

  test('a fully retained creation consumes exactly one Undo and never skips into the previous action', () => {
    const f = fixture();
    f.edit([{ path: ['name'], value: 'Earlier local action' }]);
    f.edit([{ path: [...base, 'sigmoid'], value: defaultTrack('sigmoid', { duration: 400 }) }]);
    f.sync(); applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'easing'], value: 'easeOut' }]); f.sync();
    expect(f.manager.undoStack).toHaveLength(2);
    expect(f.undo()).toBe(1);
    expect(readProject(f.alice)!.name).toBe('Earlier local action');
    expect(f.manager.undoStack).toHaveLength(1); expect(f.manager.canRedo()).toBe(false);
    expect(f.undo()).toBe(0); expect(readProject(f.alice)!.name).toBe(makeDemoProject().name);
    f.manager.redo(); expect(readProject(f.alice)!.name).toBe('Earlier local action');
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut' })); f.valid();
  });

  test('later local field edits Undo normally and Redo respects newer peer values', () => {
    const f = fixture();
    f.edit([{ path: [...base, 'sigmoid'], value: defaultTrack('sigmoid', { duration: 400 }) }]);
    f.sync(); applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'easing'], value: 'easeOut' }]); f.sync();
    f.edit([{ path: [...base, 'sigmoid', 'duration'], value: 300 }]);
    expect(f.undo()).toBe(0); expect(f.tracks().sigmoid.duration).toBe(400);
    expect(f.undo()).toBe(1); expect(f.tracks().sigmoid.easing).toBe('easeOut'); f.valid();
    applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'duration'], value: 200 }]); f.sync();
    f.manager.redo(); expect(f.tracks().sigmoid.duration).toBe(200);
    expect(f.tracks().sigmoid.easing).toBe('easeOut'); f.valid();
  });

  test('finds peer edits inside a Bézier map and retains all required initial fields', () => {
    const f = fixture();
    const track = defaultTrack('sigmoid', { duration: 400, path: { c1: { x: 100, y: 120 }, c2: { x: 300, y: 320 } } });
    f.edit([{ path: [...base, 'sigmoid'], value: track }]); f.sync();
    applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'path', 'c1', 'y'], value: 250 }]); f.sync();
    expect(f.undo()).toBe(1);
    expect(f.tracks().sigmoid).toEqual({ ...track, path: { c1: { x: 100, y: 250 }, c2: { x: 300, y: 320 } } }); f.valid();
  });

  test('a local field superseded by a peer cannot make Yjs skip into an unprotected creation', () => {
    const f = fixture();
    f.edit([{ path: ['name'], value: 'Earlier local action' }]);
    f.edit([{ path: [...base, 'sigmoid'], value: defaultTrack('sigmoid', { duration: 400 }) }]);
    f.edit([{ path: [...base, 'sigmoid', 'duration'], value: 300 }]); f.sync();
    applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'duration'], value: 200 }]); f.sync();
    expect(f.undo()).toBe(1);
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 200 }));
    expect(readProject(f.alice)!.name).toBe('Earlier local action');
    expect(f.manager.undoStack).toHaveLength(1); f.valid();
    expect(f.undo()).toBe(0); expect(readProject(f.alice)!.name).toBe(makeDemoProject().name); f.valid();
  });

  test('remembers peer ownership after local overwrite and Undo recreates that same field with a local Item ID', () => {
    const f = fixture();
    f.edit([{ path: [...base, 'sigmoid'], value: defaultTrack('sigmoid', { duration: 400 }) }]); f.sync();
    applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'easing'], value: 'easeOut' }]); f.sync();
    f.edit([{ path: [...base, 'sigmoid', 'easing'], value: 'linear' }]);
    expect(f.undo()).toBe(0); expect(f.tracks().sigmoid.easing).toBe('easeOut');
    expect(f.undo()).toBe(1);
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut' })); f.valid();
    f.manager.redo(); expect(f.tracks().sigmoid.easing).toBe('linear');
    expect(f.undo()).toBe(0); expect(f.tracks().sigmoid.easing).toBe('easeOut'); f.valid();
  });

  test('retains a recreated track after Redo when the peer edits its new Y.Map', () => {
    const f = fixture();
    f.edit([{ path: [...base, 'sigmoid'], value: defaultTrack('sigmoid', { duration: 400 }) }]);
    expect(f.undo()).toBe(0); f.manager.redo(); f.sync();
    applyChanges(f.bob, [{ path: [...base, 'sigmoid', 'easing'], value: 'easeOut' }]); f.sync();
    expect(f.undo()).toBe(1);
    expect(f.tracks().sigmoid).toEqual(defaultTrack('sigmoid', { duration: 400, easing: 'easeOut' })); f.valid();
  });

  test('leaves normal field Undo behavior on pre-existing tracks unchanged', () => {
    const f = fixture();
    f.edit([{ path: [...base, 'circle', 'duration'], value: 400 }]); f.sync();
    applyChanges(f.bob, [{ path: [...base, 'circle', 'easing'], value: 'easeOut' }]); f.sync();
    expect(f.undo()).toBe(0);
    expect(f.tracks().circle.duration).toBe(600); expect(f.tracks().circle.easing).toBe('easeOut'); f.valid();
  });
});
