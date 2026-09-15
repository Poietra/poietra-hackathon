import { readFile } from 'node:fs/promises';
import { afterEach, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import type { z } from 'zod';
import { compileProposal, validateProposalForApply, type EditProposalSchema } from '../shared/ai';
import { applyChanges, initializeDocument, readProject } from '../shared/document';
import { makeDemoProject } from '../shared/demo';
import { defaultTrack } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import { transitionFrame } from '../src/engine/evaluate';
import type { MotionKernel } from '../src/engine/kernel';
import { frameToSvg, prepareScene } from '../src/engine/renderer';
import { EditorUndoManager, undoPreservingPeerTracks } from '../src/editor/undo';

type Operation = z.infer<typeof EditProposalSchema>['operations'][number];
const documents: Y.Doc[] = [];
const fixture = () => { const doc = new Y.Doc(); initializeDocument(doc, makeDemoProject()); documents.push(doc); return doc; };
const compile = (doc: Y.Doc, operations: Operation[]) => compileProposal(doc, readProject(doc)!, 'scene-1', { message: '新しい図形を作って動かします。', operations });
const createdId = (proposal: ReturnType<typeof compile>, name = 'AI ball') => (proposal.changes.find(change => change.path[2] === 'objects' && (change.value as { name: string }).name === name)!.value as { id: string }).id;
const apply = (doc: Y.Doc, proposal: ReturnType<typeof compile>) => { validateProposalForApply(doc, JSON.parse(JSON.stringify(proposal))); applyChanges(doc, proposal.changes); return readProject(doc)!.scenes['scene-1']; };
const create = (ref = '@ball'): Operation => ({ action: 'createObject', ref, compositionId: 'comp-1', name: 'AI ball', kind: 'circle', x: 200, y: 500, width: 48, height: 48, fill: '#f4ce55', text: '', fontSize: 40 });
const curve = { c1: { x: 400, y: 100 }, c2: { x: 800, y: 100 } };
const move: Operation[] = [create(),
  { action: 'setState', compositionId: 'comp-2', objectId: '@ball', property: 'visible', value: true },
  { action: 'setState', compositionId: 'comp-2', objectId: '@ball', property: 'x', value: 1000 },
  { action: 'setTrack', transitionId: 'transition-1', objectId: '@ball', property: 'easing', value: 'linear' },
  { action: 'setMotionPath', transitionId: 'transition-1', objectId: '@ball', path: curve },
];
const base = ['scenes', 'scene-1'];
let kernel: MotionKernel;
beforeAll(async () => { const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url))); kernel = instance.exports as unknown as MotionKernel; });
afterEach(() => { for (const doc of documents.splice(0)) doc.destroy(); });

test.each([false, true])('creates a moving object with actual IDs and whole maps, independent of declaration order (%s)', reverse => {
  const doc = fixture(), before = readProject(doc)!;
  const proposal = compile(doc, reverse ? [...move].reverse() : move), id = createdId(proposal);
  expect(id).not.toBe('@ball');
  expect(proposal.changes).toHaveLength(4);
  expect(proposal.changes.every(change => [4, 6].includes(change.path.length))).toBe(true);
  expect(proposal.changes.every(change => change.existed === false && !!change.parentIdentity)).toBe(true);
  expect(JSON.stringify(proposal.changes)).not.toContain('@ball');
  const scene = apply(doc, proposal);
  expect(scene.compositions['comp-1'].states[id]).toMatchObject({ visible: true, x: 200, y: 500 });
  expect(scene.compositions['comp-2'].states[id]).toMatchObject({ visible: true, x: 1000, y: 500 });
  expect(scene.transitions['transition-1'].tracks[id]).toEqual(defaultTrack(id, { easing: 'linear', path: curve }));
  expect(transitionFrame(scene, scene.transitions['transition-1'], 400, kernel).objects.find(item => item.object.id === id)!.state).toMatchObject({ x: 600, y: 200 });
  for (const objectId of Object.keys(before.scenes['scene-1'].objects)) for (const comp of ['comp-1', 'comp-2']) expect(scene.compositions[comp].states[objectId]).toEqual(before.scenes['scene-1'].compositions[comp].states[objectId]);
  expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
});

