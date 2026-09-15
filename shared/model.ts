export type ObjectKind = 'circle' | 'rectangle' | 'text' | 'equation' | 'path' | 'arrow' | 'numberline';
export type Easing = 'linear' | 'easeInOut' | 'easeIn' | 'easeOut';
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
}

export interface AnimationTrack {
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
export const KINDS: Record<ObjectKind, string> = { circle: 'Circle', rectangle: 'Rectangle', text: 'Text', equation: 'Equation', path: 'Path', arrow: 'Arrow', numberline: 'Number line' };
export const EASINGS: Record<Easing, string> = { linear: 'Linear', easeInOut: 'Ease in out', easeIn: 'Ease in', easeOut: 'Ease out' };
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

export function sceneDuration(scene: Scene) { return sceneSegments(scene).reduce((total, segment) => total + segment.duration, 0); }
export function orderedObjects(scene: Scene) { return Object.values(scene.objects).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)); }
export function stateFor(scene: Scene, compositionId: string, objectId: string): ObjectState | undefined { return scene.compositions[compositionId]?.states[objectId]; }
export function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
export function ms(value: number) { return Math.round(value).toLocaleString('en-US'); }
