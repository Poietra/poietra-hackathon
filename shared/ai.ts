import { z } from 'zod';
import { getShared, getValue, readProject, type Change } from './document';
import { defaultState, defaultTrack, newId, type AnimationTrack, type ObjectKind, type Project } from './model';
import * as Y from 'yjs';

const pathCoordinate = z.number().finite().min(-10000).max(10000);
const bezierPath = z.object({
  c1: z.object({ x: pathCoordinate, y: pathCoordinate }),
  c2: z.object({ x: pathCoordinate, y: pathCoordinate }),
});

const stateProperties = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'fill', 'stroke', 'strokeWidth', 'text', 'fontSize', 'cornerRadius', 'effect'] as const;
export const EditProposalSchema = z.object({
  message: z.string().max(3000),
  operations: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('setState'), compositionId: z.string(), objectId: z.string(), property: z.enum(stateProperties), value: z.union([z.number(), z.string(), z.boolean()]) }),
    z.object({ action: z.literal('setTrack'), transitionId: z.string(), objectId: z.string(), property: z.enum(['type', 'start', 'duration', 'easing', 'order']), value: z.union([z.number(), z.string()]) }),
    z.object({ action: z.literal('setMotionPath'), transitionId: z.string(), objectId: z.string(), path: bezierPath.nullable() }),
    z.object({ action: z.literal('setShapePath'), compositionId: z.string(), objectId: z.string(), path: bezierPath }),
    z.object({ action: z.literal('setCompositionDuration'), compositionId: z.string(), duration: z.number() }),
    z.object({ action: z.literal('addObject'), compositionId: z.string(), name: z.string(), kind: z.enum(['circle', 'rectangle', 'text', 'equation', 'arrow', 'numberline']), x: z.number(), y: z.number(), width: z.number(), height: z.number(), fill: z.string(), text: z.string(), fontSize: z.number() }),
  ])).max(100),
});

export interface ProposalGuard { path: string[]; expected: unknown; existed: boolean; parentIdentity?: string }
export type GuardedChange = Change & ProposalGuard;
export interface EditScope { selectedIds: string[]; compositionId: string | null; transitionId: string | null }
export interface EditProposal { id: string; message: string; changes: GuardedChange[]; count: number; guards?: ProposalGuard[] }

const safePath = (path: string[]) => path.length > 0 && path.every(key => !['__proto__', 'constructor', 'prototype'].includes(key));
const pathKey = (path: string[]) => JSON.stringify(path);
const owns = (value: object, key: string) => Object.hasOwn(value, key);
const identityOf = (doc: Y.Doc, path: string[]) => {
  const parent = getShared(doc, path.slice(0, -1));
  return parent instanceof Y.Map ? JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(parent, 0))) : undefined;
};
const sameValue = (first: unknown, second: unknown): boolean => {
  if (Object.is(first, second)) return true;
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every(key => owns(second, key) && sameValue((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]));
};

