import { z } from 'zod';
import { getShared, getValue, LOCAL_ORIGIN, readProject, toShared, type Change } from './document';
import { defaultState, defaultTrack, newId, type AnimationTrack, type Composition, type ObjectKind, type ObjectState, type Project, type SceneObject } from './model';
import * as Y from 'yjs';

const pathCoordinate = z.number().finite().min(-10000).max(10000);
const bezierPath = z.object({
  c1: z.object({ x: pathCoordinate, y: pathCoordinate }),
  c2: z.object({ x: pathCoordinate, y: pathCoordinate }),
});

const stateProperties = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'fill', 'stroke', 'strokeWidth', 'text', 'fontSize', 'cornerRadius', 'effect'] as const;
const objectFields = { compositionId: z.string(), name: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), fill: z.string(), text: z.string(), fontSize: z.number() };
const localReference = z.string().regex(/^@[a-zA-Z][a-zA-Z0-9_-]{0,62}$/);
export const EditProposalSchema = z.object({
  message: z.string().max(3000),
  operations: z.array(z.discriminatedUnion('action', [
    z.object({ action: z.literal('setState'), compositionId: z.string(), objectId: z.string(), property: z.enum(stateProperties), value: z.union([z.number(), z.string(), z.boolean()]) }),
    z.object({ action: z.literal('setTrack'), transitionId: z.string(), objectId: z.string(), property: z.enum(['type', 'start', 'duration', 'easing', 'order']), value: z.union([z.number(), z.string()]) }),
    z.object({ action: z.literal('setMotionPath'), transitionId: z.string(), objectId: z.string(), path: bezierPath.nullable() }),
    z.object({ action: z.literal('setShapePath'), compositionId: z.string(), objectId: z.string(), path: bezierPath }),
    z.object({ action: z.literal('setCompositionDuration'), compositionId: z.string(), duration: z.number() }),
    z.object({ action: z.literal('setTransitionDuration'), transitionId: z.string(), duration: z.number() }),
    z.object({ action: z.literal('addObject'), ...objectFields, kind: z.enum(['circle', 'rectangle', 'text', 'equation', 'arrow', 'numberline']) }),
    z.object({ action: z.literal('createObject'), ref: localReference, ...objectFields, kind: z.enum(['circle', 'rectangle', 'text', 'equation', 'path', 'arrow', 'numberline']) }),
    z.object({ action: z.literal('appendComposition'), ref: localReference, transitionRef: localReference, name: z.string().trim().min(1).max(100), duration: z.number().finite().min(0).max(120000), transitionDuration: z.number().finite().min(0).max(120000) }),
  ])).max(100),
});

export interface ProposalGuard { path: string[]; expected: unknown; existed: boolean; parentIdentity?: string }
export type GuardedChange = Change & ProposalGuard;
export interface EditScope { selectedIds: string[]; compositionId: string | null; transitionId: string | null }
export interface CompositionAppend { sceneId: string; compositionIds: string[]; orderIdentity: string }
export interface EditProposal { id: string; message: string; changes: GuardedChange[]; count: number; guards?: ProposalGuard[]; compositionAppends?: CompositionAppend[] }

const safePath = (path: string[]) => path.length > 0 && path.every(key => !['__proto__', 'constructor', 'prototype'].includes(key));
const pathKey = (path: string[]) => JSON.stringify(path);
const owns = (value: object, key: string) => Object.hasOwn(value, key);
const identityOf = (doc: Y.Doc, path: string[]) => {
  const parent = getShared(doc, path.slice(0, -1));
  return parent instanceof Y.Map ? JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(parent, 0))) : undefined;
};
const arrayIdentity = (array: Y.Array<unknown>) => JSON.stringify(Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(array, 0)));
const sameValue = (first: unknown, second: unknown): boolean => {
  if (Object.is(first, second)) return true;
  if (!first || !second || typeof first !== 'object' || typeof second !== 'object') return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every(key => owns(second, key) && sameValue((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]));
};

