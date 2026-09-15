import { clamp, orderedObjects, sceneSegments, type AnimationTrack, type Composition, type ObjectState, type Scene, type SceneObject, type Transition } from '../../shared/model';
import type { MotionKernel } from './kernel';

export interface RenderObject { object: SceneObject; state: ObjectState; writeProgress: number; order: 'together' | 'sequential' }
export interface Frame { objects: RenderObject[]; background: string; width: number; height: number }
const easingIds = { linear: 0, easeInOut: 1, easeIn: 2, easeOut: 3 };

function color(from: string, to: string, t: number) {
  if (!/^#[\da-f]{6}$/i.test(from) || !/^#[\da-f]{6}$/i.test(to)) return t < 0.5 ? from : to;
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(from.slice(i, i + 2), 16) * (1 - t) + parseInt(to.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
}

export function compositionFrame(scene: Scene, composition: Composition): Frame {
  return { background: scene.background, width: scene.width, height: scene.height, objects: orderedObjects(scene).flatMap(object => {
    const state = composition.states[object.id];
    return state?.visible ? [{ object, state, writeProgress: 1, order: 'together' as const }] : [];
  }) };
}

export function transitionFrame(scene: Scene, transition: Transition, time: number, kernel: MotionKernel): Frame {
  const from = scene.compositions[transition.fromId];
  const to = scene.compositions[transition.toId];
  if (!from || !to) return { background: scene.background, width: scene.width, height: scene.height, objects: [] };
  const objects = orderedObjects(scene).flatMap(object => {
    const fromState = from.states[object.id];
    const toState = to.states[object.id];
    const aVisible = !!fromState?.visible;
    const bVisible = !!toState?.visible;
    if ((!aVisible && !bVisible) || (!fromState && !toState)) return [];
    const a = fromState ?? toState!;
    const b = toState ?? fromState!;
    const track: AnimationTrack = transition.tracks[object.id] ?? { objectId: object.id, type: 'move', start: 0, duration: transition.duration, easing: 'easeInOut', order: 'together', path: null };
    const progress = track.type === 'none' ? (time >= track.start + track.duration ? 1 : 0) : kernel.track_progress(time, track.start, track.duration, easingIds[track.easing]);
    const state = { ...a, visible: true, text: progress < 0.5 ? a.text : b.text };
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'strokeWidth', 'fontSize', 'cornerRadius'] as const) state[key] = kernel.interpolate(a[key], b[key], progress);
    state.fill = color(a.fill, b.fill, progress);
    state.stroke = color(a.stroke, b.stroke, progress);
    state.effect = progress < 0.5 ? a.effect : b.effect;
    state.path = { c1: { x: kernel.interpolate(a.path.c1.x, b.path.c1.x, progress), y: kernel.interpolate(a.path.c1.y, b.path.c1.y, progress) }, c2: { x: kernel.interpolate(a.path.c2.x, b.path.c2.x, progress), y: kernel.interpolate(a.path.c2.y, b.path.c2.y, progress) } };
    if (track.path && aVisible && bVisible) {
      state.x = kernel.cubic_bezier(a.x, track.path.c1.x, track.path.c2.x, b.x, progress);
      state.y = kernel.cubic_bezier(a.y, track.path.c1.y, track.path.c2.y, b.y, progress);
    }
    const presence = !aVisible ? progress : !bVisible ? 1 - progress : 1;
    if (track.type !== 'write') state.opacity *= presence;
    else if (presence === 0) state.opacity = 0;
    if (track.type === 'grow' && (!aVisible || !bVisible)) { state.width *= presence; state.height *= presence; state.fontSize *= presence; }
    return [{ object, state, writeProgress: track.type === 'write' ? (!bVisible ? 1 - progress : progress) : 1, order: track.order }];
  });
  return { background: scene.background, width: scene.width, height: scene.height, objects };
}

export function evaluateScene(scene: Scene, time: number, kernel: MotionKernel): Frame {
  const segments = sceneSegments(scene);
  const final = segments.at(-1);
  if (!final) return { background: scene.background, width: scene.width, height: scene.height, objects: [] };
  const current = segments.find(segment => time < segment.start + segment.duration) ?? final;
  return current.kind === 'composition' ? compositionFrame(scene, scene.compositions[current.id]) : transitionFrame(scene, scene.transitions[current.id], clamp(time - current.start, 0, current.duration), kernel);
}
