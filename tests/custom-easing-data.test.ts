import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, ensureSceneAnimationTracks, getShared, initializeDocument, readProject } from '../shared/document';
import { applyProposal, compileProposal, EditProposalSchema, validateProposalForApply, type ProposalOperation } from '../shared/ai';
import { EasingSchema } from '../shared/easing-schema';
import { DEFAULT_CUSTOM_EASING, PROPERTY_CHANNELS, propertyTimingKey, type CubicBezierEasing, type Easing } from '../shared/model';
import { parseProjectFile } from '../shared/project-file';
import { EditorStore } from '../src/editor/store';
import { commonTrackValue, groupAnimationChanges, groupAnimationTargets } from '../src/editor/groups';
import { EditorUndoManager, redoPreservingPeerDurations, rollbackGesture, undoPreservingPeerTracks } from '../src/editor/undo';

const sid = 'scene-1', tid = 'transition-1';
const path = ['scenes', sid, 'transitions', tid, 'tracks', 'circle'];
const curve = (patch: Partial<CubicBezierEasing> = {}): CubicBezierEasing => ({ ...DEFAULT_CUSTOM_EASING, ...patch });
const docs: Y.Doc[] = [];
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });

function replicas() {
  const seed = new Y.Doc(); docs.push(seed);
  const project = makeDemoProject();
  project.scenes[sid].transitions[tid].tracks.circle.positionTiming = { start: 100, duration: 400, easing: 'linear' };
  initializeDocument(seed, project); ensureSceneAnimationTracks(seed);
  const [alice, bob] = [100, 200].map(clientID => {
    const doc = new Y.Doc(); docs.push(doc); doc.clientID = clientID;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    return Object.assign(Object.create(EditorStore.prototype), { doc, undoManager: new EditorUndoManager(doc) }) as EditorStore;
  });
  const track = (store = alice) => store.scene(sid).transitions[tid].tracks.circle;
  const valid = (doc: Y.Doc) => expect(parseProjectFile(JSON.stringify(readProject(doc)))).toEqual(readProject(doc));
  const sync = () => {
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc)); Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc));
    expect(readProject(alice.doc)).toEqual(readProject(bob.doc)); valid(alice.doc); valid(bob.doc);
  };
  const restart = () => {
    const restored = new Y.Doc(); docs.push(restored); Y.applyUpdate(restored, Y.encodeStateAsUpdate(alice.doc));
    expect(readProject(restored)).toEqual(readProject(alice.doc)); valid(restored);
  };
  const compile = (operations: ProposalOperation[]) => compileProposal(alice.doc, readProject(alice.doc)!, sid, { message: 'Custom timing curve', operations });
  return { alice, bob, track, sync, restart, compile };
}

describe('portable custom easing data', () => {
  test('legacy presets and custom base/property curves survive project JSON round-trips', () => {
    for (const easing of ['linear', 'easeInOut', 'easeIn', 'easeOut', curve(), curve({ x1: 1, y1: 0, x2: 0, y2: 1 })] as Easing[]) {
      const project = makeDemoProject(), track = project.scenes[sid].transitions[tid].tracks.circle;
      track.easing = structuredClone(easing);
      for (const channel of PROPERTY_CHANNELS) track[propertyTimingKey(channel)] = { start: 100, duration: 500, easing: structuredClone(easing) };
      expect(parseProjectFile(JSON.stringify(project))).toEqual(project);
    }
  });

  test.each([
    { ...curve(), x1: -0.01 }, { ...curve(), y1: 1.01 }, { ...curve(), x2: Infinity },
    { ...curve(), y2: NaN }, { ...curve(), x1: '0.25' }, { type: 'cubicBezier', x1: 0, y1: 0, x2: 1 },
    { ...curve(), type: 'bezier' }, { ...curve(), extra: 1 },
  ])('rejects malformed curves at file and operation boundaries: %j', invalid => {
    expect(EasingSchema.safeParse(invalid).success).toBe(false);
    const project = makeDemoProject(), track = project.scenes[sid].transitions[tid].tracks.circle;
    track.easing = invalid as Easing;
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow();
    track.easing = 'linear'; track.positionTiming = { start: 0, duration: 500, easing: invalid as Easing };
    expect(() => parseProjectFile(JSON.stringify(project))).toThrow();
    expect(EditProposalSchema.safeParse({ message: '', operations: [{ action: 'setTrack', transitionId: tid, objectId: 'circle', property: 'easing', value: invalid }] }).success).toBe(false);
  });
});

