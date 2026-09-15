import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { makeDemoProject } from '../shared/demo';
import { applyChanges, initializeDocument, LOCAL_ORIGIN, readProject } from '../shared/document';
import { defaultState, defaultTrack, type Scene } from '../shared/model';
import { commonTrackValue, editableGroupMembers, groupAnimationChanges, groupAnimationTargets, groupMembers } from '../src/editor/groups';

function fixture() {
  const scene = makeDemoProject().scenes['scene-1'];
  scene.objects.second = { ...scene.objects.circle, id: 'second', name: 'Second circle', order: 4 };
  for (const composition of Object.values(scene.compositions)) composition.states.second = { ...structuredClone(composition.states.circle), x: composition.states.circle.x + 100, y: composition.states.circle.y - 80 };
  scene.transitions['transition-1'].tracks.second = defaultTrack('second', { type: 'fade', start: 100, duration: 500, easing: 'linear', order: 'sequential', path: { c1: { x: 605, y: 440 }, c2: { x: 765, y: 110 } } });
  return scene;
}
function docFor(scene: Scene) { const doc = new Y.Doc(); const project = makeDemoProject(); project.scenes[scene.id] = scene; initializeDocument(doc, project); return doc; }

describe('group animation edits', () => {
  test('lists only selected, unlocked objects present at both endpoints and reports exclusions', () => {
    const scene = fixture(); scene.objects.circle.locked = true;
    scene.objects.hidden = { ...scene.objects.circle, id: 'hidden', locked: false };
    for (const comp of Object.values(scene.compositions)) comp.states.hidden = defaultState('circle', { visible: false });
    const scope = groupAnimationTargets(scene, 'transition-1', ['second', 'circle', 'equation', 'hidden', 'missing', 'second']);
    expect(scope.targets.map(target => target.object.id)).toEqual(['second']);
    expect(scope.excluded.map(target => [target.object.id, target.reason])).toEqual([['circle', 'locked'], ['equation', 'one-sided'], ['hidden', 'hidden']]);
  });

  test('changes only explicit timing/type fields and preserves each path, order and endpoint state', () => {
    const scene = fixture(); const doc = docFor(scene);
    try {
      const before = readProject(doc)!.scenes[scene.id];
      applyChanges(doc, groupAnimationChanges(before, 'transition-1', ['circle', 'second', 'equation'], { type: 'move', duration: 400 }));
      const after = readProject(doc)!.scenes[scene.id];
      expect(after.compositions).toEqual(before.compositions);
      for (const id of ['circle', 'second']) expect(after.transitions['transition-1'].tracks[id]).toEqual({ ...before.transitions['transition-1'].tracks[id], type: 'move', duration: 400 });
      expect(after.transitions['transition-1'].tracks.equation).toEqual(before.transitions['transition-1'].tracks.equation);
      expect(after.transitions['transition-1'].tracks.circle.path).not.toEqual(after.transitions['transition-1'].tracks.second.path);
    } finally { doc.destroy(); }
  });

  test('creates a complete missing track with valid remaining duration for a later start', () => {
    const scene = fixture(); delete scene.transitions['transition-1'].tracks.second;
    const changes = groupAnimationChanges(scene, 'transition-1', ['second'], { start: 250 });
    expect(changes).toEqual([{ path: ['scenes', scene.id, 'transitions', 'transition-1', 'tracks', 'second'], value: defaultTrack('second', { start: 250, duration: 550 }) }]);
    expect(groupAnimationChanges(scene, 'transition-1', ['second'], { type: 'move' })[0].value).toEqual(defaultTrack('second', { duration: 800 }));
  });

  test.each([{ start: 400 }, { duration: 801 }, { start: NaN }, { duration: Infinity }, { duration: -1 }])('rejects the whole batch for invalid timing %o', patch => {
    const scene = fixture(), before = structuredClone(scene);
    expect(() => groupAnimationChanges(scene, 'transition-1', ['second', 'circle'], patch)).toThrow();
    expect(scene).toEqual(before);
  });

  test('uses one undo item for all member edits and preserves a collaborator’s independent easing', () => {
    const scene = fixture(), doc = docFor(scene);
    const undo = new Y.UndoManager(doc.getMap('project'), { trackedOrigins: new Set([LOCAL_ORIGIN]) });
    try {
      applyChanges(doc, groupAnimationChanges(readProject(doc)!.scenes[scene.id], 'transition-1', ['circle', 'second'], { duration: 350 }));
      applyChanges(doc, [{ path: ['scenes', scene.id, 'transitions', 'transition-1', 'tracks', 'second', 'easing'], value: 'easeOut' }], 'peer');
      expect(undo.undoStack).toHaveLength(1); undo.undo();
      const tracks = readProject(doc)!.scenes[scene.id].transitions['transition-1'].tracks;
      expect(tracks.circle.duration).toBe(600); expect(tracks.second.duration).toBe(500); expect(tracks.second.easing).toBe('easeOut');
    } finally { undo.destroy(); doc.destroy(); }
  });

  test('mixed fields stay mixed and zero-duration tracks remain valid', () => {
    const scene = fixture(); let targets = groupAnimationTargets(scene, 'transition-1', ['circle', 'second']).targets;
    expect(commonTrackValue(targets, 'start')).toBeUndefined(); expect(commonTrackValue(targets, 'type')).toBeUndefined();
    scene.transitions['transition-1'].duration = 0;
    for (const track of Object.values(scene.transitions['transition-1'].tracks)) { track.start = 0; track.duration = 0; }
    expect(groupAnimationChanges(scene, 'transition-1', ['circle', 'second'], { start: 0, duration: 0 })).toEqual([]);
    targets = groupAnimationTargets(scene, 'transition-1', ['circle', 'second']).targets;
    expect(commonTrackValue(targets, 'duration')).toBe(0);
  });

  test('group identity expansion matches keyboard semantics and skips locked members', () => {
    const scene = fixture(); scene.objects.circle.groupId = 'group-a'; scene.objects.second.groupId = 'group-a'; scene.objects.second.locked = true;
    expect(groupMembers(scene, 'group-a').map(object => object.id)).toEqual(['circle', 'second']);
    expect(editableGroupMembers(scene, ['circle', 'sigmoid']).map(object => object.id)).toEqual(['sigmoid', 'circle']);
    expect(editableGroupMembers(scene, ['second'])).toEqual([]);
  });
});
