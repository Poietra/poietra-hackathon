import { expect, test } from 'vitest';
import { makeDemoProject } from '../shared/demo';
import { defaultTrack } from '../shared/model';
import { visibleAnimations } from '../src/editor/animation-tracks';
import { groupAnimationChanges, groupAnimationTargets } from '../src/editor/groups';

test('lists automatic motion in paint order without materializing tracks and hides absent objects', () => {
  const scene = makeDemoProject().scenes['scene-1'];
  const transition = scene.transitions['transition-1'];
  const before = structuredClone(scene);
  const rows = visibleAnimations(scene, transition);
  expect(rows.map(row => row.object.id)).toEqual(['sigmoid', 'circle', 'equation']);
  expect(rows[0]).toMatchObject({ track: defaultTrack('sigmoid', { duration: 800 }), existing: false, presence: 'both' });
  expect(rows[2]).toMatchObject({ existing: true, presence: 'enter' });
  expect(scene).toEqual(before);
  scene.compositions['comp-2'].states.circle.visible = false;
  scene.compositions['comp-2'].states.equation.visible = false;
  scene.objects.circle.locked = true;
  expect(visibleAnimations(scene, transition).map(row => [row.object.id, row.presence])).toEqual([['sigmoid', 'both'], ['circle', 'exit']]);
});

test.each(['write', 'fade', 'grow'] as const)('%s batches mixed Enter/Exit while preserving paths, timings and composition states', type => {
  const scene = makeDemoProject().scenes['scene-1'];
  scene.compositions['comp-2'].states.circle.visible = false;
  const transition = scene.transitions['transition-1'];
  const before = structuredClone(scene);
  expect(groupAnimationTargets(scene, transition.id, ['circle', 'equation']).targets.map(row => row.presence)).toEqual(['exit', 'enter']);
  expect(groupAnimationChanges(scene, transition.id, ['circle', 'equation'], { type })).toEqual([
    ...(['circle', 'equation'] as const).flatMap(id => transition.tracks[id].type === type ? [] : [{ path: ['scenes', scene.id, 'transitions', transition.id, 'tracks', id, 'type'], value: type }]),
  ]);
  expect(scene).toEqual(before);
});

test('Write order changes only order and rechecks live locks', () => {
  const scene = makeDemoProject().scenes['scene-1'];
  scene.objects.circle.locked = true;
  expect(groupAnimationChanges(scene, 'transition-1', ['circle', 'equation'], { order: 'sequential' })).toEqual([
    { path: ['scenes', scene.id, 'transitions', 'transition-1', 'tracks', 'equation', 'order'], value: 'sequential' },
  ]);
  expect(() => groupAnimationChanges(scene, 'transition-1', ['equation'], { type: 'invalid' as never })).toThrow();
  expect(() => groupAnimationChanges(scene, 'transition-1', ['equation'], { order: 'invalid' as never })).toThrow();
});