export function validateStateValue(property: string, value: unknown, kind?: ObjectKind): void {
  if (['fill', 'stroke'].includes(property)) { z.string().regex(/^#[a-f\d]{6}$/i).parse(value); return; }
  if (property === 'text') { z.string().max(3000).parse(value); return; }
  if (property === 'effect') { z.enum(['none', 'glow']).parse(value); return; }
  if (property === 'visible') { z.boolean().parse(value); return; }
  if (!(stateProperties as readonly string[]).includes(property)) throw new Error('編集できないプロパティです。');
  const numeric = z.number().finite().min(-10000).max(10000).parse(value);
  const endpoint = kind && ['path', 'arrow', 'numberline'].includes(kind);
  if ((['fontSize', 'cornerRadius', 'strokeWidth'].includes(property) || (!endpoint && ['width', 'height'].includes(property))) && numeric < 0) throw new Error('サイズは 0 以上で指定してください。');
  if (property === 'opacity' && (numeric < 0 || numeric > 1)) throw new Error('不透明度は 0〜1 で指定してください。');
}

function validateTrackTiming(track: Pick<AnimationTrack, 'start' | 'duration'>, duration: number) {
  z.number().finite().min(0).max(duration).parse(track.start);
  z.number().finite().min(0).max(duration).parse(track.duration);
  if (track.start + track.duration > duration) throw new Error('アニメーションの開始時刻と長さが Transition の範囲を超えています。');
}

/** Check every precondition before editing; Yjs transactions do not roll back a failed batch. */
export function validateProposalForApply(doc: Y.Doc, proposal: EditProposal): void {
  for (const guard of [...proposal.changes, ...(proposal.guards ?? [])]) {
    if (!safePath(guard.path)) throw new Error('編集案に無効な対象が含まれています。');
    const current = getValue(doc, guard.path);
    if ((guard.parentIdentity !== undefined && identityOf(doc, guard.path) !== guard.parentIdentity) || (current !== undefined) !== guard.existed || (guard.existed && !sameValue(current, guard.expected))) throw new Error('提案後に対象が変更されました。今の状態でもう一度依頼してください。');
  }
  const project = readProject(doc);
  for (const change of proposal.changes) {
    if (change.path[0] === 'scenes' && !project?.scenes[change.path[1]]) throw new Error('編集対象の Scene が削除されています。今の状態でもう一度依頼してください。');
    if (!(getShared(doc, change.path.slice(0, -1)) instanceof Y.Map)) throw new Error('編集対象が削除されています。今の状態でもう一度依頼してください。');
  }
  // Recheck final timing against the live document as well, including older proposals without guards.
  const tracks = new Map<string, { track: AnimationTrack; duration: number }>();
  for (const change of proposal.changes) {
    const path = change.path;
    if (path[0] !== 'scenes' || path[2] !== 'transitions' || path[4] !== 'tracks') continue;
    const base = path.slice(0, 6); const key = pathKey(base);
    let entry = tracks.get(key);
    if (!entry) {
      const duration = getValue(doc, [...path.slice(0, 4), 'duration']);
      if (typeof duration !== 'number') throw new Error('Transition が見つかりません。');
      entry = { track: structuredClone(getValue(doc, base) as AnimationTrack), duration };
      tracks.set(key, entry);
    }
    if (path.length === 6) entry.track = structuredClone(change.value as AnimationTrack);
    else if (entry.track) Object.assign(entry.track, { [path[6]]: change.value });
  }
  for (const { track, duration } of tracks.values()) {
    if (!track) throw new Error('編集対象のアニメーションが見つかりません。');
    validateTrackTiming(track, duration);
  }
}

export function compileProposal(doc: Y.Doc, project: Project, sceneId: string, raw: z.infer<typeof EditProposalSchema>, _scope?: EditScope): EditProposal {
  // Selection helps resolve the request; it is not an editing allowlist. All targets must
  // still exist in this Scene and satisfy the same locks, values, and apply-time guards.
  // Validate the whole model response before compiling any operation.
  const input = EditProposalSchema.parse(raw);
  const scene = owns(project.scenes, sceneId) ? project.scenes[sceneId] : undefined;
  if (!scene) throw new Error('Scene が見つかりません。');
  const changes: Change[] = [];
  const guardPaths = new Map<string, string[]>();
  const base = ['scenes', sceneId];
  const guard = (path: string[]) => { if (!safePath(path)) throw new Error('編集対象が無効です。'); guardPaths.set(pathKey(path), path); };
  guard([...base, 'deleted']);
  // readProject derives the visible chain from raw order and tombstones. Track identity can stay
  // unchanged while its visible source changes, so parent-map identity alone is not enough.
  guard([...base, 'compositionOrder']);
  const rawCompositions = getShared(doc, [...base, 'compositions']);
  if (!(rawCompositions instanceof Y.Map)) throw new Error('Composition が見つかりません。');
  for (const id of rawCompositions.keys()) {
    guard([...base, 'compositions', id, 'deleted']);
    guard([...base, 'compositions', id, 'incomingTransitionId']);
  }
  const guardObject = (objectId: string) => {
    const object = owns(scene.objects, objectId) ? scene.objects[objectId] : undefined;
    if (!object) throw new Error('編集対象のオブジェクトが見つかりません。');
    if (object.locked) throw new Error('ロック中のオブジェクトは編集できません。');
    for (const key of ['id', 'kind', 'locked']) guard([...base, 'objects', objectId, key]);
    return object;
  };
  const guardComposition = (compositionId: string) => {
    if (!owns(scene.compositions, compositionId)) throw new Error('Composition が見つかりません。');
    guard([...base, 'compositions', compositionId, 'id']);
    // A fallback visible composition may itself have deleted=true; compare its request-time value.
    guard([...base, 'compositions', compositionId, 'deleted']);
  };
  const targetComposition = (compositionId: string) => {
    guardComposition(compositionId);
  };
  const tracks = new Map<string, { path: string[]; value: AnimationTrack; duration: number; existing: boolean; motionPathEdited: boolean }>();
  function editableTrack(transitionId: string, objectId: string) {
    guardObject(objectId);
    const transition = owns(scene!.transitions, transitionId) ? scene!.transitions[transitionId] : undefined;
    if (!transition) throw new Error('Transition が見つかりません。');
    guardComposition(transition.fromId); guardComposition(transition.toId);
    if (!scene!.compositions[transition.fromId].states[objectId] && !scene!.compositions[transition.toId].states[objectId]) throw new Error('この Transition にオブジェクトがありません。');
    const path = [...base, 'transitions', transitionId, 'tracks', objectId];
    const key = pathKey(path);
    let entry = tracks.get(key);
    if (!entry) {
      const existing = owns(transition.tracks, objectId);
      entry = { path, duration: transition.duration, existing, motionPathEdited: false, value: existing ? structuredClone(transition.tracks[objectId]) : defaultTrack(objectId, { duration: transition.duration }) };
      tracks.set(key, entry);
      for (const property of ['id', 'duration', 'fromId', 'toId']) guard([...base, 'transitions', transitionId, property]);
      // Timing is a coupled constraint. A peer changing either part invalidates this proposal.
      if (existing) for (const property of ['start', 'duration']) guard([...path, property]);
    }
    return { entry, transition };
  }
  const finalStateValue = (compositionId: string, objectId: string, property: string) => {
    const path = [...base, 'compositions', compositionId, 'states', objectId, property];
    return changes.findLast(change => pathKey(change.path) === pathKey(path))?.value ?? getValue(doc, path);
  };
  let nextOrder = Math.max(-1, ...Object.values(scene.objects).map(object => object.order)) + 1;
  for (const operation of input.operations) {
    if (operation.action === 'setState') {
      const object = guardObject(operation.objectId);
      targetComposition(operation.compositionId);
      if (!owns(scene.compositions[operation.compositionId].states, operation.objectId)) throw new Error('編集対象の状態が見つかりません。');
      validateStateValue(operation.property, operation.value, object.kind);
      changes.push({ path: [...base, 'compositions', operation.compositionId, 'states', operation.objectId, operation.property], value: operation.value });
    } else if (operation.action === 'setTrack' || operation.action === 'setMotionPath') {
      const { entry, transition } = editableTrack(operation.transitionId, operation.objectId);
      if (operation.action === 'setMotionPath') {
        entry.value.path = operation.path;
        entry.motionPathEdited = true;
        if (entry.existing) {
          changes.push({ path: [...entry.path, 'path'], value: operation.path });
          guard([...entry.path, 'type']);
        }
        // Use projected endpoints here, not the raw Transition.fromId, which may name a deleted composition.
        // Absolute scene coordinates depend on both anchors. Color and other unrelated fields remain editable.
        for (const compositionId of [transition.fromId, transition.toId]) {
          for (const property of ['x', 'y', 'visible']) guard([...base, 'compositions', compositionId, 'states', operation.objectId, property]);
        }
      } else {
        if (operation.property === 'type') z.enum(['move', 'write', 'fade', 'grow', 'none']).parse(operation.value);
        else if (operation.property === 'easing') z.enum(['linear', 'easeInOut', 'easeIn', 'easeOut']).parse(operation.value);
        else if (operation.property === 'order') z.enum(['together', 'sequential']).parse(operation.value);
        else z.number().finite().min(0).max(transition.duration).parse(operation.value);
        Object.assign(entry.value, { [operation.property]: operation.value });
        if (entry.existing) changes.push({ path: [...entry.path, operation.property], value: operation.value });
      }
    } else if (operation.action === 'setShapePath') {
      const object = guardObject(operation.objectId);
      targetComposition(operation.compositionId);
      if (object.kind !== 'path') throw new Error('図形の制御点を編集できるのはベジェ曲線だけです。移動経路には setMotionPath を使ってください。');
      if (!owns(scene.compositions[operation.compositionId].states, operation.objectId)) throw new Error('編集対象の状態が見つかりません。');
      const path = [...base, 'compositions', operation.compositionId, 'states', operation.objectId];
      for (const property of ['x', 'y', 'width', 'height', 'rotation']) guard([...path, property]);
      changes.push({ path: [...path, 'path'], value: operation.path });
    } else if (operation.action === 'setCompositionDuration') {
      targetComposition(operation.compositionId);
      z.number().finite().min(0).max(120000).parse(operation.duration);
      changes.push({ path: [...base, 'compositions', operation.compositionId, 'duration'], value: operation.duration });
    } else {
      targetComposition(operation.compositionId);
      for (const key of ['x', 'y', 'width', 'height', 'fill', 'text', 'fontSize'] as const) validateStateValue(key, operation[key], operation.kind);
      const id = newId();
      changes.push({ path: [...base, 'objects', id], value: { id, name: operation.name.trim().slice(0, 100) || operation.kind, kind: operation.kind, order: nextOrder++, locked: false, groupId: null } });
      const state = defaultState(operation.kind, { x: operation.x, y: operation.y, width: operation.width, height: operation.height, fill: operation.fill, text: operation.text, fontSize: operation.fontSize });
      // Match manual addition: identity belongs to the Scene; presence belongs to each Composition.
      for (const composition of Object.values(scene.compositions)) {
        guardComposition(composition.id);
        changes.push({ path: [...base, 'compositions', composition.id, 'states', id], value: { ...state, visible: composition.id === operation.compositionId } });
      }
    }
  }
  for (const entry of tracks.values()) {
    validateTrackTiming(entry.value, entry.duration);
    if (entry.motionPathEdited && entry.value.path !== null) {
      if (entry.value.type !== 'move') throw new Error('移動経路を使うアニメーションは Move にしてください。');
      const transition = scene.transitions[entry.path[3]];
      if (![transition.fromId, transition.toId].every(id => finalStateValue(id, entry.value.objectId, 'visible') === true)) throw new Error('移動経路には両方の Composition に表示されるオブジェクトが必要です。');
    }
    if (!entry.existing) changes.push({ path: entry.path, value: entry.value });
  }
  const precondition = (path: string[]): ProposalGuard => {
    const expected = getValue(doc, path);
    return { path, expected: expected ?? null, existed: expected !== undefined, parentIdentity: identityOf(doc, path) };
  };
  // A field has one final proposed value and one precondition from the request snapshot.
  const unique = new Map(changes.map(change => [pathKey(change.path), change]));
  const guarded = [...unique.values()].filter(change => !sameValue(getValue(doc, change.path), change.value)).map(change => ({ ...change, ...precondition(change.path) }));
  const proposal = { id: newId('proposal'), message: input.message, changes: guarded, guards: [...guardPaths.values()].map(precondition), count: guarded.length ? input.operations.length : 0 };
  validateProposalForApply(doc, proposal);
  return proposal;
}
