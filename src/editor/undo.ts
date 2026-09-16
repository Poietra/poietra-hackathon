import * as Y from 'yjs';
import { getShared, LOCAL_ORIGIN } from '../../shared/document';
import { PROPERTY_CHANNELS, propertyTimingKey } from '../../shared/model';

export class EditorUndoManager extends Y.UndoManager {
  readonly peerEditedAudioTracks = new WeakSet<Y.Map<unknown>>();
  readonly peerEditedTracks = new WeakSet<Y.Map<unknown>>();
  readonly peerEditedTimings = new WeakSet<Y.Map<unknown>>();
  readonly peerEditedActivations = new WeakMap<Y.Map<unknown>, WeakSet<Y.Item>>();
  readonly peerEditedObjects = new WeakSet<Y.Map<unknown>>();
  readonly peerEditedCompositions = new WeakSet<Y.Map<unknown>>();
  readonly peerEditedTransitions = new WeakSet<Y.Map<unknown>>();
  readonly retainedCreationTracks = new WeakSet<Y.Map<unknown>>();
  lastUndoPreservedAudioTracks = 0;
  lastUndoPreservedObjects = 0;
  lastUndoPreservedDurations = 0;
  lastUndoPreservedCompositions = 0;
  private readonly root: Y.Map<unknown>;
  private readonly rememberPeerEdits = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (transaction.local) return;
    for (const event of events) {
      const path = event.path.map(String);
      if (path[0] !== 'scenes' || path.length < 3) continue;
      const rememberObject = (id: string) => {
        const object = getShared(this.doc, ['scenes', path[1], 'objects', id]);
        if (object instanceof Y.Map) this.peerEditedObjects.add(object);
      };
      const changedKeys = event instanceof Y.YMapEvent ? [...event.keysChanged] : [];
      if (path[2] === 'audioTracks') {
        for (const id of path.length === 3 ? changedKeys : [path[3]]) {
          const track = getShared(this.doc, ['scenes', path[1], 'audioTracks', id]);
          if (track instanceof Y.Map) this.peerEditedAudioTracks.add(track);
        }
        continue;
      }
      const parents = path[2] === 'compositions' ? this.peerEditedCompositions : path[2] === 'transitions' ? this.peerEditedTransitions : null;
      if (parents) for (const id of path.length === 3 ? changedKeys : [path[3]]) {
        const parent = getShared(this.doc, ['scenes', path[1], path[2], id]);
        if (parent instanceof Y.Map) parents.add(parent);
      }
      if (path[2] === 'objects') {
        for (const id of path.length === 3 ? changedKeys : [path[3]]) rememberObject(id);
        continue;
      }
      const collection = path[2] === 'compositions' ? 'states' : path[2] === 'transitions' ? 'tracks' : null;
      if (!collection || (path.length === 4 && !changedKeys.includes(collection)) || (path.length >= 5 && path[4] !== collection)) continue;
      for (const parentId of path.length === 3 ? changedKeys : [path[3]]) {
        const values = getShared(this.doc, ['scenes', path[1], path[2], parentId, collection]);
        if (!(values instanceof Y.Map)) continue;
        // Parent-map insertion/replacement is also an edit: a peer can add a
        // track or Composition that depends on an object we just created.
        const ids = path.length < 5 ? [...values.keys()] : path.length === 5 ? changedKeys : [path[5]];
        for (const id of ids) {
          rememberObject(id);
          const value = values.get(id);
          if (collection === 'tracks' && value instanceof Y.Map) {
            this.peerEditedTracks.add(value);
            const timingKeys = path.length > 6 ? [path[6]] : path.length === 6 ? changedKeys : PROPERTY_CHANNELS.map(propertyTimingKey);
            for (const channel of PROPERTY_CHANNELS) {
              const key = propertyTimingKey(channel), timing = value.get(key);
              if (timingKeys.includes(key) && timing instanceof Y.Map) this.peerEditedTimings.add(timing);
            }
            // Remember the particular activation, not merely this long-lived
            // automatic parent. Initial sync and earlier implicit edits must
            // not protect an unrelated later first base edit from Undo.
            const activation = value._map.get('implicit');
            const baseFields = ['type', 'start', 'duration', 'easing', 'order', 'path', 'implicit'];
            // Independent timing fields do not depend on the promoted base.
            // Undo that base normally while retaining a peer's channel edit.
            const editsBase = path.length < 6 || (path.length === 6 ? changedKeys.some(key => baseFields.includes(key)) : baseFields.includes(path[6]));
            if (editsBase && value.get('implicit') === false && activation) {
              let edits = this.peerEditedActivations.get(value);
              if (!edits) { edits = new WeakSet(); this.peerEditedActivations.set(value, edits); }
              edits.add(activation);
            }
          }
        }
      }
    }
  };
  constructor(doc: Y.Doc) {
    const root = doc.getMap('project');
    super(root, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 });
    this.root = root;
    // Observe from the beginning, including offline updates delivered at reconnect.
    // A later local field Undo recreates a peer's value with a local Item ID, so
    // current Item authorship alone cannot tell whether an object was shared.
    root.observeDeep(this.rememberPeerEdits);
  }
  override destroy() {
    this.root.unobserveDeep(this.rememberPeerEdits);
    super.destroy();
  }
}

