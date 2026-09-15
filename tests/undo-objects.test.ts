import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, initializeDocument, readProject, type Change } from '../shared/document';
import { defaultState, defaultTrack } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import { EditorUndoManager, redoPreservingPeerDurations, undoPreservingPeerTracks } from '../src/editor/undo';
import { duplicateScene } from '../src/editor/scenes';
import { duplicateComposition } from '../src/editor/structure';

const docs: Y.Doc[] = [];
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });
const scenePath = ['scenes', 'scene-1'];
const statePath = (id = 'created', composition = 'comp-1') => [...scenePath, 'compositions', composition, 'states', id];
const trackPath = (id = 'created') => [...scenePath, 'transitions', 'transition-1', 'tracks', id];
const transitionDuration = [...scenePath, 'transitions', 'transition-1', 'duration'];
function fixture() {
  const alice = new Y.Doc(), bob = new Y.Doc(); docs.push(alice, bob);
  initializeDocument(alice, makeDemoProject()); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  expect(alice.clientID).not.toBe(bob.clientID);
  const manager = new EditorUndoManager(alice);
  const edit = (changes: Change[]) => { manager.stopCapturing(); applyChanges(alice, changes); manager.stopCapturing(); };
  const sync = () => { Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice)); Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob)); };
  const scene = (doc = alice) => readProject(doc)!.scenes['scene-1'];
  const create = (id = 'created', track = true): Change[] => [
    { path: [...scenePath, 'objects', id], value: { id, name: id, kind: 'circle', order: 10, groupId: null, locked: false } },
    ...scene().compositionOrder.map((composition, index) => ({ path: statePath(id, composition), value: defaultState('circle', { x: 100 + 200 * index, fill: '#ffffff' }) })),
    ...(track ? [{ path: trackPath(id), value: defaultTrack(id, { duration: 400 }) }] : []),
  ];
  const valid = () => {
    sync(); expect(readProject(alice)).toEqual(readProject(bob));
    for (const doc of [alice, bob]) expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
  };
  const undo = () => { const tracks = undoPreservingPeerTracks(manager); return { tracks, objects: manager.lastUndoPreservedObjects }; };
  const peer = (changes: Change[]) => { applyChanges(bob, changes); sync(); };
  return { alice, bob, manager, scene, edit, create, sync, peer, valid, undo };
}

