import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyProposal, compileProposal, type EditProposalSchema } from '../shared/ai';
import { applyChanges, getShared, initializeDocument, readProject, toShared } from '../shared/document';
import { makeBlankScene } from '../shared/demo';
import { defaultState, type Project } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import { EditorUndoManager, redoPreservingPeerDurations, undoPreservingPeerTracks } from '../src/editor/undo';
import type { z } from 'zod';

type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const sid = 'studio', first = 'studio-comp-1', base = ['scenes', sid];
const append = (ref = '@next', transitionRef = '@travel'): Operation => ({ action: 'appendComposition', ref, transitionRef, name: ref.slice(1), duration: 1000, transitionDuration: 1200 });
const create = (ref = '@ball', compositionId = first): Operation => ({ action: 'createObject', ref, compositionId, name: ref.slice(1), kind: 'circle', x: 200, y: 500, width: 48, height: 48, fill: '#f4ce55', text: '', fontSize: 36 });
const motion: Operation[] = [create(), append(),
  { action: 'setState', compositionId: '@next', objectId: '@ball', property: 'x', value: 1000 },
  { action: 'setMotionPath', transitionId: '@travel', objectId: '@ball', path: { c1: { x: 400, y: 100 }, c2: { x: 800, y: 100 } } }];
function fixture() {
  const scene = makeBlankScene(sid, 'Studio');
  scene.objects.original = { id: 'original', name: 'Original', kind: 'circle', order: 0, locked: false, groupId: null };
  scene.compositions[first].states.original = defaultState('circle', { x: 300 });
  const project: Project = { version: 1, name: 'Test', sceneOrder: [sid], scenes: { [sid]: scene } };
  const alice = new Y.Doc(); initializeDocument(alice, project);
  const bob = new Y.Doc(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  const undo = new EditorUndoManager(alice); undo.captureTimeout = 0;
  const view = (doc = alice) => readProject(doc)!;
  const current = (doc = alice) => view(doc).scenes[sid];
  const compile = (operations: Operation[], doc = alice) => compileProposal(doc, view(doc), sid, { message: 'Add next scene', operations });
  const sync = () => { const a = Y.encodeStateAsUpdate(alice), b = Y.encodeStateAsUpdate(bob); Y.applyUpdate(alice, b); Y.applyUpdate(bob, a); expect(view()).toEqual(view(bob)); };
  const valid = () => { const value = view(); expect(parseProjectFile(JSON.stringify(value))).toEqual(value); return value; };
  const peer = (path: string[], value: unknown) => { sync(); applyChanges(bob, [{ path, value }]); sync(); };
  const close = () => { undo.destroy(); alice.destroy(); bob.destroy(); };
  return { alice, bob, undo, view, scene: current, compile, sync, valid, peer, close };
}

describe('AI appends editable Composition sequences', () => {
  it('prepares without mutation and applies whole maps plus the same CRDT array in one transaction', () => {
    const f = fixture(); try {
      const initial = f.view(), vector = Y.encodeStateVector(f.alice), order = getShared(f.alice, [...base, 'compositionOrder']);
      const proposal = f.compile(motion); expect(f.view()).toEqual(initial); expect(Y.encodeStateVector(f.alice)).toEqual(vector);
      let updates = 0; f.alice.on('update', () => { updates++; f.valid(); });
      applyProposal(f.alice, proposal); expect(updates).toBe(1); expect(getShared(f.alice, [...base, 'compositionOrder'])).toBe(order);
      const next = f.scene().compositionOrder[1], ball = Object.values(f.scene().objects).find(object => object.name === 'ball')!.id;
      expect(f.scene().compositions[first].states[ball]).toMatchObject({ x: 200, visible: true });
      expect(f.scene().compositions[next].states[ball]).toMatchObject({ x: 1000, visible: true });
      expect(Object.values(f.scene().transitions)[0].tracks[ball]).toMatchObject({ start: 0, duration: 1200, type: 'move' });
      undoPreservingPeerTracks(f.undo); expect(f.view()).toEqual(initial); expect(f.undo.lastUndoPreservedCompositions).toBe(0);
      redoPreservingPeerDurations(f.undo); f.valid(); expect(f.scene().compositionOrder).toHaveLength(2);
    } finally { f.close(); }
  });

  it('copies states at each append, including earlier edits, without propagating later edits backwards', () => {
    const f = fixture(); try {
      const p = f.compile([...motion, create('@late', '@next'), append('@last', '@finish'),
        { action: 'setState', compositionId: '@next', objectId: '@ball', property: 'x', value: 700 },
        { action: 'setState', compositionId: '@last', objectId: '@late', property: 'fill', value: '#ff0000' },
        { action: 'setTransitionDuration', transitionId: '@finish', duration: 600 },
      ]); applyProposal(f.alice, p);
      const [a,b,c] = f.scene().compositionOrder, ball = Object.values(f.scene().objects).find(o => o.name === 'ball')!.id, late = Object.values(f.scene().objects).find(o => o.name === 'late')!.id;
      expect([a,b,c].map(id => f.scene().compositions[id].states[ball].x)).toEqual([200,700,1000]);
      expect([a,b,c].map(id => f.scene().compositions[id].states[late].visible)).toEqual([false,true,true]);
      expect(f.scene().compositions[b].states[late].fill).toBe('#f4ce55');
      expect(Object.values(f.scene().transitions).find(t => t.toId === c)!.duration).toBe(600); f.valid();
    } finally { f.close(); }
  });

  it.each(['source', 'order', 'identity', 'object'])('rejects stale %s without partial application', kind => {
    const f = fixture(); try {
      const p = f.compile(motion);
      if (kind === 'source') f.peer([...base, 'compositions', first, 'states', 'original', 'x'], 888);
      if (kind === 'order') { applyProposal(f.bob, f.compile([append('@peer', '@pt')], f.bob)); f.sync(); }
      if (kind === 'identity') (getShared(f.alice, base) as Y.Map<unknown>).set('compositionOrder', toShared([first]));
      if (kind === 'object') f.peer([...base, 'objects', 'original', 'kind'], 'rectangle');
      const before = f.view(), vector = Y.encodeStateVector(f.alice);
      expect(() => applyProposal(f.alice, p)).toThrow(); expect(f.view()).toEqual(before); expect(Y.encodeStateVector(f.alice)).toEqual(vector);
    } finally { f.close(); }
  });

  it.each(([
    [append(), append()],
    [append('@ball', '@travel'), create()],
    [{ action: 'setState', compositionId: '@next', objectId: 'original', property: 'x', value: 100 }, append()],
    [append(), { action: 'setState', compositionId: '@travel', objectId: 'original', property: 'x', value: 100 }],
    [...Array.from({ length: 5 }, (_, i) => append(`@c${i}`, `@t${i}`))],
    [append(), { action: 'setTrack', transitionId: '@travel', objectId: 'original', property: 'start', value: 1200 }],
  ] as Operation[][]).map(operations => ({ operations })))('rejects invalid references, declaration order, limits and timing %#', ({ operations }) => {
    const f = fixture(); try { const before = f.view(); expect(() => f.compile(operations)).toThrow(); expect(f.view()).toEqual(before); } finally { f.close(); }
  });

  it('preserves a locked object when copying and rejects editing its newly copied state', () => {
    const f = fixture(); try {
      f.peer([...base, 'objects', 'original', 'locked'], true);
      expect(() => f.compile([append(), { action: 'setState', compositionId: '@next', objectId: 'original', property: 'x', value: 999 }])).toThrow('ロック');
      applyProposal(f.alice, f.compile([append()]));
      expect(f.scene().compositions[f.scene().compositionOrder[1]].states.original.x).toBe(300); f.valid();
    } finally { f.close(); }
  });

  it.each(['missing', 'duplicate', 'disconnected'])('rejects incomplete append metadata (%s) before any write', kind => {
    const f = fixture(); try {
      const p = f.compile(motion), before = f.view();
      if (kind === 'missing') delete p.compositionAppends;
      if (kind === 'duplicate') p.compositionAppends![0].compositionIds.push(p.compositionAppends![0].compositionIds[0]);
      if (kind === 'disconnected') (p.changes.find(change => change.path[2] === 'transitions')!.value as { fromId: string }).fromId = 'missing';
      expect(() => applyProposal(f.alice, p)).toThrow(); expect(f.view()).toEqual(before);
    } finally { f.close(); }
  });

  it('merges simultaneous independent appends without losing either branch and undoes only its own append', () => {
    const f = fixture(); try {
      applyProposal(f.alice, f.compile([append()])); applyProposal(f.bob, f.compile([append('@peer', '@peerTravel')], f.bob));
      f.sync(); expect(f.scene().compositionOrder).toHaveLength(3); f.valid();
      undoPreservingPeerTracks(f.undo); f.sync(); expect(f.scene().compositionOrder).toHaveLength(2); f.valid();
    } finally { f.close(); }
  });
});

describe('Undo of shared appended Composition batches', () => {
  it('keeps a revived source visible when the peer depends on its appended destination', () => {
    const f = fixture(); try {
      f.peer([...base, 'compositions', first, 'deleted'], true);
      applyProposal(f.alice, f.compile(motion));
      const next = f.scene().compositionOrder[1]; f.peer([...base, 'compositions', next, 'name'], 'Peer ending');
      undoPreservingPeerTracks(f.undo); f.sync();
      expect(f.scene().compositionOrder).toEqual([first, next]);
      expect(getShared(f.alice, [...base, 'compositions', first, 'deleted'])).toBe(false); f.valid();
    } finally { f.close(); }
  });

  it('does not resurrect an appended Composition hidden by a peer', () => {
    const f = fixture(); try {
      applyProposal(f.alice, f.compile(motion));
      const next = f.scene().compositionOrder[1]; f.peer([...base, 'compositions', next, 'deleted'], true);
      undoPreservingPeerTracks(f.undo); f.sync();
      expect(f.scene().compositionOrder).toEqual([first]);
      expect(getShared(f.alice, [...base, 'compositions', next, 'deleted'])).toBe(true); f.valid();
    } finally { f.close(); }
  });

  it.each(['state', 'name', 'track', 'transition', 'object', 'append', 'initial-state'])('retains the batch after a peer changes %s', kind => {
    const f = fixture(); try {
      applyProposal(f.alice, f.compile(motion)); f.sync();
      const next = f.scene().compositionOrder[1], transition = Object.values(f.scene().transitions)[0], ball = Object.values(f.scene().objects).find(o => o.name === 'ball')!.id;
      if (kind === 'state') f.peer([...base, 'compositions', next, 'states', ball, 'fill'], '#ff0000');
      if (kind === 'name') f.peer([...base, 'compositions', next, 'name'], 'Peer name');
      if (kind === 'track') f.peer([...base, 'transitions', transition.id, 'tracks', ball, 'easing'], 'linear');
      if (kind === 'transition') f.peer([...base, 'transitions', transition.id, 'duration'], 1800);
      if (kind === 'object') { applyProposal(f.bob, f.compile([create('@peer', next)], f.bob)); f.sync(); }
      if (kind === 'append') { applyProposal(f.bob, f.compile([append('@peer', '@pt')], f.bob)); f.sync(); }
      if (kind === 'initial-state') f.peer([...base, 'compositions', first, 'states', ball, 'fill'], '#ff0000');
      const before = f.view(); undoPreservingPeerTracks(f.undo); f.sync();
      expect(f.view()).toEqual(before); expect(f.undo.lastUndoPreservedCompositions).toBe(1); f.valid();
    } finally { f.close(); }
  });

  it('retains all appended siblings while undoing unrelated existing state edits in the same proposal', () => {
    const f = fixture(); try {
      applyProposal(f.alice, f.compile([...motion, append('@last', '@end'), { action: 'setState', compositionId: first, objectId: 'original', property: 'x', value: 777 }]));
      const last = f.scene().compositionOrder[2]; f.peer([...base, 'compositions', last, 'name'], 'Shared ending');
      undoPreservingPeerTracks(f.undo); f.sync();
      expect(f.scene().compositionOrder).toHaveLength(3); expect(f.undo.lastUndoPreservedCompositions).toBe(2);
      expect(f.scene().compositions[first].states.original.x).toBe(300); expect(f.scene().compositions[last].name).toBe('Shared ending'); f.valid();
    } finally { f.close(); }
  });
});
