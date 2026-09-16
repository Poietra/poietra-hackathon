import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, ensureSceneAnimationTracks, getShared, initializeDocument, readProject, toShared } from '../shared/document';
import { defaultTrack, getPropertyTiming, PROPERTY_CHANNELS, resolveTrack, type AnimationTiming, type PropertyChannel } from '../shared/model';
import { applyProposal, compileProposal, validateProposalForApply, type ProposalOperation } from '../shared/ai';
import { parseProjectFile } from '../shared/project-file';
import { EditorStore } from '../src/editor/store';
import { EditorUndoManager, redoPreservingPeerDurations, undoPreservingPeerTracks } from '../src/editor/undo';
import { transitionFrame } from '../src/engine/evaluate';
import type { MotionKernel } from '../src/engine/kernel';

const docs: Y.Doc[] = [];
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); vi.restoreAllMocks(); });
let kernel: MotionKernel;
beforeAll(async () => { const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/wasm/poietra_core.wasm', import.meta.url))); kernel = instance.exports as unknown as MotionKernel; });
const sid = 'scene-1', tid = 'transition-1', base = ['scenes', sid, 'transitions', tid], trackPath = [...base, 'tracks', 'sigmoid'];
const timing = (duration: number, start = 0): AnimationTiming => ({ start, duration, easing: 'linear' });
function replicas() {
  const seed = new Y.Doc(); docs.push(seed); initializeDocument(seed, makeDemoProject()); ensureSceneAnimationTracks(seed);
  const stores = [100, 200].map(clientID => { const doc = new Y.Doc(); docs.push(doc); doc.clientID = clientID; Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed)); return Object.assign(Object.create(EditorStore.prototype), { doc, undoManager: new EditorUndoManager(doc) }) as EditorStore; });
  const [alice, bob] = stores;
  const sync = () => { Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc)); Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc)); expect(readProject(alice.doc)).toEqual(readProject(bob.doc)); expect(() => parseProjectFile(JSON.stringify(readProject(alice.doc)))).not.toThrow(); };
  const scene = () => alice.scene(sid), transition = () => scene().transitions[tid], track = () => transition().tracks.sigmoid;
  const compile = (operations: ProposalOperation[]) => compileProposal(alice.doc, readProject(alice.doc)!, sid, { message: 'timing', operations });
  return { alice, bob, sync, scene, transition, track, compile };
}
const property = (channel: PropertyChannel, value: AnimationTiming | null, objectId = 'sigmoid'): Extract<ProposalOperation, { action: 'setPropertyTiming' }> => ({ action: 'setPropertyTiming', transitionId: tid, objectId, channel, timing: value });