function sharedCreations(manager: EditorUndoManager) {
  const action = manager.undoStack.at(-1);
  const protectedAudioTracks = new Set<Y.Map<unknown>>();
  const containers = new Set<Y.Map<unknown>>();
  const protectedTracks = new Set<Y.Map<unknown>>();
  const activatedTracks = new Set<Y.Map<unknown>>();
  const timingParents = new Map<Y.Map<unknown>, Set<string>>();
  const protectedObjects = new Set<Y.Map<unknown>>();
  const dependentTracks = new Set<Y.Map<unknown>>();
  const protectedCompositions = new Set<Y.Map<unknown>>();
  const revivedCompositions = new Set<Y.Map<unknown>>();
  const orderEntries = new Map<Y.Array<unknown>, Set<string>>();
  const roots = new Set<Y.Map<unknown>>();
  const scenes = manager.doc.getMap('project').get('scenes');
  if (action && scenes instanceof Y.Map) for (const scene of scenes.values()) {
    if (!(scene instanceof Y.Map)) continue;
    // Yjs's integrated _item identifies each map in the Undo insertion clocks.
    // Keep this dependency on Item metadata local to creation detection.
    const added = (value: unknown) => value instanceof Y.Map && !!value._item && Y.isDeleted(action.insertions, value._item.id);
    const audioTracks = scene.get('audioTracks');
    // Legacy Scenes may acquire the optional collection in this same action.
    // Retain the collection identity only, so its other untouched children still Undo.
    if (!added(scene) && audioTracks instanceof Y.Map) for (const track of audioTracks.values()) {
      if (track instanceof Y.Map && added(track) && manager.peerEditedAudioTracks.has(track)) {
        protectedAudioTracks.add(track); roots.add(track);
        if (added(audioTracks)) containers.add(audioTracks);
      }
    }
    const objects = scene.get('objects');
    const compositions = scene.get('compositions');
    const transitions = scene.get('transitions');
    function protectObject(id: string) {
      const object = objects instanceof Y.Map && !added(objects) ? objects.get(id) : null;
      if (!(object instanceof Y.Map) || !added(object)) return;
      protectedObjects.add(object); roots.add(object);
      // The identity, every Composition state and every animation form one
      // creation. Retaining only the peer-edited leaf would leave orphan tracks
      // or remove the initial fields needed to render/export the shared object.
      for (const [parents, key] of [[compositions, 'states'], [transitions, 'tracks']] as const) {
        if (!(parents instanceof Y.Map)) continue;
        for (const parent of parents.values()) {
          const values = parent instanceof Y.Map ? parent.get(key) : null;
          const value = values instanceof Y.Map ? values.get(id) : null;
          if (value instanceof Y.Map) roots.add(value);
          if (key === 'tracks' && value instanceof Y.Map) dependentTracks.add(value);
          if (key === 'tracks' && value instanceof Y.Map && !added(values) && added(value)) protectedTracks.add(value);
        }
      }
    }
    if (objects instanceof Y.Map && !added(objects)) for (const [id, object] of objects) {
      if (object instanceof Y.Map && manager.peerEditedObjects.has(object)) protectObject(id);
    }
    if (!(transitions instanceof Y.Map)) continue;
    for (const transition of transitions.values()) {
      const tracks = transition instanceof Y.Map ? transition.get('tracks') : null;
      // Existing transitions retain individual peer-edited new tracks. New
      // transitions are handled with their Composition creation batch below.
      if (!(tracks instanceof Y.Map) || !tracks._item || Y.isDeleted(action.insertions, tracks._item.id)) continue;
      for (const track of tracks.values()) {
        if (!(track instanceof Y.Map)) continue;
        if (!added(track)) for (const channel of PROPERTY_CHANNELS) {
          const key = propertyTimingKey(channel), timing = track.get(key);
          // Keep a newly independent channel only when a peer used that exact
          // parent. Other channels/base edits must not protect its creation.
          if (timing instanceof Y.Map && added(timing) && manager.peerEditedTimings.has(timing) && fieldAfterUndo(manager, action, track, key) == null) {
            const keys = timingParents.get(track) ?? new Set<string>(); keys.add(key); timingParents.set(track, keys);
            roots.add(timing); dependentTracks.add(track); protectedTracks.add(track);
          }
        }
        const activation = track._map.get('implicit');
        const promoted = track.get('implicit') === false && fieldAfterUndo(manager, action, track, 'implicit') === true && !!activation && manager.peerEditedActivations.get(track)?.has(activation);
        if (promoted) activatedTracks.add(track);
        if (promoted || added(track) && manager.peerEditedTracks.has(track)) { protectedTracks.add(track); dependentTracks.add(track); roots.add(track); }
      }
    }
    const order = scene.get('compositionOrder');
    // A whole new Scene remains outside this rule. Within an existing Scene,
    // all Compositions inserted by one action form the atomic append batch.
    if (!(compositions instanceof Y.Map) || added(compositions) || !(order instanceof Y.Array)) continue;
    const created = new Map<string, Y.Map<unknown>>();
    for (const [id, composition] of compositions) if (composition instanceof Y.Map && added(composition)) created.set(id, composition);
    if (!created.size) continue;
    const batchTransitions = new Set<Y.Map<unknown>>();
    let retain = [...created.values()].some(composition => manager.peerEditedCompositions.has(composition));
    for (const composition of created.values()) {
      const states = composition.get('states');
      if (states instanceof Y.Map && [...states.values()].some(state => state instanceof Y.Map && roots.has(state))) retain = true;
    }
    for (const transition of transitions.values()) if (transition instanceof Y.Map) {
      if (added(transition)) {
        if (created.has(String(transition.get('fromId'))) || created.has(String(transition.get('toId')))) {
          batchTransitions.add(transition);
          if (manager.peerEditedTransitions.has(transition)) retain = true;
        }
      } else {
        // A later peer append depends on our new endpoint. A reference changed
        // only by this local action (e.g. Duplicate) will Undo and is not a peer
        // dependency, so inspect the values that would remain afterwards.
        const from = fieldAfterUndo(manager, action, transition, 'fromId');
        const to = fieldAfterUndo(manager, action, transition, 'toId');
        if (created.has(String(from)) || created.has(String(to))) retain = true;
      }
    }
    if (!retain) continue;
    orderEntries.set(order, new Set(created.keys()));
    for (const [id, composition] of created) {
      protectedCompositions.add(composition); roots.add(composition);
      const states = composition.get('states');
      if (states instanceof Y.Map) for (const objectId of states.keys()) protectObject(objectId);
    }
    for (const transition of batchTransitions) {
      roots.add(transition);
      const tracks = transition.get('tracks');
      if (tracks instanceof Y.Map) for (const [objectId, track] of tracks) {
        protectObject(objectId);
        if (track instanceof Y.Map) {
          roots.add(track); dependentTracks.add(track);
          if (added(track)) protectedTracks.add(track);
        }
      }
      // An append can revive the deterministic last survivor. Keep that source
      // visible when its new incoming/outgoing animation is retained, too.
      const source = compositions.get(String(transition.get('fromId')));
      if (source instanceof Y.Map && !added(source) && source.get('deleted') !== true && fieldAfterUndo(manager, action, source, 'deleted') === true) revivedCompositions.add(source);
    }
  }
  return { roots, containers, activatedTracks, timingParents, audioTracks: protectedAudioTracks.size, dependentTracks, orderEntries, revivedCompositions, compositions: protectedCompositions.size, tracks: [...protectedTracks].filter(track => track.get('implicit') !== true || PROPERTY_CHANNELS.some(channel => track.get(propertyTimingKey(channel)) != null)).length, objects: protectedObjects.size };
}