describe('custom curve synchronization and local Undo', () => {
  test('base curve and offline peer duration merge, survive restart, and Undo independently', () => {
    const f = replicas(); f.alice.setTrack(sid, tid, 'circle', { easing: curve() });
    f.bob.setTrack(sid, tid, 'circle', { duration: 500 }); f.sync();
    expect(f.track()).toMatchObject({ easing: curve(), duration: 500 });
    expect(getShared(f.alice.doc, [...path, 'easing'])).toBeInstanceOf(Y.Map); f.restart();
    undoPreservingPeerTracks(f.alice.undoManager); f.sync();
    expect(f.track()).toMatchObject({ easing: 'easeInOut', duration: 500 });
    redoPreservingPeerDurations(f.alice.undoManager); f.sync();
    expect(f.track()).toMatchObject({ easing: curve(), duration: 500 });
  });

  test('existing channel curve and peer duration use separate fields, including drag Undo/Redo', () => {
    const f = replicas(), timingParent = getShared(f.alice.doc, [...path, 'positionTiming']);
    f.alice.beginGesture();
    for (const x1 of [.1, .2, .3]) f.alice.setPropertyTiming(sid, tid, 'circle', 'position', { ...f.track().positionTiming!, easing: curve({ x1 }) }, false);
    f.alice.endGesture();
    f.bob.setPropertyTiming(sid, tid, 'circle', 'position', { ...f.track(f.bob).positionTiming!, duration: 300 });
    f.sync(); expect(getShared(f.alice.doc, [...path, 'positionTiming'])).toBe(timingParent);
    expect(f.alice.undoManager.undoStack).toHaveLength(1);
    expect(f.track().positionTiming).toEqual({ start: 100, duration: 300, easing: curve({ x1: .3 }) }); f.restart();
    undoPreservingPeerTracks(f.alice.undoManager); f.sync();
    expect(f.track().positionTiming).toEqual({ start: 100, duration: 300, easing: 'linear' });
    redoPreservingPeerDurations(f.alice.undoManager); f.sync();
    expect(f.track().positionTiming).toEqual({ start: 100, duration: 300, easing: curve({ x1: .3 }) });
  });

  test('preset/custom/null switching restores complete nested maps through Undo and reconnect', () => {
    const f = replicas();
    f.alice.setTrack(sid, tid, 'circle', { easing: curve() });
    f.alice.setTrack(sid, tid, 'circle', { easing: 'easeOut' });
    undoPreservingPeerTracks(f.alice.undoManager); f.sync(); expect(f.track().easing).toEqual(curve());
    redoPreservingPeerDurations(f.alice.undoManager); f.sync(); expect(f.track().easing).toBe('easeOut');
    f.alice.setPropertyTiming(sid, tid, 'circle', 'position', { start: 100, duration: 300, easing: curve() });
    f.alice.setPropertyTiming(sid, tid, 'circle', 'position', null); f.sync();
    expect(f.track().positionTiming).toBeNull();
    undoPreservingPeerTracks(f.alice.undoManager); f.sync();
    expect(f.track().positionTiming).toEqual({ start: 100, duration: 300, easing: curve() }); f.restart();
    redoPreservingPeerDurations(f.alice.undoManager); f.sync(); expect(f.track().positionTiming).toBeNull();
  });

  test.each(['base', 'property'] as const)('concurrent %s curve edits choose one complete curve rather than combining control coordinates', scope => {
    const f = replicas(), first = curve({ x1: .1, y1: .2, x2: .3, y2: .4 }), second = curve({ x1: .9, y1: .8, x2: .7, y2: .6 });
    const edit = (store: EditorStore, easing: Easing) => scope === 'base' ? store.setTrack(sid, tid, 'circle', { easing }) : store.setPropertyTiming(sid, tid, 'circle', 'position', { ...f.track(store).positionTiming!, easing });
    edit(f.alice, first); edit(f.bob, second); f.sync();
    expect([first, second]).toContainEqual(scope === 'base' ? f.track().easing : f.track().positionTiming!.easing); f.restart();
  });

  test('equal deserialized curves produce no new update or Undo item', () => {
    const f = replicas();
    f.alice.setTrack(sid, tid, 'circle', { easing: curve() });
    f.alice.setPropertyTiming(sid, tid, 'circle', 'position', { ...f.track().positionTiming!, easing: curve() });
    const vector = Y.encodeStateVector(f.alice.doc), count = f.alice.undoManager.undoStack.length;
    f.alice.setTrack(sid, tid, 'circle', { easing: JSON.parse(JSON.stringify(curve())) });
    f.alice.setPropertyTiming(sid, tid, 'circle', 'position', JSON.parse(JSON.stringify(f.track().positionTiming)));
    expect(Y.encodeStateVector(f.alice.doc)).toEqual(vector); expect(f.alice.undoManager.undoStack).toHaveLength(count);
  });

  test.each(['overwrite', 'delete'] as const)('canceling a peer-%s gesture cannot undo an earlier rename', action => {
    const f = replicas(); f.alice.setProjectName('Earlier local rename');
    const earlier = f.alice.undoManager.undoStack.at(-1);
    f.alice.beginGesture(); f.alice.setTrack(sid, tid, 'circle', { easing: curve() }, false);
    const gesture = f.alice.undoManager.undoStack.at(-1)!; f.sync();
    if (action === 'overwrite') f.bob.setTrack(sid, tid, 'circle', { easing: curve({ x1: .8 }) });
    else applyChanges(f.bob.doc, [{ path, value: undefined }]);
    f.sync();
    expect(rollbackGesture(f.alice.undoManager, gesture)).toBe(true); f.alice.endGesture(); f.sync();
    expect(f.alice.project().name).toBe('Earlier local rename');
    expect(f.alice.undoManager.undoStack).toEqual([earlier]); expect(f.alice.undoManager.canRedo()).toBe(false);
    if (action === 'overwrite') expect(f.track().easing).toEqual(curve({ x1: .8 }));
    else expect(f.track()).toBeUndefined();
    undoPreservingPeerTracks(f.alice.undoManager); expect(f.alice.project().name).toBe('A little motion');
    redoPreservingPeerDurations(f.alice.undoManager); f.sync(); expect(f.alice.project().name).toBe('Earlier local rename');
  });

  test('cancel restores only the curve, preserves peer duration, and retains earlier Undo and unrelated Redo', () => {
    const f = replicas(); f.alice.setProjectName('Earlier local rename');
    const earlier = f.alice.undoManager.undoStack.at(-1)!;
    f.alice.beginGesture(); f.alice.setTrack(sid, tid, 'circle', { easing: curve() }, false);
    const gesture = f.alice.undoManager.undoStack.at(-1)!; f.alice.endGesture();
    f.alice.setObject(sid, 'circle', { name: 'Later local name' }); undoPreservingPeerTracks(f.alice.undoManager);
    const redo = f.alice.undoManager.redoStack.at(-1)!;
    f.bob.setTrack(sid, tid, 'circle', { duration: 500 }); f.sync();
    expect(rollbackGesture(f.alice.undoManager, gesture)).toBe(true); f.sync();
    expect(f.track()).toMatchObject({ easing: 'easeInOut', duration: 500 });
    expect(f.alice.undoManager.undoStack).toEqual([earlier]); expect(f.alice.undoManager.redoStack).toEqual([redo]);
    redoPreservingPeerDurations(f.alice.undoManager); expect(f.alice.scene(sid).objects.circle.name).toBe('Later local name'); f.sync();
  });

  test('cancel rejects a stale gesture identity and restores the whole history if a protected Undo throws', () => {
    const f = replicas(); f.alice.setProjectName('Earlier local rename');
    const previous = f.alice.undoManager.undoStack.at(-1)!;
    f.alice.setTrack(sid, tid, 'circle', { easing: curve() });
    const vector = Y.encodeStateVector(f.alice.doc), before = [...f.alice.undoManager.undoStack];
    expect(rollbackGesture(f.alice.undoManager, previous)).toBe(false);
    expect(f.alice.undoManager.undoStack).toEqual(before); expect(Y.encodeStateVector(f.alice.doc)).toEqual(vector);
    f.alice.setPropertyTiming(sid, tid, 'circle', 'position', { start: 100, duration: 100, easing: curve() });
    const target = f.alice.undoManager.undoStack.at(-1)!, history = [...f.alice.undoManager.undoStack]; f.sync();
    // Restoring the older 100+400ms channel would exceed this peer-shortened Transition.
    f.bob.setTransitionDuration(sid, tid, 400); f.sync();
    const shortened = Y.encodeStateVector(f.alice.doc);
    expect(() => rollbackGesture(f.alice.undoManager, target)).toThrow('現在の長さ');
    expect(f.alice.undoManager.undoStack).toEqual(history); expect(Y.encodeStateVector(f.alice.doc)).toEqual(shortened);
  });

  test.each([undefined, null])('a peer-edited first channel survives Undo/cancel from its previous %s value', initial => {
    const f = replicas();
    if (initial === null) { applyChanges(f.alice.doc, [{ path: [...path, 'opacityTiming'], value: null }], 'fixture'); f.sync(); }
    f.alice.setProjectName('Earlier local rename');
    f.alice.beginGesture();
    f.alice.setPropertyTiming(sid, tid, 'circle', 'opacity', { start: 0, duration: 600, easing: curve() }, false);
    f.alice.setTrack(sid, tid, 'circle', { duration: 500 }, false);
    const gesture = f.alice.undoManager.undoStack.at(-1)!; f.alice.endGesture(); f.sync();
    f.bob.setPropertyTiming(sid, tid, 'circle', 'opacity', { ...f.track(f.bob).opacityTiming!, duration: 300 }); f.sync();
    if (initial === null) expect(rollbackGesture(f.alice.undoManager, gesture)).toBe(true);
    else expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(1);
    f.sync(); f.restart();
    expect(f.track()).toMatchObject({ duration: 600, opacityTiming: { start: 0, duration: 300, easing: curve() } });
    expect(f.alice.project().name).toBe('Earlier local rename');
    if (initial === undefined) {
      redoPreservingPeerDurations(f.alice.undoManager); f.sync();
      expect(f.track()).toMatchObject({ duration: 500, opacityTiming: { duration: 300, easing: curve() } });
      undoPreservingPeerTracks(f.alice.undoManager);
    }
    undoPreservingPeerTracks(f.alice.undoManager); f.sync(); expect(f.alice.project().name).toBe('A little motion');
    expect(f.track().opacityTiming).toEqual({ start: 0, duration: 300, easing: curve() });
  });

  test.each(['none', 'base', 'another channel'] as const)('a first channel without its own peer edit is removed normally (%s)', peer => {
    const f = replicas(); f.alice.setPropertyTiming(sid, tid, 'circle', 'opacity', { start: 0, duration: 600, easing: curve() }); f.sync();
    if (peer === 'base') f.bob.setTrack(sid, tid, 'circle', { easing: curve({ x1: .8 }) });
    if (peer === 'another channel') f.bob.setPropertyTiming(sid, tid, 'circle', 'position', { ...f.track(f.bob).positionTiming!, duration: 300 });
    f.sync(); expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(0); f.sync();
    expect(f.track().opacityTiming).toBeUndefined();
    if (peer === 'base') expect(f.track().easing).toEqual(curve({ x1: .8 }));
    if (peer === 'another channel') expect(f.track().positionTiming!.duration).toBe(300);
    redoPreservingPeerDurations(f.alice.undoManager); f.sync(); expect(f.track().opacityTiming!.easing).toEqual(curve());
  });

  test('a new shared channel keeps the Transition duration needed to contain it', () => {
    const f = replicas(); f.alice.beginGesture();
    // Compose one local action as the AI compiler does when extending a timing.
    applyChanges(f.alice.doc, [{ path: path.slice(0, 4).concat('duration'), value: 2000 }]);
    f.alice.setPropertyTiming(sid, tid, 'circle', 'opacity', { start: 0, duration: 1800, easing: curve() }, false);
    f.alice.endGesture(); f.sync();
    f.bob.setPropertyTiming(sid, tid, 'circle', 'opacity', { ...f.track(f.bob).opacityTiming!, duration: 1500 }); f.sync();
    expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(1); f.sync();
    expect(f.alice.scene(sid).transitions[tid].duration).toBe(2000);
    expect(f.track().opacityTiming).toEqual({ start: 0, duration: 1500, easing: curve() });
    expect(f.alice.undoManager.lastUndoPreservedDurations).toBe(1);
  });

  test('restoring a peer channel field with a local Undo does not erase the shared creation history', () => {
    const f = replicas(); f.alice.setPropertyTiming(sid, tid, 'circle', 'opacity', { start: 0, duration: 600, easing: curve() }); f.sync();
    f.bob.setPropertyTiming(sid, tid, 'circle', 'opacity', { ...f.track(f.bob).opacityTiming!, duration: 300 }); f.sync();
    f.alice.setPropertyTiming(sid, tid, 'circle', 'opacity', { ...f.track().opacityTiming!, duration: 200 });
    expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(0); expect(f.track().opacityTiming!.duration).toBe(300);
    expect(undoPreservingPeerTracks(f.alice.undoManager)).toBe(1); f.sync();
    expect(f.track().opacityTiming).toEqual({ start: 0, duration: 300, easing: curve() });
  });

  test('group editing compares custom values structurally and preserves independent fields', () => {
    const f = replicas();
    f.alice.edit(groupAnimationChanges(f.alice.scene(sid), tid, ['circle', 'equation'], { easing: curve() }));
    let targets = groupAnimationTargets(f.alice.scene(sid), tid, ['circle', 'equation']).targets;
    expect(commonTrackValue(targets, 'easing')).toEqual(curve());
    expect(groupAnimationChanges(f.alice.scene(sid), tid, ['circle', 'equation'], { easing: curve() })).toEqual([]);
    f.bob.setTrack(sid, tid, 'circle', { duration: 500 }); f.sync();
    expect(f.track()).toMatchObject({ easing: curve(), duration: 500 });
    f.alice.setTrack(sid, tid, 'equation', { easing: 'linear' });
    targets = groupAnimationTargets(f.alice.scene(sid), tid, ['circle', 'equation']).targets;
    expect(commonTrackValue(targets, 'easing')).toBeUndefined();
    const vector = Y.encodeStateVector(f.alice.doc);
    expect(() => groupAnimationChanges(f.alice.scene(sid), tid, ['circle', 'equation'], { easing: curve({ y1: -1 }) })).toThrow();
    expect(Y.encodeStateVector(f.alice.doc)).toEqual(vector);
  });
});