describe('Undo of newly shared objects', () => {
  test('untouched manual/AI creation removes identity, every state and track; Redo restores valid data', () => {
    const f = fixture(); f.edit(f.create()); f.sync();
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    expect(f.scene().objects.created).toBeUndefined();
    for (const composition of Object.values(f.scene().compositions)) expect(composition.states.created).toBeUndefined();
    expect(f.scene().transitions['transition-1'].tracks.created).toBeUndefined(); f.valid();
    f.manager.redo(); expect(f.scene().objects.created.name).toBe('created'); f.valid();
  });

  test.each([
    ['metadata', [...scenePath, 'objects', 'created', 'name'], 'Peer circle'],
    ['first state', [...statePath(), 'fill'], '#ff0000'],
    ['other Composition state', [...statePath('created', 'comp-2'), 'x'], 450],
    ['track timing', [...trackPath(), 'duration'], 250],
    ['nested state Bézier', [...statePath(), 'path', 'c1', 'y'], 120],
  ])('peer %s edits retain the whole creation and Undo unrelated fields in the same action', (_label, path, value) => {
    const f = fixture();
    f.edit([...f.create(), ...f.create('untouched'), { path: [...statePath('circle'), 'x'], value: 999 }]);
    f.sync(); f.peer([{ path: path as string[], value }]);
    const expected = f.scene();
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 });
    expect(f.scene().objects.created).toEqual(expected.objects.created);
    for (const id of f.scene().compositionOrder) expect(f.scene().compositions[id].states.created).toEqual(expected.compositions[id].states.created);
    expect(f.scene().transitions['transition-1'].tracks.created).toEqual(expected.transitions['transition-1'].tracks.created);
    expect(f.scene().objects.untouched).toBeUndefined(); expect(f.scene().compositions['comp-1'].states.circle.x).toBe(245); f.valid();
    f.manager.redo(); expect(f.scene().objects.untouched).toBeDefined();
    expect(f.scene().compositions['comp-1'].states.circle.x).toBe(999); f.valid();
  });

  test('a peer-added track protects an object created without animations', () => {
    const f = fixture(); f.edit(f.create('created', false)); f.sync();
    f.peer([{ path: trackPath(), value: defaultTrack('created', { easing: 'easeOut', duration: 350 }) }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 1 });
    expect(f.scene().transitions['transition-1'].tracks.created.easing).toBe('easeOut');
    expect(f.scene().objects.created).toBeDefined();
    for (const composition of Object.values(f.scene().compositions)) expect(composition.states.created).toBeDefined(); f.valid();
  });

  test('replacing a whole state or adding a Composition also records the dependency', () => {
    for (const addComposition of [false, true]) {
      const f = fixture(); f.edit(f.create('created', false)); f.sync();
      if (addComposition) {
        const clone = structuredClone(f.scene().compositions['comp-2']); clone.id = 'peer-comp';
        f.peer([{ path: [...scenePath, 'compositions', clone.id], value: clone }]);
      } else f.peer([{ path: statePath(), value: defaultState('circle', { fill: '#ff0000' }) }]);
      expect(f.undo()).toEqual({ tracks: 0, objects: 1 }); expect(f.scene().objects.created).toBeDefined(); f.valid();
    }
  });

  test('local overwrite and Undo keep peer history, consume exactly the creation, then allow prior Undo/Redo', () => {
    const f = fixture(); f.edit([{ path: ['name'], value: 'Earlier action' }]);
    f.edit(f.create('created', false)); f.sync();
    f.peer([{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    f.edit([{ path: [...statePath(), 'fill'], value: '#0000ff' }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(f.scene().compositions['comp-1'].states.created.fill).toBe('#ff0000');
    expect(f.undo()).toEqual({ tracks: 0, objects: 1 }); expect(readProject(f.alice)!.name).toBe('Earlier action');
    expect(f.manager.undoStack).toHaveLength(1); f.valid();
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(readProject(f.alice)!.name).toBe(makeDemoProject().name);
    f.manager.redo(); expect(readProject(f.alice)!.name).toBe('Earlier action');
    f.manager.redo(); expect(f.scene().compositions['comp-1'].states.created.fill).toBe('#0000ff');
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(f.scene().compositions['comp-1'].states.created.fill).toBe('#ff0000'); f.valid();
  });

  test('a creation preserved as a no-op does not make Redo remove peer changes or skip the prior action', () => {
    const f = fixture(); f.edit([{ path: ['name'], value: 'Earlier action' }]); f.edit(f.create()); f.sync();
    f.peer([{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 }); expect(f.manager.canRedo()).toBe(false);
    f.manager.redo(); expect(readProject(f.alice)!.name).toBe('Earlier action');
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    f.manager.redo(); expect(f.scene().compositions['comp-1'].states.created.fill).toBe('#ff0000'); f.valid();
  });

  test('later peer edits delivered after local overwrite and before creation Undo are retained', () => {
    const f = fixture(); f.edit(f.create()); f.sync();
    f.edit([{ path: [...statePath(), 'fill'], value: '#0000ff' }]);
    // Bob edits the same field offline; force the next value to win by first receiving Alice's update.
    Y.applyUpdate(f.bob, Y.encodeStateAsUpdate(f.alice));
    applyChanges(f.bob, [{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    f.sync(); expect(f.undo()).toEqual({ tracks: 1, objects: 1 });
    expect(f.scene().compositions['comp-1'].states.created.fill).toBe('#ff0000'); f.valid();
  });

  test('unrelated peer edits do not protect new objects and normal existing-object field Undo is unchanged', () => {
    const f = fixture(); f.edit([...f.create(), { path: [...statePath('circle'), 'x'], value: 400 }]); f.sync();
    f.peer([{ path: ['name'], value: 'Peer title' }, { path: [...statePath('circle'), 'fill'], value: '#ff0000' }, { path: [...scenePath, 'compositions', 'comp-1', 'name'], value: 'Peer composition name' }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(f.scene().objects.created).toBeUndefined();
    expect(f.scene().compositions['comp-1'].states.circle.x).toBe(245); expect(f.scene().compositions['comp-1'].states.circle.fill).toBe('#ff0000'); f.valid();
  });

  test('redo-created object maps retain peer changes under their new identity', () => {
    const f = fixture(); f.edit(f.create()); expect(f.undo().objects).toBe(0); f.manager.redo(); f.sync();
    f.peer([{ path: [...statePath('created', 'comp-2'), 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 }); f.valid();
  });

  test('peer-deleted state and track stay deleted while the remaining creation is retained', () => {
    const f = fixture(); f.edit(f.create()); f.sync();
    f.peer([{ path: statePath('created', 'comp-2'), value: undefined }, { path: trackPath(), value: undefined }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 1 });
    expect(f.scene().objects.created).toBeDefined(); expect(f.scene().compositions['comp-1'].states.created).toBeDefined();
    expect(f.scene().compositions['comp-2'].states.created).toBeUndefined();
    expect(f.scene().transitions['transition-1'].tracks.created).toBeUndefined(); f.valid();
  });

  test('keeps whole Scene and Composition creation Undo semantics outside this object-creation rule', () => {
    const f = fixture();
    const sceneId = duplicateScene(f.alice, 'scene-1'); f.manager.stopCapturing(); f.sync();
    const scene = readProject(f.bob)!.scenes[sceneId], objectId = Object.keys(scene.objects)[0];
    f.peer([{ path: ['scenes', sceneId, 'compositions', scene.compositionOrder[0], 'states', objectId, 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(readProject(f.alice)!.scenes[sceneId]).toBeUndefined(); f.valid();
    const compositionId = duplicateComposition(f.alice, 'scene-1', 'comp-1'); f.manager.stopCapturing(); f.sync();
    f.peer([{ path: [...statePath('circle', compositionId), 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(f.scene().compositions[compositionId]).toBeUndefined(); f.valid();
  });

  test.each([400, 1200])('only retains a Transition extension when the shared creation needs it (%i ms)', duration => {
    const f = fixture();
    const changes = f.create(); changes[changes.length - 1].value = defaultTrack('created', { duration });
    f.edit([...changes, { path: transitionDuration, value: 2000 }, { path: [...statePath('circle'), 'x'], value: 300 }]); f.sync();
    f.peer([{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 });
    expect(f.scene().transitions['transition-1'].duration).toBe(duration > 800 ? 2000 : 800);
    expect(f.manager.lastUndoPreservedDurations).toBe(duration > 800 ? 1 : 0);
    expect(f.scene().compositions['comp-1'].states.circle.x).toBe(245); f.valid();
    f.manager.redo(); expect(f.scene().transitions['transition-1'].duration).toBe(2000);
    expect(f.scene().compositions['comp-1'].states.created.fill).toBe('#ff0000'); f.valid();
  });

  test.each([false, true])('a later Undo protects a retained track only while its current timing still needs the extension (%s)', shortened => {
    const f = fixture(); f.edit([{ path: ['name'], value: 'Earlier action' }]);
    f.edit([{ path: transitionDuration, value: 2000 }]);
    const changes = f.create(); changes[changes.length - 1].value = defaultTrack('created', { duration: 1200 });
    f.edit(changes); f.sync(); f.peer([{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 });
    if (shortened) f.peer([{ path: [...trackPath(), 'duration'], value: 300 }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    expect(f.scene().transitions['transition-1'].duration).toBe(shortened ? 800 : 2000);
    expect(f.manager.lastUndoPreservedDurations).toBe(shortened ? 0 : 1);
    expect(readProject(f.alice)!.name).toBe('Earlier action'); expect(f.manager.undoStack).toHaveLength(1); f.valid();
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(readProject(f.alice)!.name).toBe(makeDemoProject().name);
    f.manager.redo(); expect(readProject(f.alice)!.name).toBe('Earlier action'); f.valid();
  });

  test('uses the track timing after Undo so an unrelated extension can still return to its original duration', () => {
    const f = fixture(); f.edit(f.create()); f.sync(); f.peer([{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 });
    f.edit([{ path: transitionDuration, value: 2000 }, { path: [...trackPath(), 'duration'], value: 1600 }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    expect(f.manager.lastUndoPreservedDurations).toBe(0);
    expect(f.scene().transitions['transition-1'].duration).toBe(800);
    expect(f.scene().transitions['transition-1'].tracks.created.duration).toBe(400); f.valid();
  });

  test.each([100, 500])('uses the restored local duration and peer start for an existing track (%i ms)', start => {
    const f = fixture();
    f.edit([{ path: transitionDuration, value: 2000 }, { path: [...trackPath('circle'), 'duration'], value: 1200 }]); f.sync();
    f.peer([{ path: [...trackPath('circle'), 'start'], value: start }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    expect(f.scene().transitions['transition-1'].tracks.circle.duration).toBe(600);
    expect(f.scene().transitions['transition-1'].tracks.circle.start).toBe(start);
    expect(f.scene().transitions['transition-1'].duration).toBe(start + 600 > 800 ? 2000 : 800);
    expect(f.manager.lastUndoPreservedDurations).toBe(start + 600 > 800 ? 1 : 0); f.valid();
  });

  test('peer easing alone does not retain an extension when both timing fields Undo within the old bounds', () => {
    const f = fixture();
    f.edit([{ path: transitionDuration, value: 2000 }, { path: [...trackPath('circle'), 'duration'], value: 1200 }]); f.sync();
    f.peer([{ path: [...trackPath('circle'), 'easing'], value: 'easeOut' }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    expect(f.scene().transitions['transition-1'].duration).toBe(800);
    expect(f.scene().transitions['transition-1'].tracks.circle.easing).toBe('easeOut');
    expect(f.manager.lastUndoPreservedDurations).toBe(0); f.valid();
  });

  test('a later local duration overwrite and Undo cannot hide the extension required by the shared creation', () => {
    const f = fixture(); const changes = f.create();
    changes[changes.length - 1].value = defaultTrack('created', { duration: 1200 });
    f.edit([...changes, { path: transitionDuration, value: 2000 }]); f.sync();
    f.peer([{ path: [...statePath(), 'fill'], value: '#ff0000' }]);
    f.edit([{ path: transitionDuration, value: 3000 }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); expect(f.scene().transitions['transition-1'].duration).toBe(2000);
    expect(f.undo()).toEqual({ tracks: 1, objects: 1 }); expect(f.scene().transitions['transition-1'].duration).toBe(2000);
    expect(f.manager.lastUndoPreservedDurations).toBe(1); f.valid();
  });

  test.each([false, true])('Redo retains only a short duration that would truncate a newly edited peer track (%s)', peerEdit => {
    const f = fixture();
    applyChanges(f.alice, [{ path: transitionDuration, value: 2000 }], 'initialize');
    f.edit([{ path: transitionDuration, value: 800 }, { path: [...statePath('circle'), 'x'], value: 300 }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); f.sync();
    if (peerEdit) f.peer([{ path: [...trackPath('circle'), 'duration'], value: 1800 }]);
    expect(redoPreservingPeerDurations(f.manager)).toBe(peerEdit ? 1 : 0);
    expect(f.scene().transitions['transition-1'].duration).toBe(peerEdit ? 2000 : 800);
    expect(f.scene().compositions['comp-1'].states.circle.x).toBe(300); f.valid();
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 });
    expect(f.scene().compositions['comp-1'].states.circle.x).toBe(245); f.valid();
  });

  test('a protected no-op Redo consumes only that action and allows the next Redo normally', () => {
    const f = fixture();
    applyChanges(f.alice, [{ path: transitionDuration, value: 2000 }], 'initialize');
    f.edit([{ path: transitionDuration, value: 800 }]); f.edit([{ path: ['name'], value: 'Later action' }]);
    f.undo(); f.undo(); f.sync(); f.peer([{ path: [...trackPath('circle'), 'duration'], value: 1800 }]);
    expect(redoPreservingPeerDurations(f.manager)).toBe(1);
    expect(readProject(f.alice)!.name).toBe(makeDemoProject().name); expect(f.manager.redoStack).toHaveLength(1);
    expect(redoPreservingPeerDurations(f.manager)).toBe(0); expect(readProject(f.alice)!.name).toBe('Later action'); f.valid();
  });

  test('rejects Redo of a deleted long animation after a peer shortens the Transition, without changing data or consuming history', () => {
    const f = fixture(), changes = f.create();
    changes[changes.length - 1].value = defaultTrack('created', { duration: 2000 });
    f.edit([...changes, { path: transitionDuration, value: 2000 }]);
    expect(f.undo()).toEqual({ tracks: 0, objects: 0 }); f.sync();
    f.peer([{ path: transitionDuration, value: 600 }, { path: [...trackPath('equation'), 'start'], value: 200 }]);
    const before = readProject(f.alice), beforeVector = Y.encodeStateVector(f.alice), pending = f.manager.redoStack.at(-1);
    expect(() => redoPreservingPeerDurations(f.manager)).toThrow('Transition を短くしたため');
    expect(readProject(f.alice)).toEqual(before); expect(Y.encodeStateVector(f.alice)).toEqual(beforeVector);
    expect(f.manager.redoStack).toHaveLength(1); expect(f.manager.redoStack.at(-1)).toBe(pending); f.valid();
    // The collaborator can restore enough room; the exact pending Redo is usable again.
    f.peer([{ path: transitionDuration, value: 2500 }]);
    expect(redoPreservingPeerDurations(f.manager)).toBe(0);
    expect(f.scene().objects.created).toBeDefined(); expect(f.scene().transitions['transition-1'].duration).toBe(2500);
    expect(f.scene().transitions['transition-1'].tracks.created.duration).toBe(2000); f.valid();
  });
});