type UndoAction = EditorUndoManager['undoStack'][number];

// Yjs restores deleted map values before consulting deleteFilter. To preserve a
// duration dependency, omit that field's old Items from this one Undo action as
// well as filtering its current Item. Keep map-history/clock access here; never
// change the document schema or disable Undo for an entire Transition.
function fieldHistory(map: Y.Map<unknown>, key: string): Y.Item[] {
  const history: Y.Item[] = [];
  for (let item = map._map.get(key); item; item = item.left ?? undefined) history.push(item);
  return history;
}
function fieldAfterUndo(manager: EditorUndoManager, action: UndoAction, map: Y.Map<unknown>, key: string): unknown {
  const history = fieldHistory(map, key), current = history[0];
  const changesCurrent = history.some(item => {
    if (!Y.isDeleted(action.insertions, item.id)) return false;
    while (item.redone) item = Y.getItem(manager.doc.store, item.redone);
    return item === current;
  });
  if (!changesCurrent) return map.get(key); // A later peer value wins normally.
  return history.find(item => Y.isDeleted(action.deletions, item.id) && !Y.isDeleted(action.insertions, item.id))?.content.getContent()[0];
}
function withoutItems(source: UndoAction['deletions'], omitted: Y.Item[]) {
  const result = Y.createDeleteSet();
  for (const [client, ranges] of source.clients) {
    let remaining = ranges.map(range => ({ clock: range.clock, len: range.len }));
    for (const item of omitted) if (item.id.client === client) remaining = remaining.flatMap(range => {
      const start = range.clock, end = start + range.len, cutStart = item.id.clock, cutEnd = cutStart + item.length;
      if (end <= cutStart || start >= cutEnd) return [range];
      return [...(start < cutStart ? [{ clock: start, len: cutStart - start }] : []), ...(end > cutEnd ? [{ clock: cutEnd, len: end - cutEnd }] : [])];
    });
    if (remaining.length) result.clients.set(client, remaining);
  }
  return result;
}
// Project live and deleted child maps alike. A restored timing is a nested
// Y.Map whose values are still tombstoned until the actual Undo/Redo transaction.
function fieldAfterStep(manager: EditorUndoManager, action: UndoAction, map: Y.Map<unknown>, key: string): unknown {
  const item = map._map.get(key);
  if (item?.deleted && Y.isDeleted(action.deletions, item.id) && !Y.isDeleted(action.insertions, item.id)) return item.content.getContent()[0];
  return fieldAfterUndo(manager, action, map, key);
}
function projectedTrackEnd(manager: EditorUndoManager, action: UndoAction, track: Y.Map<unknown>, retained = false, retainedTimings?: Set<Y.Map<unknown>>): number {
  const field = (map: Y.Map<unknown>, key: string) => retained || retainedTimings?.has(map) ? map.get(key) : fieldAfterStep(manager, action, map, key);
  const end = (map: Y.Map<unknown>) => {
    const start = field(map, 'start'), duration = field(map, 'duration');
    return typeof start === 'number' && typeof duration === 'number' ? start + duration : 0;
  };
  let maximum = field(track, 'implicit') === true ? 0 : end(track);
  for (const channel of PROPERTY_CHANNELS) {
    const current = track.get(propertyTimingKey(channel));
    const timing = current instanceof Y.Map && retainedTimings?.has(current) ? current : field(track, propertyTimingKey(channel));
    if (timing instanceof Y.Map) maximum = Math.max(maximum, end(timing));
  }
  return maximum;
}
function requiredDurations(manager: EditorUndoManager, creations: ReturnType<typeof sharedCreations>, action: UndoAction) {
  const protectedDurations = new Set<Y.Map<unknown>>();
  const scenes = manager.doc.getMap('project').get('scenes');
  if (scenes instanceof Y.Map) for (const scene of scenes.values()) {
    const transitions = scene instanceof Y.Map ? scene.get('transitions') : null;
    if (!(transitions instanceof Y.Map)) continue;
    for (const transition of transitions.values()) {
      if (!(transition instanceof Y.Map)) continue;
      const tracks = transition.get('tracks'); if (!(tracks instanceof Y.Map)) continue;
      const duration = fieldAfterUndo(manager, action, transition, 'duration');
      if (typeof duration !== 'number') continue;
      for (const track of tracks.values()) {
        if (!(track instanceof Y.Map) || !creations.dependentTracks.has(track) && !manager.retainedCreationTracks.has(track) && !manager.peerEditedTracks.has(track)) continue;
        if (projectedTrackEnd(manager, action, track, creations.roots.has(track), creations.roots) > duration) protectedDurations.add(transition);
      }
    }
  }
  return protectedDurations;
}

