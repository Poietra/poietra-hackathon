import { describe, expect, it } from 'vitest';
import { makeBlankScene, makeDemoProject } from '../shared/demo';
import { projectDuration, projectSegmentAt, projectSegments } from '../shared/project-timeline';

describe('project playback time', () => {
  it('uses one continuous clock with a cut at the exact Scene boundary', () => {
    const project = makeDemoProject();
    const next = makeBlankScene('next', 'Next');
    next.compositions[next.compositionOrder[0]].duration = 250;
    project.scenes.next = next; project.sceneOrder.push('next');
    const segments = projectSegments(project);
    expect(segments.map(({ start, duration }) => ({ start, duration }))).toEqual([{ start: 0, duration: 3400 }, { start: 3400, duration: 250 }]);
    expect(projectDuration(project)).toBe(3650);
    expect(projectSegmentAt(segments, 3399.9)?.scene).toBe(project.scenes['scene-1']);
    expect(projectSegmentAt(segments, 3400)?.scene).toBe(next);
    expect(projectSegmentAt(segments, 3650)?.scene).toBe(next);
    project.sceneOrder.reverse();
    expect(projectSegments(project)[1].start).toBe(250);
  });

  it('skips zero-duration and missing Scenes without inserting an extra frame', () => {
    const project = makeDemoProject(), empty = makeBlankScene('empty', 'Empty');
    empty.compositions[empty.compositionOrder[0]].duration = 0;
    project.scenes.empty = empty; project.sceneOrder = ['missing', 'empty', 'scene-1'];
    const segments = projectSegments(project);
    expect(projectDuration(project)).toBe(3400);
    expect(projectSegmentAt(segments, 0)?.scene.id).toBe('scene-1');
    project.sceneOrder = ['empty'];
    expect(projectSegmentAt(projectSegments(project), 0)?.scene).toBe(empty);
    project.sceneOrder = [];
    expect(projectDuration(project)).toBe(0);
    expect(projectSegmentAt(projectSegments(project), 0)).toBeUndefined();
  });
});
