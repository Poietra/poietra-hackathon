import { defaultState, defaultTrack, type ObjectKind, type ObjectState, type Project, type Scene, type SceneObject } from './model';

export function makeDemoProject(): Project {
  const objects: Record<string, SceneObject> = {};
  const first: Record<string, ObjectState> = {};
  const second: Record<string, ObjectState> = {};
  function object(id: string, kind: ObjectKind, name: string, state: Partial<ObjectState>, to?: Partial<ObjectState>) {
    objects[id] = { id, kind, name, groupId: null, locked: false, order: Object.keys(objects).length };
    first[id] = defaultState(kind, state);
    second[id] = { ...structuredClone(first[id]), ...to };
  }
  object('sigmoid', 'path', 'Sigmoid path', { x: 245, y: 520, width: 710, height: -330, strokeWidth: 2, path: { c1: { x: 260, y: 0 }, c2: { x: 420, y: -330 } } });
  object('circle', 'circle', 'Circle', { x: 245, y: 520, width: 42, height: 42 }, { x: 955, y: 190 });
  object('equation', 'equation', 'Equation', { x: 855, y: 440, width: 310, height: 70, fontSize: 50, visible: false }, { visible: true });
  const scene: Scene = {
    id: 'scene-1', name: 'Scene 1', width: 1280, height: 720, background: '#08090b', objects,
    compositionOrder: ['comp-1', 'comp-2'],
    compositions: {
      'comp-1': { id: 'comp-1', name: 'Composition 1', duration: 1000, accent: '#f4ce55', states: first },
      'comp-2': { id: 'comp-2', name: 'Composition 2', duration: 1600, accent: '#14aab4', states: second },
    },
    transitions: {
      'transition-1': { id: 'transition-1', fromId: 'comp-1', toId: 'comp-2', duration: 800, tracks: {
        circle: defaultTrack('circle', { duration: 600, path: { c1: { x: 505, y: 520 }, c2: { x: 665, y: 190 } } }),
        equation: defaultTrack('equation', { type: 'write', start: 400, duration: 400 }),
      } },
    },
  };
  return { version: 1, name: 'A little motion', sceneOrder: ['scene-1'], scenes: { 'scene-1': scene } };
}

export function makeBlankScene(id: string, name: string): Scene {
  const compositionId = `${id}-comp-1`;
  return { id, name, width: 1280, height: 720, background: '#08090b', objects: {}, compositionOrder: [compositionId],
    compositions: { [compositionId]: { id: compositionId, name: 'Composition 1', duration: 1000, accent: '#f4ce55', states: {} } }, transitions: {} };
}