function assertRestoredTracksFit(manager: EditorUndoManager, action: UndoAction, keptDurations: Set<Y.Map<unknown>>, direction: 'undo' | 'redo' = 'redo', retainedTracks = new Set<Y.Map<unknown>>()) {
  const scenes = manager.doc.getMap('project').get('scenes');
  if (!(scenes instanceof Y.Map)) return;
  for (const scene of scenes.values()) {
    const transitions = scene instanceof Y.Map ? scene.get('transitions') : null;
    if (!(transitions instanceof Y.Map)) continue;
    for (const transition of transitions.values()) {
      if (!(transition instanceof Y.Map)) continue;
      const tracks = transition.get('tracks'); if (!(tracks instanceof Y.Map)) continue;
      const duration = keptDurations.has(transition) ? transition.get('duration') : fieldAfterUndo(manager, action, transition, 'duration');
      if (typeof duration !== 'number') continue;
      // Include live tracks with a restored channel as well as deleted whole
      // tracks. This rejects an invalid Redo before mutating either Yjs stack.
      for (const key of tracks._map.keys()) {
        const current = tracks.get(key);
        const track = current instanceof Y.Map && retainedTracks.has(current) ? current : fieldAfterStep(manager, action, tracks, key);
        if (track instanceof Y.Map && projectedTrackEnd(manager, action, track, retainedTracks.has(track), retainedTracks) > duration) {
          throw new Error(direction === 'undo' ? 'この時間設定は復元できません。現在の長さに合わせて改めて編集してください。' : '共同編集者が Transition を短くしたため、このアニメーションをやり直せません。現在の長さに合わせて改めて編集してください。');
        }
      }
    }
  }
}

