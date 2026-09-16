import { getPropertyTiming, hasPropertyTiming, resolveTrack, type PropertyChannel, clamp, orderedObjects, sceneSegments, type AnimationTrack, type Composition, type ObjectState, type Scene, type SceneObject, type Transition } from '../../shared/model';
import { trackProgress, type MotionKernel } from './kernel';

export interface RenderObject { object: SceneObject; state: ObjectState; writeProgress: number; order: 'together' | 'sequential'; videoTimeMs?: number; videoFrame?: string }
export interface Frame { objects: RenderObject[]; background: string; width: number; height: number }

function color(from: string, to: string, t: number) {
  if (!/^#[\da-f]{6}$/i.test(from) || !/^#[\da-f]{6}$/i.test(to)) return t < 0.5 ? from : to;
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(from.slice(i, i + 2), 16) * (1 - t) + parseInt(to.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
}

function videoActive(object: SceneObject, time: number): boolean {
  if (object.kind !== 'video' || !object.media) return true;
  const playback = object.playback ?? { start: 0, offset: 0, duration: object.media.duration };
  return time >= playback.start && time < playback.start + playback.duration;
}

function mediaTime(object: SceneObject, time: number): Pick<RenderObject, 'videoTimeMs'> {
  if (object.kind !== 'video' || !object.media) return {};
  const playback = object.playback ?? { start: 0, offset: 0, duration: object.media.duration };
  return { videoTimeMs: playback.offset + clamp(time - playback.start, 0, playback.duration) };
}

export function compositionFrame(scene: Scene, composition: Composition, sceneTime = sceneSegments(scene).find(segment => segment.kind === 'composition' && segment.id === composition.id)?.start ?? 0): Frame {
  return { background: scene.background, width: scene.width, height: scene.height, objects: orderedObjects(scene).flatMap(object => {
    const state = composition.states[object.id];
    return state?.visible ? [{ object, state, ...mediaTime(object, sceneTime), writeProgress: 1, order: 'together' as const }] : [];
  }) };
}

export function transitionFrame(scene: Scene, transition: Transition, time: number, kernel: MotionKernel, sceneTime = (sceneSegments(scene).find(segment => segment.kind === 'transition' && segment.id === transition.id)?.start ?? 0) + time): Frame {
  const from = scene.compositions[transition.fromId];
  const to = scene.compositions[transition.toId];
  if (!from || !to) return { background: scene.background, width: scene.width, height: scene.height, objects: [] };
  const objects = orderedObjects(scene).flatMap(object => {
    if (!videoActive(object, sceneTime)) return [];
    const fromState = from.states[object.id];
    const toState = to.states[object.id];
    const aVisible = !!fromState?.visible;
    const bVisible = !!toState?.visible;
    if ((!aVisible && !bVisible) || (!fromState && !toState)) return [];
    const a = fromState ?? toState!;
    const b = toState ?? fromState!;
    const track: AnimationTrack = resolveTrack(transition.tracks[object.id], object.id, transition.duration);
    const timingProgress = (timing: Pick<AnimationTrack, 'start' | 'duration' | 'easing'>) => track.type === 'none' ? (time >= timing.start + timing.duration ? 1 : 0) : trackProgress(kernel, time, timing.start, timing.duration, timing.easing);
    const progress = timingProgress(track);
    const channelProgress = (channel: PropertyChannel) => hasPropertyTiming(track, channel) ? timingProgress(getPropertyTiming(track, channel)) : progress;
    const position = channelProgress('position'), shapePath = channelProgress('path'), reveal = channelProgress('reveal');
    const state = { ...a, visible: true, text: progress < 0.5 ? a.text : b.text };
    const numericChannels = { x: 'position', y: 'position', width: 'size', height: 'size', rotation: 'rotation', opacity: 'opacity', strokeWidth: 'strokeWidth', fontSize: 'fontSize', cornerRadius: 'cornerRadius' } as const;
    for (const key of Object.keys(numericChannels) as Array<keyof typeof numericChannels>) state[key] = kernel.interpolate(a[key], b[key], channelProgress(numericChannels[key]));
    state.fill = color(a.fill, b.fill, channelProgress('fill'));
    state.stroke = color(a.stroke, b.stroke, channelProgress('stroke'));
    state.effect = progress < 0.5 ? a.effect : b.effect;
    state.path = { c1: { x: kernel.interpolate(a.path.c1.x, b.path.c1.x, shapePath), y: kernel.interpolate(a.path.c1.y, b.path.c1.y, shapePath) }, c2: { x: kernel.interpolate(a.path.c2.x, b.path.c2.x, shapePath), y: kernel.interpolate(a.path.c2.y, b.path.c2.y, shapePath) } };
    if (track.path && aVisible && bVisible) {
      state.x = kernel.cubic_bezier(a.x, track.path.c1.x, track.path.c2.x, b.x, position);
      state.y = kernel.cubic_bezier(a.y, track.path.c1.y, track.path.c2.y, b.y, position);
    }
    const presence = !aVisible ? reveal : !bVisible ? 1 - reveal : 1;
    const opacityProgress = channelProgress('opacity');
    if (hasPropertyTiming(track, 'opacity') && (!aVisible || !bVisible)) state.opacity = kernel.interpolate(aVisible ? a.opacity : 0, bVisible ? b.opacity : 0, opacityProgress);
    else if (track.type !== 'write') state.opacity *= !aVisible ? opacityProgress : !bVisible ? 1 - opacityProgress : 1;
    if (track.type === 'write' && presence === 0) state.opacity = 0;
    if (track.type === 'grow' && (!aVisible || !bVisible)) { state.width *= presence; state.height *= presence; state.fontSize *= presence; }
    return [{ object, state, ...mediaTime(object, sceneTime), writeProgress: track.type === 'write' ? (!bVisible ? 1 - reveal : reveal) : 1, order: track.order }];
  });
  return { background: scene.background, width: scene.width, height: scene.height, objects };
}

export function evaluateScene(scene: Scene, time: number, kernel: MotionKernel): Frame {
  const segments = sceneSegments(scene);
  const final = segments.at(-1);
  if (!final) return { background: scene.background, width: scene.width, height: scene.height, objects: [] };
  const current = segments.find(segment => time < segment.start + segment.duration) ?? final;
  const frame = current.kind === 'composition' ? compositionFrame(scene, scene.compositions[current.id], time) : transitionFrame(scene, scene.transitions[current.id], clamp(time - current.start, 0, current.duration), kernel, time);
  return { ...frame, objects: frame.objects.filter(item => videoActive(item.object, time)) };
}