test('creates an entering equation with an independently timed Write and real rendered paths', async () => {
  const doc = fixture();
  const proposal = compile(doc, [
    { ...create('@formula'), compositionId: 'comp-2', name: 'New equation', kind: 'equation', text: 'E = mc^2' } as Operation,
    { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'type', value: 'write' },
    { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'start', value: 200 },
    { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'duration', value: 600 },
    { action: 'setTrack', transitionId: 'transition-1', objectId: '@formula', property: 'easing', value: 'linear' },
  ]);
  const id = createdId(proposal, 'New equation'), scene = apply(doc, proposal), transition = scene.transitions['transition-1'];
  expect(scene.compositions['comp-1'].states[id].visible).toBe(false);
  expect(scene.compositions['comp-2'].states[id].visible).toBe(true);
  await prepareScene(scene);
  const at = (time: number) => transitionFrame(scene, transition, time, kernel).objects.find(item => item.object.id === id)!;
  expect(at(0).writeProgress).toBe(0); expect(at(500).writeProgress).toBe(.5); expect(at(800).writeProgress).toBe(1);
  expect(frameToSvg({ ...transitionFrame(scene, transition, 500, kernel), objects: [at(500)] })).toContain('<path');
});

test('creates a path with signed endpoint offsets and local shape controls', () => {
  const doc = fixture();
  const proposal = compile(doc, [{ ...create('@curve'), kind: 'path', height: -200 } as Operation,
    { action: 'setShapePath', compositionId: 'comp-1', objectId: '@curve', path: { c1: { x: 50, y: -20 }, c2: { x: 100, y: -180 } } },
  ]);
  const id = createdId(proposal), scene = apply(doc, proposal);
  expect(scene.compositions['comp-1'].states[id].path).toEqual({ c1: { x: 50, y: -20 }, c2: { x: 100, y: -180 } });
  expect(scene.compositions['comp-2'].states[id].path).not.toEqual(scene.compositions['comp-1'].states[id].path);
  expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
});

test('isolates multiple references and preserves legacy addObject ordering and behavior', () => {
  const doc = fixture();
  const legacy = { ...create(), action: 'addObject', name: 'Legacy' } as unknown as Operation;
  const proposal = compile(doc, [legacy, create(), { ...create('@second'), name: 'Second' } as Operation,
    { action: 'setState', compositionId: 'comp-1', objectId: '@second', property: 'x', value: 700 },
  ]);
  const scene = apply(doc, proposal);
  expect(scene.objects[createdId(proposal, 'Legacy')].order).toBe(3);
  expect(scene.objects[createdId(proposal)].order).toBe(4);
  expect(scene.objects[createdId(proposal, 'Second')].order).toBe(5);
  expect(scene.compositions['comp-1'].states[createdId(proposal)].x).toBe(200);
  expect(scene.compositions['comp-1'].states[createdId(proposal, 'Second')].x).toBe(700);
});

test('rejects duplicate, unknown, unsafe or existing-ID references before any creation applies', () => {
  const doc = fixture(), before = readProject(doc);
  expect(() => compile(doc, [create(), create()])).toThrow('参照名');
  expect(() => compile(doc, [create(), { action: 'setTrack', transitionId: 'transition-1', objectId: '@unknown', property: 'duration', value: 800 }])).toThrow('見つかりません');
  for (const ref of ['ball', '@__proto__', '@', '@' + 'a'.repeat(64)]) expect(() => compile(doc, [create(ref)])).toThrow();
  applyChanges(doc, [{ path: [...base, 'objects', '@ball'], value: { ...readProject(doc)!.scenes['scene-1'].objects.circle, id: '@ball' } }]);
  expect(() => compile(doc, [create()])).toThrow('参照名');
  expect(Object.keys(readProject(doc)!.scenes['scene-1'].objects)).toHaveLength(Object.keys(before!.scenes['scene-1'].objects).length + 1);
});

test('creation never weakens visibility, lock or whole-proposal validation', () => {
  const doc = fixture(), before = readProject(doc);
  expect(() => compile(doc, [create(), move.at(-1)!])).toThrow('両方');
  expect(() => compile(doc, [create(), { action: 'setState', compositionId: 'comp-1', objectId: '@ball', property: 'width', value: -10 }])).toThrow('サイズ');
  expect(readProject(doc)).toEqual(before);
  applyChanges(doc, [{ path: [...base, 'objects', 'circle', 'locked'], value: true }]);
  expect(() => compile(doc, [...move, { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 20 }])).toThrow('ロック');
  expect(Object.keys(readProject(doc)!.scenes['scene-1'].objects)).toHaveLength(3);
});