describe('independent property timing with the real WASM evaluator', () => {
  test('position keeps moving after opacity has completed, with independent easing and path travel', () => {
    const scene = makeDemoProject().scenes[sid], transition = scene.transitions[tid]; transition.duration = 2000;
    transition.tracks.circle = defaultTrack('circle', { duration: 2000, easing: 'linear', positionTiming: timing(2000), opacityTiming: timing(300), path: { c1: { x: 300, y: 0 }, c2: { x: 900, y: 0 } } });
    scene.compositions['comp-1'].states.circle.opacity = 0;
    const frame = (time: number) => transitionFrame(scene, transition, time, kernel).objects.find(item => item.object.id === 'circle')!;
    expect(frame(150).state.opacity).toBe(.5); expect(frame(300).state.opacity).toBe(1);
    expect(frame(1000).state.x).toBe(600); expect(frame(1000).state.y).toBeLessThan(400);
    expect(frame(2000).state.x).toBe(955);
    transition.tracks.circle.positionTiming!.easing = 'easeIn';
    expect(frame(1000).state.x).toBeLessThan(600);
  });
  test.each(['move', 'fade', 'write', 'grow', 'none'] as const)('null overrides preserve legacy %s frames for entry and exit', type => {
    const scene = makeDemoProject().scenes[sid], transition = scene.transitions[tid];
    for (const exit of [false, true]) {
      scene.compositions['comp-1'].states.equation.visible = exit; scene.compositions['comp-2'].states.equation.visible = !exit;
      transition.tracks.equation = defaultTrack('equation', { type, start: 100, duration: 500 });
      const before = [0, 100, 300, 600, 800].map(time => transitionFrame(scene, transition, time, kernel));
      for (const channel of PROPERTY_CHANNELS) Object.assign(transition.tracks.equation, { [`${channel}Timing`]: null });
      expect([0, 100, 300, 600, 800].map(time => transitionFrame(scene, transition, time, kernel))).toEqual(before);
    }
  });
  test('explicit entry and exit opacity interpolate from visible endpoints exactly once', () => {
    const scene = makeDemoProject().scenes[sid], transition = scene.transitions[tid];
    const a = scene.compositions['comp-1'].states.equation, b = scene.compositions['comp-2'].states.equation;
    transition.tracks.equation = defaultTrack('equation', { type: 'fade', opacityTiming: timing(300) });
    a.opacity = 0; b.opacity = 1;
    expect(transitionFrame(scene, transition, 150, kernel).objects.find(item => item.object.id === 'equation')!.state.opacity).toBe(.5);
    a.visible = true; a.opacity = 1; b.visible = false; b.opacity = 0;
    expect(transitionFrame(scene, transition, 150, kernel).objects.find(item => item.object.id === 'equation')!.state.opacity).toBe(.5);
  });
  test('Write reveal, entry opacity and local path morph use their own clocks; zero duration steps at start', () => {
    const scene = makeDemoProject().scenes[sid], transition = scene.transitions[tid];
    transition.tracks.equation = defaultTrack('equation', { type: 'write', duration: 800, revealTiming: timing(400, 400), opacityTiming: timing(200, 400) });
    const frame = (time: number) => transitionFrame(scene, transition, time, kernel).objects.find(item => item.object.id === 'equation')!;
    expect(frame(300).state.opacity).toBe(0); expect(frame(500).writeProgress).toBe(.25); expect(frame(500).state.opacity).toBe(.5); expect(frame(600).state.opacity).toBe(1);
    transition.tracks.equation.revealTiming = timing(0, 300);
    expect(frame(299).writeProgress).toBe(0); expect(frame(300).writeProgress).toBe(1);
    transition.tracks.sigmoid = defaultTrack('sigmoid', { duration: 800, pathTiming: timing(200), rotationTiming: timing(400) });
    const a = scene.compositions['comp-1'].states.sigmoid, b = scene.compositions['comp-2'].states.sigmoid;
    a.path.c1.x = 0; b.path = structuredClone(b.path); b.path.c1.x = 200; a.rotation = 0; b.rotation = 180;
    const path = transitionFrame(scene, transition, 200, kernel).objects.find(item => item.object.id === 'sigmoid')!;
    expect(path.state.path.c1.x).toBe(200); expect(path.state.rotation).toBe(90);
  });
});

