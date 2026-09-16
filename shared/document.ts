import * as Y from 'yjs';
import { defaultTrack, type Project } from './model';
import { projectStructureView } from './structure-view';

export type Path = (string | number)[];
export type Change = { path: string[]; value: unknown };
export const LOCAL_ORIGIN = 'poietra-local';

export function toShared(value: unknown): unknown {
  if (Array.isArray(value)) { const array = new Y.Array(); array.insert(0, value.map(toShared)); return array; }
  if (value !== null && typeof value === 'object') {
    const map = new Y.Map();
    for (const [key, entry] of Object.entries(value)) map.set(key, toShared(entry));
    return map;
  }
  return value;
}

export function initializeDocument(doc: Y.Doc, project: Project) {
  const root = doc.getMap('project');
  if (root.has('version')) return;
  doc.transact(() => { for (const [key, value] of Object.entries(project)) root.set(key, toShared(value)); }, 'initialize');
}

/** Run on the authoritative server before sync; clients must not race to create this parent map. */
export function ensureSceneAudioTracks(doc: Y.Doc): boolean {
  const scenes = doc.getMap('project').get('scenes');
  if (!(scenes instanceof Y.Map)) return false;
  let changed = false;
  doc.transact(() => {
    for (const scene of scenes.values()) if (scene instanceof Y.Map && !scene.has('audioTracks')) {
      scene.set('audioTracks', new Y.Map()); changed = true;
    }
  }, 'initialize-media');
  return changed;
}

/** Authoritative migration before sync. Clients must never race to create an implicit track parent. */
const animationMigrationState = new WeakMap<Y.Doc, { dirty: boolean }>();
export function ensureSceneAnimationTracks(doc: Y.Doc): boolean {
  let state = animationMigrationState.get(doc);
  if (!state) {
    state = { dirty: true }; animationMigrationState.set(doc, state);
    const current = state, root = doc.getMap('project');
    const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      for (const event of events) {
        if (!(event instanceof Y.YMapEvent)) continue;
        const path = event.path;
        if ((!path.length && event.keysChanged.has('scenes')) ||
          (path[0] === 'scenes' && (path.length === 1 ||
            (path.length === 2 && (event.keysChanged.has('objects') || event.keysChanged.has('transitions'))) ||
            (path.length === 3 && ['objects', 'transitions'].includes(String(path[2]))) ||
            (path.length === 4 && path[2] === 'transitions' && event.keysChanged.has('tracks')) ||
            (path.length === 5 && path[2] === 'transitions' && path[4] === 'tracks')))) { current.dirty = true; break; }
      }
    };
    root.observeDeep(observer);
    doc.on('destroy', () => root.unobserveDeep(observer));
  }
  if (!state.dirty) return false;
  const scenes = doc.getMap('project').get('scenes');
  if (!(scenes instanceof Y.Map)) { state.dirty = false; return false; }
  let changed = false;
  doc.transact(() => {
    for (const scene of scenes.values()) {
      if (!(scene instanceof Y.Map)) continue;
      const objects = scene.get('objects'), transitions = scene.get('transitions');
      if (!(objects instanceof Y.Map) || !(transitions instanceof Y.Map)) continue;
      for (const transition of transitions.values()) {
        if (!(transition instanceof Y.Map)) continue;
        const tracks = transition.get('tracks'), duration = transition.get('duration');
        if (!(tracks instanceof Y.Map) || typeof duration !== 'number') continue;
        for (const objectId of objects.keys()) if (!tracks.has(objectId)) {
          tracks.set(objectId, toShared(defaultTrack(objectId, { duration, implicit: true }))); changed = true;
        }
      }
    }
  }, 'initialize-animation-tracks');
  state.dirty = false;
  return changed;
}

export function readProject(doc: Y.Doc): Project | null {
  const root = doc.getMap('project');
  return root.has('version') ? projectStructureView(root.toJSON() as Project) : null;
}

export function getShared(doc: Y.Doc, path: string[]): unknown {
  let node: unknown = doc.getMap('project');
  for (const key of path) {
    if (!(node instanceof Y.Map)) return undefined;
    node = node.get(key);
  }
  return node;
}

export function getValue(doc: Y.Doc, path: string[]): unknown {
  const value = getShared(doc, path);
  return value instanceof Y.AbstractType ? value.toJSON() : value;
}

export function applyChanges(doc: Y.Doc, changes: Change[], origin: unknown = LOCAL_ORIGIN) {
  // Validate every target before the transaction: Yjs transactions do not roll back on throw.
  const resolved = changes.map(({ path, value }) => {
    if (path.length === 0 || path.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) throw new Error('Invalid edit path');
    const parent = getShared(doc, path.slice(0, -1));
    if (!(parent instanceof Y.Map)) throw new Error(`The edit target no longer exists: ${path.join('.')}`);
    return { parent, key: path.at(-1)!, value };
  });
  doc.transact(() => {
    for (const { parent, key, value } of resolved) {
      if (value === undefined) parent.delete(key);
      // An unchanged leaf still creates a new Yjs Item if written. That stale
      // Item can win over a concurrent peer edit (e.g. extending a Transition
      // must not rewrite every unchanged track's timing). Compare here, after
      // earlier changes in this same transaction, preserving ordered writes
      // and the explicit replacement semantics of maps/arrays.
      else if (!Object.is(parent.get(key), value)) parent.set(key, toShared(value));
    }
  }, origin);
}

export function changesFor(base: string[], values: object): Change[] {
  return Object.entries(values).map(([key, value]) => ({ path: [...base, key], value }));
}
