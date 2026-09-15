import { sceneDuration, type Project, type Scene } from './model';

export interface ProjectSegment { scene: Scene; start: number; duration: number }

/** Scene order is the film order. Scene boundaries are cuts, without extra hold time. */
export function projectSegments(project: Project): ProjectSegment[] {
  let start = 0;
  return project.sceneOrder.flatMap(id => {
    const scene = project.scenes[id];
    if (!scene) return [];
    const duration = sceneDuration(scene);
    const segment = { scene, start, duration }; start += duration;
    return [segment];
  });
}
export function projectDuration(project: Project): number {
  return projectSegments(project).reduce((total, segment) => total + segment.duration, 0);
}
export function projectSegmentAt(segments: ProjectSegment[], time: number): ProjectSegment | undefined {
  const timed = segments.filter(segment => segment.duration > 0);
  return timed.find(segment => time < segment.start + segment.duration) ?? timed.at(-1) ?? segments[0];
}