describe('stable parents, copy, timing bounds and collaborative Undo', () => {
  test('independent first edits merge and each Undo removes only its own channel', () => {
    const f = replicas(); f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(700)); f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(300)); f.sync();
    expect(f.track()).toMatchObject({ implicit: true, positionTiming: timing(700), opacityTiming: timing(300) });
    undoPreservingPeerTracks(f.alice.undoManager); f.sync(); expect(f.track().positionTiming).toBeUndefined(); expect(f.track().opacityTiming).toEqual(timing(300));
    redoPreservingPeerDurations(f.alice.undoManager); f.sync(); expect(f.track().positionTiming).toEqual(timing(700));
    undoPreservingPeerTracks(f.bob.undoManager); f.sync(); expect(f.track().opacityTiming).toBeUndefined(); expect(f.track().positionTiming).toEqual(timing(700));
  });
  test('peer edits after first base activation retain that animation, without treating initial sync as a peer edit', () => {
    const f = replicas();
    // Simulate a server-materialized parent arriving after the UndoManager exists.
    applyChanges(f.bob.doc, [{ path: trackPath, value: defaultTrack('sigmoid', { implicit: true }) }]); f.sync();
    f.alice.setTrack(sid, tid, 'sigmoid', { duration: 400 });
    expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(0); expect(f.track().implicit).toBe(true);
    redoPreservingPeerDurations(f.alice.undoManager); f.sync();
    f.bob.setTrack(sid, tid, 'sigmoid', { easing: 'easeOut' }); f.sync();
    expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(1); expect(f.track()).toMatchObject({ implicit: false, duration: 400, easing: 'easeOut' }); f.sync();
  });
  test.each([false, true])('a peer independent channel edit after activation survives while the base Undo succeeds (nested: %s)', nested => {
    const f = replicas(); f.alice.setTransitionDuration(sid, tid, 2000);
    f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(2000));
    f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(300));
    f.alice.setTrack(sid, tid, 'sigmoid', { duration: 1500 }); f.sync();
    if (nested) applyChanges(f.bob.doc, [{ path: [...trackPath, 'positionTiming', 'duration'], value: 1600 }]);
    else f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(1600));
    f.sync(); expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(0);
    expect(resolveTrack(f.track(), 'sigmoid', f.transition().duration)).toMatchObject({ implicit: true, duration: 2000, positionTiming: timing(1600), opacityTiming: timing(300) }); f.sync();
    redoPreservingPeerDurations(f.alice.undoManager); f.sync();
    expect(f.track()).toMatchObject({ implicit: false, duration: 1500, positionTiming: timing(1600), opacityTiming: timing(300) });
  });
  test('a peer edit before a later activation does not protect the later untouched activation', () => {
    const f = replicas(); f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(300)); f.sync();
    f.alice.setTrack(sid, tid, 'sigmoid', { duration: 400 });
    expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(0); expect(f.track()).toMatchObject({ implicit: true, opacityTiming: timing(300) }); f.sync();
  });
  test('automatic base follows Transition length while overrides stay fixed; reset restores inheritance', () => {
    const f = replicas(); f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(300)); f.alice.setTransitionDuration(sid, tid, 2000);
    expect(getPropertyTiming(resolveTrack(f.track(), 'sigmoid', 2000), 'position').duration).toBe(2000);
    expect(f.track().opacityTiming).toEqual(timing(300)); f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', null);
    expect(getPropertyTiming(resolveTrack(f.track(), 'sigmoid', 2000), 'opacity').duration).toBe(2000); f.sync();
  });
  test('shortening clamps unlocked channel timings but preserves locked timing ends', () => {
    const f = replicas(); f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(500, 200)); f.alice.setPropertyTiming(sid, tid, 'circle', 'opacity', timing(500, 250));
    applyChanges(f.alice.doc, [{ path: ['scenes', sid, 'objects', 'sigmoid', 'locked'], value: true }]);
    f.alice.setTransitionDuration(sid, tid, 400); expect(f.transition().duration).toBe(700); expect(f.track().positionTiming).toEqual(timing(500, 200)); expect(f.transition().tracks.circle.opacityTiming).toEqual(timing(450, 250)); f.sync();
  });
  test('Undo cannot shorten a Transition below a peer channel; Redo rejects restored channel past peer shortening atomically', () => {
    const f = replicas(); f.alice.setTransitionDuration(sid, tid, 2000); f.sync(); f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(1800)); f.sync();
    undoPreservingPeerTracks(f.alice.undoManager); expect(f.transition().duration).toBe(2000); expect(f.alice.undoManager.lastUndoPreservedDurations).toBe(1); f.sync();
    f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(1500)); undoPreservingPeerTracks(f.alice.undoManager); f.sync();
    f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', null); f.bob.setTransitionDuration(sid, tid, 800); f.sync();
    const vector = Y.encodeStateVector(f.alice.doc), action = f.alice.undoManager.redoStack.at(-1);
    expect(() => redoPreservingPeerDurations(f.alice.undoManager)).toThrow('現在の長さ'); expect(Y.encodeStateVector(f.alice.doc)).toEqual(vector); expect(f.alice.undoManager.redoStack.at(-1)).toBe(action);
    f.bob.setTransitionDuration(sid, tid, 2000); f.sync(); redoPreservingPeerDurations(f.alice.undoManager); f.sync(); expect(f.track().positionTiming).toEqual(timing(1500));
  });
  test('Undo refuses to restore an older long channel after a peer shortens only the Transition', () => {
    const f = replicas(); f.alice.setTransitionDuration(sid, tid, 2000); f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(1500)); f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(300)); f.sync();
    f.bob.setTransitionDuration(sid, tid, 800); f.sync();
    const vector = Y.encodeStateVector(f.alice.doc), action = f.alice.undoManager.undoStack.at(-1);
    expect(() => undoPreservingPeerTracks(f.alice.undoManager)).toThrow('現在の長さ'); expect(Y.encodeStateVector(f.alice.doc)).toEqual(vector); expect(f.alice.undoManager.undoStack.at(-1)).toBe(action);
    f.bob.setTransitionDuration(sid, tid, 2000); f.sync(); undoPreservingPeerTracks(f.alice.undoManager); expect(f.track().positionTiming).toEqual(timing(1500));
  });
  test('new objects and transitions include stable automatic parents before server synchronization', () => {
    const f = replicas(); const objectId = f.alice.addObject(sid, 'comp-1', 'circle');
    expect(f.transition().tracks[objectId].implicit).toBe(true);
    f.alice.setPropertyTiming(sid, tid, objectId, 'opacity', timing(250));
    const comp = f.alice.addComposition(sid), incoming = Object.values(f.scene().transitions).find(item => item.toId === comp)!;
    expect(Object.keys(incoming.tracks).sort()).toEqual(Object.keys(f.scene().objects).sort()); f.sync();
  });
  test('migration skips ordinary edits but detects same-count deletes/adds and tracks-parent replacement', () => {
    const f = replicas(); ensureSceneAnimationTracks(f.alice.doc);
    const tracks = getShared(f.alice.doc, [...base, 'tracks']) as Y.Map<unknown>, has = vi.spyOn(tracks, 'has');
    f.alice.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(300)); expect(ensureSceneAnimationTracks(f.alice.doc)).toBe(false); expect(has).not.toHaveBeenCalled();
    tracks.delete('sigmoid'); tracks.set('unused', toShared(defaultTrack('unused'))); expect(ensureSceneAnimationTracks(f.alice.doc)).toBe(true); expect(tracks.has('sigmoid')).toBe(true);
    applyChanges(f.alice.doc, [{ path: [...base, 'tracks'], value: {} }]); expect(ensureSceneAnimationTracks(f.alice.doc)).toBe(true); expect(Object.keys(f.transition().tracks)).toHaveLength(3);
  });
  test('saved project round-trip retains every override and rejects timing outside its Transition', () => {
    const f = replicas(); for (const channel of PROPERTY_CHANNELS) f.alice.setPropertyTiming(sid, tid, 'sigmoid', channel, timing(300, 100)); f.sync();
    const project = readProject(f.alice.doc)!; project.scenes[sid].transitions[tid].tracks.sigmoid.opacityTiming!.duration = 701;
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow();
  });
});