function protectedStep(manager: EditorUndoManager, direction: 'undo' | 'redo', creations: ReturnType<typeof sharedCreations>, durations: Set<Y.Map<unknown>>) {
  const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
  const action = stack.at(-1)!, previousDeletions = action.deletions;
  const omitted = [...durations].flatMap(transition => fieldHistory(transition, 'duration'));
  // Existing automatic parents have old base fields to restore. Preserve the
  // activated track exactly when a peer has since edited that activation.
  omitted.push(...[...creations.activatedTracks].flatMap(track => [...track._map.keys()].flatMap(key => fieldHistory(track, key))));
  // A reset channel stores null. Do not restore that old null over the shared
  // timing map before deleteFilter has a chance to retain its complete subtree.
  omitted.push(...[...creations.timingParents].flatMap(([track, keys]) => [...keys].flatMap(key => fieldHistory(track, key))));
  omitted.push(...[...creations.revivedCompositions].flatMap(composition => fieldHistory(composition, 'deleted')));
  if (omitted.length) action.deletions = withoutItems(previousDeletions, omitted);
  const priorFilter = manager.deleteFilter;
  manager.deleteFilter = item => {
    if (item.content instanceof Y.ContentType && item.content.type instanceof Y.Map && creations.containers.has(item.content.type)) return false;
    if (item.parentSub === 'duration' && item.parent instanceof Y.Map && durations.has(item.parent)) return false;
    if (item.parentSub === 'deleted' && item.parent instanceof Y.Map && creations.revivedCompositions.has(item.parent)) return false;
    if (item.parent instanceof Y.Array) {
      const entries = creations.orderEntries.get(item.parent);
      // One append can insert up to four IDs in a single Yjs Item. Retain that
      // entire creation batch rather than leave dangling partial array entries.
      if (entries && item.content.getContent().some(id => typeof id === 'string' && entries.has(id))) return false;
    }
    // Yjs visits children before their parent. Preserve complete subtrees,
    // including nested Bézier fields, so retained creations remain valid data.
    let type = item.content instanceof Y.ContentType ? item.content.type : item.parent;
    while (type instanceof Y.AbstractType) {
      if (type instanceof Y.Map && creations.roots.has(type)) return false;
      type = type._item?.parent ?? null;
    }
    return priorFilter(item);
  };
  // Yjs skips no-op actions. Inspect them separately so a superseded field
  // cannot skip into an unprotected creation, and a retained action never
  // silently undoes/redoes the user's previous action as well.
  const earlier = stack.splice(0, stack.length - 1);
  try { return manager[direction](); }
  finally {
    stack.unshift(...earlier);
    manager.deleteFilter = priorFilter;
    action.deletions = previousDeletions;
  }
}

