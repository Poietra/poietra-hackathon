import * as Y from 'yjs';
import type { Project } from './model';
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