export function validateStateValue(property: string, value: unknown, kind?: ObjectKind): void {
  if (kind === 'image' && ['fill', 'text', 'fontSize'].includes(property)) throw new Error('画像の色や内容は変更できません。配置・サイズ・表示・動きを調整してください。');
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
    if (change.path[2] === 'compositionOrder') throw new Error('Composition の順序は既存の配列へ追加してください。');
  }
  const appends = z.array(z.object({ sceneId: z.string(), compositionIds: z.array(z.string()).min(1).max(4), orderIdentity: z.string() }).strict()).max(1).parse(proposal.compositionAppends ?? []);
  const appendedPaths = new Set<string>();
  const incomingPaths = new Set<string>();
  for (const append of appends) {
    const scene = project?.scenes[append.sceneId];
    const order = getShared(doc, ['scenes', append.sceneId, 'compositionOrder']);
    if (!scene || !(order instanceof Y.Array) || arrayIdentity(order) !== append.orderIdentity) throw new Error('提案後に Composition の順序が変更されました。今の状態でもう一度依頼してください。');
    if (new Set(append.compositionIds).size !== append.compositionIds.length || scene.compositionOrder.length + append.compositionIds.length > 100) throw new Error('Composition の追加順序が無効です。');
    let previousId = scene.compositionOrder.at(-1)!;
    for (const id of append.compositionIds) {
      const path = ['scenes', append.sceneId, 'compositions', id];
      const change = proposal.changes.find(value => pathKey(value.path) === pathKey(path));
      const comp = change?.value as Composition | undefined;
      if (!safePath(path) || !change || change.existed || !comp || comp.id !== id || comp.deleted || !comp.incomingTransitionId) throw new Error('追加する Composition が無効です。');
      z.number().finite().min(0).max(120000).parse(comp.duration);
      const transitionPath = ['scenes', append.sceneId, 'transitions', comp.incomingTransitionId];
      const transitionChange = proposal.changes.find(value => pathKey(value.path) === pathKey(transitionPath));
      const transition = transitionChange?.value as { id: string; fromId: string; toId: string } | undefined;
      if (!transitionChange || transitionChange.existed || !transition || transition.id !== comp.incomingTransitionId || transition.fromId !== previousId || transition.toId !== id || incomingPaths.has(pathKey(transitionPath))) throw new Error('追加する Transition の参照が無効です。');
      appendedPaths.add(pathKey(path)); incomingPaths.add(pathKey(transitionPath)); previousId = id;
    }
  }
  for (const change of proposal.changes) if (change.path[0] === 'scenes' && change.path.length === 4) {
    if (change.path[2] === 'compositions' && !appendedPaths.has(pathKey(change.path))) throw new Error('Composition の追加情報が見つかりません。');
    if (change.path[2] === 'transitions' && !incomingPaths.has(pathKey(change.path))) throw new Error('Transition の追加情報が見つかりません。');
  }
  // Project both duration and track edits before checking coupled timing. Recheck every
  // live track, including a peer's newly added track that was absent when AI started.
  const transitions = new Map<string, { tracks: Record<string, AnimationTrack>; duration: number }>();
  for (const change of proposal.changes) {
    const path = change.path;
    if (path[0] === 'scenes' && path[2] === 'transitions' && path.length === 4) {
      transitions.set(pathKey(path), structuredClone(change.value as { tracks: Record<string, AnimationTrack>; duration: number }));
      continue;
    }
    if (path[0] !== 'scenes' || path[2] !== 'transitions' || !['tracks', 'duration'].includes(path[4])) continue;
    const base = path.slice(0, 4); const key = pathKey(base);
    let entry = transitions.get(key);
    if (!entry) {
      const duration = getValue(doc, [...base, 'duration']);
      if (typeof duration !== 'number') throw new Error('Transition が見つかりません。');
      entry = { tracks: structuredClone(getValue(doc, [...base, 'tracks']) as Record<string, AnimationTrack>), duration };
      transitions.set(key, entry);
    }
    if (path[4] === 'duration') entry.duration = change.value as number;
    else if (path.length === 6) entry.tracks[path[5]] = structuredClone(change.value as AnimationTrack);
    else {
      const track = entry.tracks[path[5]];
      if (!track) throw new Error('編集対象のアニメーションが見つかりません。');
      Object.assign(track, { [path[6]]: change.value });
    }
  }
  for (const { tracks, duration } of transitions.values()) {
    z.number().finite().min(0).max(120000).parse(duration);
    for (const track of Object.values(tracks)) {
      if (!track) throw new Error('編集対象のアニメーションが見つかりません。');
      validateTrackTiming(track, duration);
    }
  }
}