/** Undo one local action; retain shared creations and report their track count. */
export function undoPreservingPeerTracks(manager: EditorUndoManager): number {
  manager.lastUndoPreservedAudioTracks = 0;
  manager.lastUndoPreservedObjects = 0;
  manager.lastUndoPreservedDurations = 0;
  manager.lastUndoPreservedCompositions = 0;
  while (manager.canUndo()) {
    const protectedCreations = sharedCreations(manager);
    const durations = requiredDurations(manager, protectedCreations, manager.undoStack.at(-1)!);
    assertRestoredTracksFit(manager, manager.undoStack.at(-1)!, durations, 'undo', protectedCreations.roots);
    const result = protectedStep(manager, 'undo', protectedCreations, durations);
    if (protectedCreations.roots.size || durations.size) {
      for (const track of protectedCreations.dependentTracks) manager.retainedCreationTracks.add(track);
      manager.lastUndoPreservedAudioTracks = protectedCreations.audioTracks;
      manager.lastUndoPreservedObjects = protectedCreations.objects;
      manager.lastUndoPreservedDurations = durations.size;
      manager.lastUndoPreservedCompositions = protectedCreations.compositions;
      manager.stopCapturing(); return protectedCreations.tracks;
    }
    if (result) return 0;
    // Preserve Yjs's usual handling of other no-op Undo items.
  }
  return 0;
}

/** Cancel only the active gesture, even when a peer superseded all its edits. */
export function rollbackGesture(manager: EditorUndoManager, expected: object): boolean {
  if (manager.undoStack.at(-1) !== expected) return false;
  // Normal Undo deliberately skips empty items. A canceled gesture must never
  // reach an older action, so hide that history until protected Undo returns.
  const earlier = manager.undoStack.splice(0, manager.undoStack.length - 1);
  const earlierRedo = manager.redoStack.splice(0);
  let completed = false;
  try {
    undoPreservingPeerTracks(manager);
    completed = true;
    return true;
  } finally {
    manager.undoStack.unshift(...earlier);
    try {
      // The reverted drag is not a user-requested Undo and must not be Redoable.
      // Preserve any unrelated Redo entries that existed before cancellation.
      if (completed) manager.clear(false, true);
    } finally {
      manager.redoStack.unshift(...earlierRedo);
      manager.stopCapturing();
    }
  }
}

/** Redo normally unless a shorter duration would truncate a peer's animation. */
export function redoPreservingPeerDurations(manager: EditorUndoManager): number {
  const creations = { roots: new Set<Y.Map<unknown>>(), activatedTracks: new Set<Y.Map<unknown>>(), timingParents: new Map<Y.Map<unknown>, Set<string>>(), containers: new Set<Y.Map<unknown>>(), audioTracks: 0, dependentTracks: new Set<Y.Map<unknown>>(), orderEntries: new Map<Y.Array<unknown>, Set<string>>(), revivedCompositions: new Set<Y.Map<unknown>>(), objects: 0, tracks: 0, compositions: 0 };
  while (manager.canRedo()) {
    const action = manager.redoStack.at(-1)!;
    const durations = requiredDurations(manager, creations, action);
    assertRestoredTracksFit(manager, action, durations);
    const result = protectedStep(manager, 'redo', creations, durations);
    if (durations.size) { manager.stopCapturing(); return durations.size; }
    if (result) return 0;
  }
  return 0;
}