describe('AI custom easing proposals', () => {
  test('portable base/channel proposals preserve peer fields and reject changed curve guards', () => {
    const f = replicas(), proposal = f.compile([
      { action: 'setTrack', transitionId: tid, objectId: 'circle', property: 'easing', value: curve() },
      { action: 'setPropertyTiming', transitionId: tid, objectId: 'circle', channel: 'opacity', timing: { start: 0, duration: 300, easing: curve({ x1: .8 }) } },
    ]);
    f.bob.setTrack(sid, tid, 'circle', { order: 'sequential' }); f.sync();
    applyProposal(f.alice.doc, JSON.parse(JSON.stringify(proposal))); f.sync();
    expect(f.track()).toMatchObject({ order: 'sequential', easing: curve(), opacityTiming: { start: 0, duration: 300, easing: curve({ x1: .8 }) } });
    const stale = f.compile([{ action: 'setTrack', transitionId: tid, objectId: 'circle', property: 'easing', value: 'linear' }]);
    f.bob.setTrack(sid, tid, 'circle', { easing: curve({ y1: .9 }) }); f.sync();
    expect(() => validateProposalForApply(f.alice.doc, stale)).toThrow('提案後');
  });

  test('a custom object is valid only for easing, and rejected operations never partly apply', () => {
    const f = replicas(), vector = Y.encodeStateVector(f.alice.doc);
    for (const property of ['type', 'duration', 'order'] as const) expect(() => f.compile([
      { action: 'setTrack', transitionId: tid, objectId: 'circle', property: 'easing', value: curve() },
      { action: 'setTrack', transitionId: tid, objectId: 'circle', property, value: curve() },
    ])).toThrow();
    expect(Y.encodeStateVector(f.alice.doc)).toEqual(vector);
  });
});
