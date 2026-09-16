import type { ImageAsset } from './images';
import type { AudioTrack, MediaAsset, MediaPlayback } from './media';
import { isValidEasing, type Easing, type PresetEasing } from './easing';
export { DEFAULT_CUSTOM_EASING, isValidEasing, easingsEqual, type PresetEasing, type CubicBezierEasing, type Easing } from './easing';
export type ObjectKind = 'circle' | 'rectangle' | 'text' | 'equation' | 'path' | 'arrow' | 'numberline' | 'image' | 'video';
export type AnimationKind = 'move' | 'write' | 'fade' | 'grow' | 'none';
export type Point = { x: number; y: number };
export type Bezier = { c1: Point; c2: Point };

export interface SceneObject {
  id: string;
  name: string;
  kind: ObjectKind;
  order: number;
  groupId: string | null;
  locked: boolean;
  image?: ImageAsset;
  media?: MediaAsset;
  playback?: MediaPlayback;
}

export interface ObjectState {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text: string;
  fontSize: number;
  cornerRadius: number;
  effect: 'none' | 'glow';
  path: Bezier;
}

export interface Composition {
  id: string;
  name: string;
  duration: number;
  accent: string;
  states: Record<string, ObjectState>;
  /** Internal CRDT metadata; readProject omits these from the editable/saved view. */
  deleted?: boolean;
  incomingTransitionId?: string;
}

export const PROPERTY_CHANNELS = ['position', 'opacity', 'size', 'rotation', 'fill', 'stroke', 'strokeWidth', 'fontSize', 'cornerRadius', 'path', 'reveal'] as const;
export type PropertyChannel = typeof PROPERTY_CHANNELS[number];
export type PropertyTimingKey = `${PropertyChannel}Timing`;
export interface AnimationTiming { start: number; duration: number; easing: Easing }
export const PROPERTY_CHANNEL_LABELS: Record<PropertyChannel, string> = { position: 'Position', opacity: 'Opacity', size: 'Size', rotation: 'Rotation', fill: 'Fill', stroke: 'Stroke', strokeWidth: 'Stroke width', fontSize: 'Font size', cornerRadius: 'Corner radius', path: 'Shape path', reveal: 'Reveal' };
export const propertyTimingKey = (channel: PropertyChannel): PropertyTimingKey => `${channel}Timing`;

export interface AnimationTrack extends Partial<Record<PropertyTimingKey, AnimationTiming | null>> {
  /** A materialized automatic track still follows its Transition's base timing. */
  implicit?: boolean;
  objectId: string;
  type: AnimationKind;
  start: number;
  duration: number;
  easing: Easing;
  order: 'together' | 'sequential';
  path: Bezier | null;
}

export interface Transition {
  id: string;
  fromId: string;
  toId: string;
  duration: number;
  tracks: Record<string, AnimationTrack>;
}

export interface Scene {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string;
  objects: Record<string, SceneObject>;
  compositionOrder: string[];
  compositions: Record<string, Composition>;
  transitions: Record<string, Transition>;
  audioTracks?: Record<string, AudioTrack>;
  /** Internal CRDT tombstone; readProject omits it from the editable/saved view. */
  deleted?: boolean;
}

export interface Project {
  version: 1;
  name: string;
  sceneOrder: string[];
  scenes: Record<string, Scene>;
}

export type Selection = { kind: 'composition' | 'transition'; id: string };
export type Segment = { kind: Selection['kind']; id: string; start: number; duration: number };

export const COLORS = ['#d7d8e4', '#67c4d9', '#f4ce55', '#b5d396', '#ef8078', '#d5a3bd', '#8a8fe9', '#ffffff'];
export const KINDS: Record<ObjectKind, string> = { circle: 'Circle', rectangle: 'Rectangle', text: 'Text', equation: 'Equation', path: 'Path', arrow: 'Arrow', numberline: 'Number line', image: 'Image', video: 'Video' };
export const EASINGS: Record<PresetEasing, string> = { linear: 'Linear', easeInOut: 'Ease in out', easeIn: 'Ease in', easeOut: 'Ease out' };
export const ANIMATIONS: Record<AnimationKind, string> = { move: 'Move', write: 'Write', fade: 'Fade', grow: 'Grow', none: 'Cut' };

