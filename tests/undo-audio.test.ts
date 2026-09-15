import { afterEach, expect, test } from 'vitest';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, getShared, initializeDocument, readProject, type Change } from '../shared/document';
import { parseProjectFile } from '../shared/project-file';
import { EditorUndoManager, redoPreservingPeerDurations, undoPreservingPeerTracks } from '../src/editor/undo';

const docs: Y.Doc[] = [];
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });
const base = ['scenes', 'scene-1', 'audioTracks'];
const clip = (id: string) => ({ id, name: id, start: 0, offset: 0, duration: 1000, volume: 1, muted: false, asset: { src: 'data:audio/wav;base64,AAAA', mime: 'audio/wav', duration: 1000, hasAudio: true } });
function fixture(legacy = false) {
  const alice = new Y.Doc(), bob = new Y.Doc(); docs.push(alice, bob);
  initializeDocument(alice, makeDemoProject());
  if (legacy) (getShared(alice, ['scenes', 'scene-1']) as Y.Map<unknown>).delete('audioTracks');
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  const manager = new EditorUndoManager(alice);
  const sync = () => { Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice)); Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob)); };
  const edit = (changes: Change[]) => { manager.stopCapturing(); applyChanges(alice, changes); manager.stopCapturing(); };
  const peer = (changes: Change[]) => { applyChanges(bob, changes); sync(); };
  const tracks = () => readProject(alice)!.scenes['scene-1'].audioTracks;
  const undo = () => { undoPreservingPeerTracks(manager); return manager.lastUndoPreservedAudioTracks; };
  const valid = () => { sync(); expect(readProject(alice)).toEqual(readProject(bob)); expect(parseProjectFile(JSON.stringify(readProject(alice)))).toEqual(readProject(alice)); };
  return { alice, bob, manager, sync, edit, peer, tracks, undo, valid };
}

test('untouched audio creation and ordinary field edits Undo/Redo normally', () => {
  const f = fixture(); f.edit([{ path: [...base, 'tone'], value: clip('tone') }]); f.sync();
  f.edit([{ path: [...base, 'tone', 'volume'], value: 0.5 }]);
  expect(f.undo()).toBe(0); expect(f.tracks()!.tone.volume).toBe(1);
  expect(f.undo()).toBe(0); expect(f.tracks()?.tone).toBeUndefined();
  redoPreservingPeerDurations(f.manager); expect(f.tracks()!.tone).toEqual(clip('tone')); f.valid();
});

test.each([['volume', 0.4], ['start', 200], ['muted', true], ['name', 'Peer voice']] as const)('peer %s retains the complete audio creation and undoes unrelated edits', (key, value) => {
  const f = fixture(); f.edit([{ path: [...base, 'tone'], value: clip('tone') }, { path: [...base, 'untouched'], value: clip('untouched') }, { path: ['name'], value: 'Local title' }]); f.sync();
  f.peer([{ path: [...base, 'tone', key], value }]);
  const expected = f.tracks()!.tone;
  expect(f.undo()).toBe(1); expect(f.tracks()!.tone).toEqual(expected); expect(f.tracks()?.untouched).toBeUndefined(); expect(readProject(f.alice)!.name).toBe(makeDemoProject().name); f.valid();
  redoPreservingPeerDurations(f.manager); expect(f.tracks()!.tone).toEqual(expected); expect(f.tracks()?.untouched).toBeDefined(); f.valid();
});

test('legacy optional collection retains its parent identity while removing an untouched sibling', () => {
  const f = fixture(true); f.edit([{ path: base, value: { tone: clip('tone'), other: clip('other') } }]); f.sync();
  f.peer([{ path: [...base, 'tone', 'asset', 'waveform'], value: [0.2, 0.6] }]);
  expect(f.undo()).toBe(1); expect(f.tracks()!.tone.asset.waveform).toEqual([0.2, 0.6]); expect(f.tracks()?.other).toBeUndefined(); f.valid();
});

test('peer history survives a local overwrite Undo and creation Undo consumes only that action', () => {
  const f = fixture(); f.edit([{ path: ['name'], value: 'Earlier' }]); f.edit([{ path: [...base, 'tone'], value: clip('tone') }]); f.sync();
  f.peer([{ path: [...base, 'tone', 'volume'], value: 0.3 }]); f.edit([{ path: [...base, 'tone', 'volume'], value: 0.8 }]);
  expect(f.undo()).toBe(0); expect(f.tracks()!.tone.volume).toBe(0.3);
  expect(f.undo()).toBe(1); expect(f.tracks()!.tone.volume).toBe(0.3); expect(readProject(f.alice)!.name).toBe('Earlier');
  expect(f.manager.undoStack).toHaveLength(1); expect(f.undo()).toBe(0); expect(readProject(f.alice)!.name).toBe(makeDemoProject().name); f.valid();
});

test('unrelated remote edits do not preserve local audio and Redo identities are protected after peer edits', () => {
  const f = fixture(); f.edit([{ path: [...base, 'tone'], value: clip('tone') }]); f.sync(); f.peer([{ path: ['name'], value: 'Peer title' }]);
  expect(f.undo()).toBe(0); expect(f.tracks()?.tone).toBeUndefined();
  redoPreservingPeerDurations(f.manager); f.sync(); f.peer([{ path: [...base, 'tone', 'muted'], value: true }]);
  expect(f.undo()).toBe(1); expect(f.tracks()!.tone.muted).toBe(true); f.valid();
});