describe('AI property timing proposals', () => {
  test('different peer channel edits remain applicable, while a changed requested channel is stale', () => {
    const f = replicas(), proposal = f.compile([property('opacity', timing(300))]);
    f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'position', timing(700)); f.sync(); applyProposal(f.alice.doc, proposal); f.sync(); expect(f.track().positionTiming).toEqual(timing(700));
    const stale = f.compile([property('opacity', timing(200))]); f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(400)); f.sync(); expect(() => validateProposalForApply(f.alice.doc, stale)).toThrow('提案後');
  });
  test.each([false, true])('validates final duration and all overrides independent of operation order (%s)', reverse => {
    const f = replicas(), operations: ProposalOperation[] = [property('position', timing(2000)), property('opacity', timing(300)), { action: 'setTransitionDuration', transitionId: tid, duration: 2000 }];
    applyProposal(f.alice.doc, f.compile(reverse ? operations.reverse() : operations)); f.sync(); expect(f.track().positionTiming).toEqual(timing(2000));
    expect(() => f.compile([{ action: 'setTransitionDuration', transitionId: tid, duration: 800 }])).toThrow('範囲');
  });
  test('guards channel dependencies when shortening and locks against property operations', () => {
    const f = replicas(), proposal = f.compile([{ action: 'setTransitionDuration', transitionId: tid, duration: 1000 }]);
    f.bob.setPropertyTiming(sid, tid, 'sigmoid', 'opacity', timing(300)); f.sync(); expect(() => validateProposalForApply(f.alice.doc, proposal)).toThrow('提案後');
    applyChanges(f.alice.doc, [{ path: ['scenes', sid, 'objects', 'sigmoid', 'locked'], value: true }]); expect(() => f.compile([property('opacity', timing(300))])).toThrow('ロック');
  });
  test('new object plus appended Composition supports independent timing in a single portable proposal', () => {
    const f = replicas(); const proposal = f.compile([
      { action: 'createObject', ref: '@ball', compositionId: 'comp-2', kind: 'circle', name: 'Ball', x: 100, y: 100, width: 30, height: 30, fill: '#ffffff', text: '', fontSize: 20 },
      { action: 'appendComposition', ref: '@next', transitionRef: '@travel', name: 'Next', duration: 1000, transitionDuration: 2000 },
      { action: 'setState', compositionId: '@next', objectId: '@ball', property: 'x', value: 900 },
      { ...property('opacity', timing(300), '@ball'), transitionId: '@travel' },
      { ...property('position', timing(2000), '@ball'), transitionId: '@travel' },
    ]); applyProposal(f.alice.doc, JSON.parse(JSON.stringify(proposal))); f.sync();
    const ball = Object.values(f.scene().objects).find(object => object.name === 'Ball')!;
    const appended = Object.values(f.scene().transitions).find(transition => transition.id !== tid)!;
    expect(appended.tracks[ball.id]).toMatchObject({ positionTiming: timing(2000), opacityTiming: timing(300) });
    expect(f.transition().tracks[ball.id].implicit).toBe(true);
  });
});