test('stale scene structure and ID collisions reject all new maps while unrelated peer state is preserved', () => {
  const doc = fixture(), proposal = compile(doc, move), id = createdId(proposal);
  applyChanges(doc, [{ path: [...base, 'compositions', 'comp-1', 'states', 'circle', 'fill'], value: '#ff0000' }], 'peer');
  expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
  applyChanges(doc, [{ path: [...base, 'objects', id], value: { ...readProject(doc)!.scenes['scene-1'].objects.circle, id } }], 'peer');
  expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
  const other = fixture(), stale = compile(other, move);
  applyChanges(other, [{ path: [...base, 'compositions', 'comp-2', 'deleted'], value: true }], 'peer');
  expect(() => validateProposalForApply(other, stale)).toThrow('提案後');
});

test('one Undo/Redo removes and restores the complete untouched creation without losing peer color', () => {
  const doc = fixture(), manager = new EditorUndoManager(doc), proposal = compile(doc, move), id = createdId(proposal);
  const original = readProject(doc)!.scenes['scene-1'];
  applyChanges(doc, [{ path: [...base, 'compositions', 'comp-1', 'states', 'circle', 'fill'], value: '#ff0000' }], 'peer');
  apply(doc, proposal); manager.stopCapturing();
  expect(manager.undoStack).toHaveLength(1); undoPreservingPeerTracks(manager);
  const scene = readProject(doc)!.scenes['scene-1'];
  expect(scene.objects[id]).toBeUndefined(); expect(scene.transitions).toEqual(original.transitions);
  for (const comp of Object.values(scene.compositions)) expect(comp.states[id]).toBeUndefined();
  expect(scene.compositions['comp-1'].states.circle.fill).toBe('#ff0000');
  manager.redo(); expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks[id].path).toEqual(curve);
});

test('peer-edited AI creation survives creation Undo, while an existing-object edit in the same proposal undoes', () => {
  const alice = fixture(), bob = new Y.Doc(); documents.push(bob);
  const manager = new EditorUndoManager(alice);
  const proposal = compile(alice, [...move, { action: 'setState', compositionId: 'comp-1', objectId: 'circle', property: 'x', value: 300 }]), id = createdId(proposal);
  apply(alice, proposal); manager.stopCapturing(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  applyChanges(bob, [{ path: [...base, 'compositions', 'comp-2', 'states', id, 'fill'], value: '#ff0000' }]);
  Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob)); undoPreservingPeerTracks(manager);
  const scene = readProject(alice)!.scenes['scene-1'];
  expect(scene.objects[id]).toBeDefined(); expect(scene.compositions['comp-2'].states[id].fill).toBe('#ff0000');
  expect(scene.transitions['transition-1'].tracks[id].path).toEqual(curve);
  expect(scene.compositions['comp-1'].states.circle.x).toBe(245);
  expect(parseProjectFile(JSON.stringify(readProject(alice)))).toEqual(readProject(alice));
});

test('retaining a peer-edited new animation also retains the Transition duration it needs', () => {
  const alice = fixture(), bob = new Y.Doc(); documents.push(bob);
  const manager = new EditorUndoManager(alice);
  const proposal = compile(alice, [...move, { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 2000 }]), id = createdId(proposal);
  apply(alice, proposal); manager.stopCapturing(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  applyChanges(bob, [{ path: [...base, 'compositions', 'comp-2', 'states', id, 'fill'], value: '#ff0000' }]);
  Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob)); undoPreservingPeerTracks(manager);
  const scene = readProject(alice)!.scenes['scene-1'], transition = scene.transitions['transition-1'];
  expect(scene.objects[id]).toBeDefined();
  expect(transition.duration).toBeGreaterThanOrEqual(transition.tracks[id].start + transition.tracks[id].duration);
  expect(parseProjectFile(JSON.stringify(readProject(alice)))).toEqual(readProject(alice));
});