/** Apply a portable proposal atomically without replacing CRDT order arrays. */
export function applyProposal(doc: Y.Doc, proposal: EditProposal, origin: unknown = LOCAL_ORIGIN): void {
  validateProposalForApply(doc, proposal);
  // Resolve and prepare every shared value before entering the transaction: Yjs
  // transactions do not roll back, including a failure after an order append.
  const changes = proposal.changes.map(change => ({ parent: getShared(doc, change.path.slice(0, -1)) as Y.Map<unknown>, key: change.path.at(-1)!, value: change.value === undefined ? undefined : toShared(change.value) }));
  const appends = (proposal.compositionAppends ?? []).map(append => ({ order: getShared(doc, ['scenes', append.sceneId, 'compositionOrder']) as Y.Array<string>, ids: [...append.compositionIds] }));
  doc.transact(() => {
    for (const { parent, key, value } of changes) { if (value === undefined) parent.delete(key); else parent.set(key, value); }
    for (const { order, ids } of appends) order.push(ids);
  }, origin);
}

export function compileProposal(doc: Y.Doc, project: Project, sceneId: string, raw: z.infer<typeof EditProposalSchema>, _scope?: EditScope): EditProposal {
  // Selection supplies context; actual Scene identities, locks and guards authorize edits.
  const input = EditProposalSchema.parse(raw);
  const original = owns(project.scenes, sceneId) ? project.scenes[sceneId] : undefined;
  if (!original) throw new Error('Scene が見つかりません。');
  const scene = structuredClone(original);
  const changes: Change[] = [];
  const guardPaths = new Map<string, string[]>();
  const base = ['scenes', sceneId];
  const guard = (path: string[]) => { if (!safePath(path)) throw new Error('編集対象が無効です。'); guardPaths.set(pathKey(path), path); };
  guard([...base, 'deleted']); guard([...base, 'compositionOrder']);
  const rawCompositions = getShared(doc, [...base, 'compositions']);
  const rawOrder = getShared(doc, [...base, 'compositionOrder']);
  if (!(rawCompositions instanceof Y.Map) || !(rawOrder instanceof Y.Array)) throw new Error('Composition が見つかりません。');
  for (const id of rawCompositions.keys()) {
    guard([...base, 'compositions', id, 'deleted']);
    guard([...base, 'compositions', id, 'incomingTransitionId']);
  }
  const references = new Map<string, { id: string; kind: 'object' | 'composition' | 'transition' }>();
  const declarations = new Map<object, string>();
  const created = new Map<string, { object: SceneObject; state: ObjectState; compositionId: string; declared: boolean }>();
  const appended: string[] = [];
  const newTransitions = new Set<string>();
  const finalDurations = new Map<string, number>();
  const reserve = (ref: string, kind: 'object' | 'composition' | 'transition') => {
    if (references.has(ref) || owns(original.objects, ref) || owns(original.compositions, ref) || owns(original.transitions, ref)) throw new Error('新しい対象の参照名は、既存 ID と重複しない一意の名前にしてください。');
    const id = newId(kind === 'object' ? 'obj' : kind === 'composition' ? 'comp' : 'transition');
    references.set(ref, { id, kind }); return id;
  };
  const resolve = (value: string, kind: 'object' | 'composition' | 'transition') => {
    const reference = references.get(value);
    if (reference && reference.kind !== kind) throw new Error('参照名の対象の種類が一致しません。');
    return reference?.id ?? value;
  };
  let appendCount = 0;
  for (const operation of input.operations) {
    if (operation.action === 'createObject') declarations.set(operation, reserve(operation.ref, 'object'));
    else if (operation.action === 'addObject') declarations.set(operation, newId());
    else if (operation.action === 'appendComposition') {
      if (++appendCount > 4 || original.compositionOrder.length + appendCount > 100) throw new Error('一度に追加できる Composition は 4 個まで、Scene 全体では 100 個までです。');
      reserve(operation.ref, 'composition'); reserve(operation.transitionRef, 'transition');
    }
  }
  const guardObject = (objectId: string) => {
    const object = owns(scene.objects, objectId) ? scene.objects[objectId] : undefined;
    if (!object) throw new Error('編集対象のオブジェクトが見つかりません。');
    if (object.locked) throw new Error('ロック中のオブジェクトは編集できません。');
    if (!created.has(objectId)) for (const key of ['id', 'kind', 'locked']) guard([...base, 'objects', objectId, key]);
    return object;
  };
  const guardComposition = (compositionId: string) => {
    if (!owns(scene.compositions, compositionId)) throw new Error('Composition が見つかりません。新しい Composition は appendComposition で先に宣言してください。');
    if (appended.includes(compositionId)) return;
    guard([...base, 'compositions', compositionId, 'id']);
    guard([...base, 'compositions', compositionId, 'deleted']);
  };
  const guardTransition = (transitionId: string) => {
    const transition = owns(scene.transitions, transitionId) ? scene.transitions[transitionId] : undefined;
    if (!transition) throw new Error('Transition が見つかりません。新しい Transition は appendComposition で先に宣言してください。');
    guardComposition(transition.fromId); guardComposition(transition.toId);
    if (!newTransitions.has(transitionId)) for (const property of ['id', 'duration', 'fromId', 'toId']) guard([...base, 'transitions', transitionId, property]);
    return transition;
  };
  // Object references retain forward-reference compatibility. Composition declarations
  // execute in order: later objects are not accidentally inherited by an earlier append.
  let nextOrder = Math.max(-1, ...Object.values(scene.objects).map(object => object.order)) + 1;
  for (const operation of input.operations) {
    if (operation.action === 'setTransitionDuration') {
      const id = resolve(operation.transitionId, 'transition');
      z.number().finite().min(0).max(120000).parse(operation.duration); finalDurations.set(id, operation.duration);
      if (owns(original.transitions, id)) {
        const transition = guardTransition(id);
        for (const objectId of Object.keys(transition.tracks)) for (const property of ['objectId', 'start', 'duration']) guard([...base, 'transitions', id, 'tracks', objectId, property]);
      }
    }
    if (operation.action !== 'addObject' && operation.action !== 'createObject') continue;
    for (const key of ['x', 'y', 'width', 'height', 'fill', 'text', 'fontSize'] as const) validateStateValue(key, operation[key], operation.kind);
    const id = declarations.get(operation)!;
    const compositionId = resolve(operation.compositionId, 'composition');
    const object: SceneObject = { id, name: operation.name.trim().slice(0, 100) || operation.kind, kind: operation.kind, order: nextOrder++, locked: false, groupId: null };
    const state = defaultState(operation.kind, { x: operation.x, y: operation.y, width: operation.width, height: operation.height, fill: operation.fill, text: operation.text, fontSize: operation.fontSize });
    created.set(id, { object, state, compositionId, declared: false }); scene.objects[id] = object;
    for (const composition of Object.values(scene.compositions)) {
      guardComposition(composition.id);
      composition.states[id] = { ...structuredClone(state), visible: composition.id === compositionId };
    }
  }
  const stateOf = (compositionId: string, objectId: string) => scene.compositions[compositionId]?.states[objectId];
  const tracks = new Map<string, { path: string[]; value: AnimationTrack; duration: number; existing: boolean; motionPathEdited: boolean }>();
  function editableTrack(transitionId: string, objectId: string) {
    guardObject(objectId);
    const transition = guardTransition(transitionId);
    if (!stateOf(transition.fromId, objectId) && !stateOf(transition.toId, objectId)) throw new Error('この Transition にオブジェクトがありません。');
    const path = [...base, 'transitions', transitionId, 'tracks', objectId];
    let entry = tracks.get(pathKey(path));
    if (!entry) {
      const existing = !newTransitions.has(transitionId) && owns(transition.tracks, objectId);
      const duration = finalDurations.get(transitionId) ?? transition.duration;
      entry = { path, duration, existing, motionPathEdited: false, value: existing ? structuredClone(transition.tracks[objectId]) : defaultTrack(objectId, { duration }) };
      tracks.set(pathKey(path), entry);
      if (existing) for (const property of ['start', 'duration']) guard([...path, property]);
    }
    return { entry, transition };
  }
  for (const source of input.operations) {
    // Resolve according to the field's type; refs cannot impersonate another identity kind.
    const operation = { ...source,
      ...('objectId' in source ? { objectId: resolve(source.objectId, 'object') } : {}),
      ...('compositionId' in source ? { compositionId: resolve(source.compositionId, 'composition') } : {}),
      ...('transitionId' in source ? { transitionId: resolve(source.transitionId, 'transition') } : {}),
    } as typeof source;
    if (operation.action === 'appendComposition') {
      const fromId = scene.compositionOrder.at(-1)!;
      guardComposition(fromId);
      const previous = scene.compositions[fromId];
      if (!appended.includes(fromId)) {
        // Every inherited property is a read dependency, including a peer's new state.
        guard([...base, 'compositions', fromId, 'states']);
        for (const objectId of Object.keys(original.compositions[fromId].states)) for (const property of ['id', 'kind']) guard([...base, 'objects', objectId, property]);
        if (getValue(doc, [...base, 'compositions', fromId, 'deleted']) === true) changes.push({ path: [...base, 'compositions', fromId, 'deleted'], value: false });
      }
      const id = resolve(operation.ref, 'composition'), transitionId = resolve(operation.transitionRef, 'transition');
      const states = structuredClone(previous.states);
      for (const [objectId, pending] of created) if (!pending.declared) states[objectId] = { ...structuredClone(pending.state), visible: pending.compositionId === id };
      const composition: Composition = { id, name: operation.name, duration: operation.duration, accent: previous.accent, states, deleted: false, incomingTransitionId: transitionId };
      scene.compositions[id] = composition; scene.compositionOrder.push(id); appended.push(id);
      scene.transitions[transitionId] = { id: transitionId, fromId, toId: id, duration: finalDurations.get(transitionId) ?? operation.transitionDuration, tracks: {} };
      newTransitions.add(transitionId);
    } else if (operation.action === 'addObject' || operation.action === 'createObject') {
      guardComposition(operation.compositionId);
      created.get(declarations.get(source)!)!.declared = true;
    } else if (operation.action === 'setState') {
      const object = guardObject(operation.objectId); guardComposition(operation.compositionId);
      const state = stateOf(operation.compositionId, operation.objectId);
      if (!state) throw new Error('編集対象の状態が見つかりません。');
      validateStateValue(operation.property, operation.value, object.kind);
      Object.assign(state, { [operation.property]: operation.value });
      if (!created.has(operation.objectId) && !appended.includes(operation.compositionId)) changes.push({ path: [...base, 'compositions', operation.compositionId, 'states', operation.objectId, operation.property], value: operation.value });
    } else if (operation.action === 'setTrack' || operation.action === 'setMotionPath') {
      const { entry, transition } = editableTrack(operation.transitionId, operation.objectId);
      if (operation.action === 'setMotionPath') {
        entry.value.path = operation.path; entry.motionPathEdited = true;
        if (entry.existing) { changes.push({ path: [...entry.path, 'path'], value: operation.path }); guard([...entry.path, 'type']); }
        if (!created.has(operation.objectId)) for (const compositionId of [transition.fromId, transition.toId]) {
          if (!appended.includes(compositionId)) for (const property of ['x', 'y', 'visible']) guard([...base, 'compositions', compositionId, 'states', operation.objectId, property]);
        }
      } else {
        if (operation.property === 'type') z.enum(['move', 'write', 'fade', 'grow', 'none']).parse(operation.value);
        else if (operation.property === 'easing') z.enum(['linear', 'easeInOut', 'easeIn', 'easeOut']).parse(operation.value);
        else if (operation.property === 'order') z.enum(['together', 'sequential']).parse(operation.value);
        else z.number().finite().min(0).max(entry.duration).parse(operation.value);
        Object.assign(entry.value, { [operation.property]: operation.value });
        if (entry.existing) changes.push({ path: [...entry.path, operation.property], value: operation.value });
      }
    } else if (operation.action === 'setShapePath') {
      const object = guardObject(operation.objectId); guardComposition(operation.compositionId);
      if (object.kind !== 'path') throw new Error('図形の制御点を編集できるのはベジェ曲線だけです。移動経路には setMotionPath を使ってください。');
      const state = stateOf(operation.compositionId, operation.objectId);
      if (!state) throw new Error('編集対象の状態が見つかりません。');
      state.path = operation.path;
      if (!created.has(operation.objectId) && !appended.includes(operation.compositionId)) {
        const path = [...base, 'compositions', operation.compositionId, 'states', operation.objectId];
        for (const property of ['x', 'y', 'width', 'height', 'rotation']) guard([...path, property]);
        changes.push({ path: [...path, 'path'], value: operation.path });
      }
    } else if (operation.action === 'setCompositionDuration') {
      guardComposition(operation.compositionId); z.number().finite().min(0).max(120000).parse(operation.duration);
      scene.compositions[operation.compositionId].duration = operation.duration;
      if (!appended.includes(operation.compositionId)) changes.push({ path: [...base, 'compositions', operation.compositionId, 'duration'], value: operation.duration });
    } else if (operation.action === 'setTransitionDuration') guardTransition(operation.transitionId);
  }
  for (const [id, duration] of finalDurations) if (!newTransitions.has(id)) changes.push({ path: [...base, 'transitions', id, 'duration'], value: duration });
  for (const [id, pending] of created) {
    changes.push({ path: [...base, 'objects', id], value: pending.object });
    for (const compositionId of original.compositionOrder) changes.push({ path: [...base, 'compositions', compositionId, 'states', id], value: scene.compositions[compositionId].states[id] });
  }
  for (const entry of tracks.values()) {
    validateTrackTiming(entry.value, entry.duration);
    const transition = scene.transitions[entry.path[3]];
    if (entry.motionPathEdited && entry.value.path !== null) {
      if (entry.value.type !== 'move') throw new Error('移動経路を使うアニメーションは Move にしてください。');
      if (![transition.fromId, transition.toId].every(id => stateOf(id, entry.value.objectId)?.visible === true)) throw new Error('移動経路には両方の Composition に表示されるオブジェクトが必要です。');
    }
    if (newTransitions.has(transition.id)) transition.tracks[entry.value.objectId] = entry.value;
    else if (!entry.existing) changes.push({ path: entry.path, value: entry.value });
  }
  for (const id of appended) changes.push({ path: [...base, 'compositions', id], value: scene.compositions[id] });
  for (const id of newTransitions) changes.push({ path: [...base, 'transitions', id], value: scene.transitions[id] });
  const precondition = (path: string[]): ProposalGuard => {
    const expected = getValue(doc, path);
    return { path, expected: expected ?? null, existed: expected !== undefined, parentIdentity: identityOf(doc, path) };
  };
  const unique = new Map(changes.map(change => [pathKey(change.path), change]));
  const guarded = [...unique.values()].filter(change => !sameValue(getValue(doc, change.path), change.value)).map(change => ({ ...change, ...precondition(change.path) }));
  const proposal: EditProposal = { id: newId('proposal'), message: input.message, changes: guarded, guards: [...guardPaths.values()].map(precondition), count: guarded.length ? input.operations.length : 0,
    ...(appended.length ? { compositionAppends: [{ sceneId, compositionIds: appended, orderIdentity: arrayIdentity(rawOrder) }] } : {}),
  };
  validateProposalForApply(doc, proposal);
  return proposal;
}