export function newId(prefix = 'obj') { return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`; }

export function defaultState(kind: ObjectKind, overrides: Partial<ObjectState> = {}): ObjectState {
  return {
    x: 640, y: 360, width: kind === 'path' || kind === 'arrow' || kind === 'numberline' ? 400 : 100,
    height: kind === 'path' ? -180 : kind === 'arrow' || kind === 'numberline' ? 0 : 100,
    rotation: 0, opacity: 1, visible: true, fill: '#d7d8e4', stroke: '#67c4d9',
    strokeWidth: kind === 'path' || kind === 'arrow' || kind === 'numberline' ? 2 : 0,
    text: kind === 'equation' ? 'y = \\sigma(x)' : 'Your idea, in motion.',
    fontSize: kind === 'equation' ? 42 : 36, cornerRadius: 8, effect: 'none',
    path: { c1: { x: 140, y: 0 }, c2: { x: 260, y: -180 } }, ...overrides,
  };
}

export function defaultTrack(objectId: string, overrides: Partial<AnimationTrack> = {}): AnimationTrack {
  return { objectId, type: 'move', start: 0, duration: 800, easing: 'easeInOut', order: 'together', path: null, ...overrides };
}


export function getPropertyTiming(track: AnimationTrack, channel: PropertyChannel): AnimationTiming {
  return track[propertyTimingKey(channel)] ?? { start: track.start, duration: track.duration, easing: track.easing };
}
export function hasPropertyTiming(track: AnimationTrack, channel: PropertyChannel): boolean { return track[propertyTimingKey(channel)] != null; }
export function resolveTrack(track: AnimationTrack | undefined, objectId: string, duration: number): AnimationTrack {
  return !track ? defaultTrack(objectId, { duration }) : track.implicit ? { ...track, start: 0, duration } : track;
}
export function implicitTracks(objectIds: string[], duration: number): Record<string, AnimationTrack> {
  return Object.fromEntries(objectIds.map(id => [id, defaultTrack(id, { duration, implicit: true })]));
}
export function trackTimingEnd(track: AnimationTrack, includeBase = true): number {
  return Math.max(includeBase ? track.start + track.duration : 0, ...PROPERTY_CHANNELS.flatMap(channel => {
    const timing = track[propertyTimingKey(channel)]; return timing ? [timing.start + timing.duration] : [];
  }));
}
/** Shared by manual edits, import, and AI. Every override uses Transition-local milliseconds. */
export function validateAnimationTiming(timing: AnimationTiming, duration: number): void {
  if (![timing.start, timing.duration].every(value => Number.isFinite(value) && value >= 0) || timing.start + timing.duration > duration) throw new Error('アニメーションの開始時刻と長さが Transition の範囲を超えています。');
  if (!isValidEasing(timing.easing)) throw new Error('イージングの形式が無効です。ベジェ曲線の制御点は 0〜1 で指定してください。');
}
export function validateAnimationTrack(track: AnimationTrack, duration: number): void {
  validateAnimationTiming(resolveTrack(track, track.objectId, duration), duration);
  for (const channel of PROPERTY_CHANNELS) { const timing = track[propertyTimingKey(channel)]; if (timing) validateAnimationTiming(timing, duration); }
}

export function sceneSegments(scene: Scene): Segment[] {
  let start = 0;
  const segments: Segment[] = [];
  scene.compositionOrder.forEach((id, index) => {
    const composition = scene.compositions[id];
    if (!composition) return;
    segments.push({ kind: 'composition', id, start, duration: composition.duration });
    start += composition.duration;
    const nextId = scene.compositionOrder[index + 1];
    const transition = Object.values(scene.transitions).find(t => t.fromId === id && t.toId === nextId);
    if (transition) {
      segments.push({ kind: 'transition', id: transition.id, start, duration: transition.duration });
      start += transition.duration;
    }
  });
  return segments;
}

export function sceneDuration(scene: Scene) {
  let duration = sceneSegments(scene).reduce((total, segment) => total + segment.duration, 0);
  for (const track of Object.values(scene.audioTracks ?? {})) duration = Math.max(duration, track.start + track.duration);
  for (const object of Object.values(scene.objects)) if (object.kind === 'video' && object.playback && Object.values(scene.compositions).some(composition => composition.states[object.id]?.visible)) duration = Math.max(duration, object.playback.start + object.playback.duration);
  return duration;
}
export function orderedObjects(scene: Scene) { return Object.values(scene.objects).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
export function stateFor(scene: Scene, compositionId: string, objectId: string): ObjectState | undefined { return scene.compositions[compositionId]?.states[objectId]; }
export function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
export function ms(value: number) { return Math.round(value).toLocaleString('en-US'); }