test.each([false, true])('validates track extension against the final Transition duration (%s)', reverse => {
  const doc = fixture(), before = readProject(doc)!.scenes['scene-1'];
  const operations: Operation[] = [{ action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'duration', value: 2000 }, { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 2000 }];
  const scene = apply(doc, compile(doc, reverse ? operations.reverse() : operations));
  expect(scene.transitions['transition-1'].duration).toBe(2000);
  expect(scene.transitions['transition-1'].tracks.circle.duration).toBe(2000);
  expect(scene.transitions['transition-1'].tracks.equation).toEqual(before.transitions['transition-1'].tracks.equation);
});

test('duration-only edits preserve existing tracks and missing tracks default to the final duration', () => {
  const doc = fixture(), original = readProject(doc)!.scenes['scene-1'].transitions['transition-1'].tracks;
  const proposal = compile(doc, [...move, { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 2000 }]);
  const id = createdId(proposal), scene = apply(doc, proposal);
  expect(scene.transitions['transition-1'].tracks[id].duration).toBe(2000);
  for (const [id, track] of Object.entries(original)) expect(scene.transitions['transition-1'].tracks[id]).toEqual(track);
});

test('shortening cannot clamp untouched or locked tracks, but an explicit valid batch can shorten', () => {
  const doc = fixture(), duration: Operation = { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 500 };
  expect(() => compile(doc, [duration])).toThrow();
  const adjusted: Operation[] = [duration,
    { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'duration', value: 500 },
    { action: 'setTrack', transitionId: 'transition-1', objectId: 'equation', property: 'duration', value: 100 },
  ];
  expect(() => compile(doc, adjusted)).not.toThrow();
  applyChanges(doc, [{ path: [...base, 'objects', 'equation', 'locked'], value: true }]);
  expect(() => compile(doc, adjusted)).toThrow('ロック');
  expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].duration).toBe(800);
});

test('apply-time duration validation includes a peer’s new track and rejects an invalid final timeline', () => {
  const doc = fixture();
  applyChanges(doc, [{ path: [...base, 'transitions', 'transition-1', 'tracks', 'equation', 'start'], value: 200 }]);
  const proposal = compile(doc, [{ action: 'setTransitionDuration', transitionId: 'transition-1', duration: 700 }]);
  applyChanges(doc, [{ path: [...base, 'transitions', 'transition-1', 'tracks', 'sigmoid'], value: defaultTrack('sigmoid', { duration: 800 }) }], 'peer');
  expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
  expect(() => validateProposalForApply(doc, proposal)).toThrow();
  expect(readProject(doc)!.scenes['scene-1'].transitions['transition-1'].duration).toBe(800);
});

test('duration edits reject peer timing changes but permit unrelated peer color changes', () => {
  const doc = fixture(), proposal = compile(doc, [{ action: 'setTransitionDuration', transitionId: 'transition-1', duration: 2000 }]);
  applyChanges(doc, [{ path: [...base, 'compositions', 'comp-1', 'states', 'circle', 'fill'], value: '#ff0000' }], 'peer');
  expect(() => validateProposalForApply(doc, proposal)).not.toThrow();
  applyChanges(doc, [{ path: [...base, 'transitions', 'transition-1', 'tracks', 'equation', 'duration'], value: 300 }], 'peer');
  expect(() => validateProposalForApply(doc, proposal)).toThrow('提案後');
});

test('Undo of an AI Transition extension preserves a peer’s longer existing track without invalid timing', () => {
  const alice = fixture(), bob = new Y.Doc(); documents.push(bob);
  const manager = new EditorUndoManager(alice);
  const proposal = compile(alice, [
    { action: 'setTransitionDuration', transitionId: 'transition-1', duration: 2000 },
    { action: 'setTrack', transitionId: 'transition-1', objectId: 'circle', property: 'duration', value: 2000 },
  ]);
  apply(alice, proposal); manager.stopCapturing(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  applyChanges(bob, [{ path: [...base, 'transitions', 'transition-1', 'tracks', 'circle', 'duration'], value: 1800 }]);
  Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
  expect(parseProjectFile(JSON.stringify(readProject(alice)))).toEqual(readProject(alice));
  undoPreservingPeerTracks(manager);
  const transition = readProject(alice)!.scenes['scene-1'].transitions['transition-1'];
  expect(transition.tracks.circle.duration).toBe(1800);
  expect(transition.duration).toBeGreaterThanOrEqual(1800);
  expect(parseProjectFile(JSON.stringify(readProject(alice)))).toEqual(readProject(alice));
});
