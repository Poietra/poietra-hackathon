import * as Y from 'yjs';
import { getShared, LOCAL_ORIGIN } from '../../shared/document';

export class EditorUndoManager extends Y.UndoManager {
  readonly peerEditedTracks = new WeakSet<Y.Map<unknown>>();
  readonly peerEditedObjects = new WeakSet<Y.Map<unknown>>();
  readonly retainedCreationTracks = new WeakSet<Y.Map<unknown>>();
  lastUndoPreservedObjects = 0;
  lastUndoPreservedDurations = 0;
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
          if (collection === 'tracks' && value instanceof Y.Map) this.peerEditedTracks.add(value);
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
  const protectedTracks = new Set<Y.Map<unknown>>();
  const protectedObjects = new Set<Y.Map<unknown>>();
  const dependentTracks = new Set<Y.Map<unknown>>();
  const roots = new Set<Y.Map<unknown>>();
  const scenes = manager.doc.getMap('project').get('scenes');
  if (action && scenes instanceof Y.Map) for (const scene of scenes.values()) {
    if (!(scene instanceof Y.Map)) continue;
    // Yjs's integrated _item identifies each map in the Undo insertion clocks.
    // Keep this dependency on Item metadata local to creation detection.
    const added = (value: unknown) => value instanceof Y.Map && !!value._item && Y.isDeleted(action.insertions, value._item.id);
    const objects = scene.get('objects');
    const compositions = scene.get('compositions');
    const transitions = scene.get('transitions');
    if (objects instanceof Y.Map && !added(objects)) for (const [id, object] of objects) {
      if (!(object instanceof Y.Map) || !added(object) || !manager.peerEditedObjects.has(object)) continue;
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
    if (!(transitions instanceof Y.Map)) continue;
    for (const transition of transitions.values()) {
      const tracks = transition instanceof Y.Map ? transition.get('tracks') : null;
      // Limit this rule to tracks added to an existing transition. In particular,
      // keep Scene/Composition creation and their Undo semantics unchanged.
      if (!(tracks instanceof Y.Map) || !tracks._item || Y.isDeleted(action.insertions, tracks._item.id)) continue;
      for (const track of tracks.values()) {
        if (track instanceof Y.Map && added(track) && manager.peerEditedTracks.has(track)) { protectedTracks.add(track); dependentTracks.add(track); roots.add(track); }
      }
    }
  }
  return { roots, dependentTracks, tracks: protectedTracks.size, objects: protectedObjects.size };
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
        const timing = (key: string) => creations.roots.has(track) ? track.get(key) : fieldAfterUndo(manager, action, track, key);
        const start = timing('start'), length = timing('duration');
        if (typeof start === 'number' && typeof length === 'number' && start + length > duration) protectedDurations.add(transition);
      }
    }
  }
  return protectedDurations;
}

function assertRestoredTracksFit(manager: EditorUndoManager, action: UndoAction, keptDurations: Set<Y.Map<unknown>>) {
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
      // Deleted track maps are absent from values(), but Yjs retains their map
      // Items for Redo. Only inspect the current key Item: a peer replacement
      // prevents Yjs from restoring the old map and must remain authoritative.
      for (const item of tracks._map.values()) {
        if (!item.deleted || !Y.isDeleted(action.deletions, item.id) || Y.isDeleted(action.insertions, item.id) || !(item.content instanceof Y.ContentType) || !(item.content.type instanceof Y.Map)) continue;
        const track = item.content.type;
        const restored = (key: string) => fieldHistory(track, key)
          .find(value => Y.isDeleted(action.deletions, value.id) && !Y.isDeleted(action.insertions, value.id))?.content.getContent()[0];
        const start = restored('start'), length = restored('duration');
        if (typeof start === 'number' && typeof length === 'number' && start + length > duration) {
          throw new Error('共同編集者が Transition を短くしたため、このアニメーションをやり直せません。現在の長さに合わせて改めて編集してください。');
        }
      }
    }
  }
}

function protectedStep(manager: EditorUndoManager, direction: 'undo' | 'redo', roots: Set<Y.Map<unknown>>, durations: Set<Y.Map<unknown>>) {
  const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
  const action = stack.at(-1)!, previousDeletions = action.deletions;
  if (durations.size) action.deletions = withoutItems(previousDeletions, [...durations].flatMap(transition => fieldHistory(transition, 'duration')));
  const priorFilter = manager.deleteFilter;
  manager.deleteFilter = item => {
    if (item.parentSub === 'duration' && item.parent instanceof Y.Map && durations.has(item.parent)) return false;
    // Yjs visits children before their parent. Preserve complete subtrees,
    // including nested Bézier fields, so retained creations remain valid data.
    let type = item.content instanceof Y.ContentType ? item.content.type : item.parent;
    while (type instanceof Y.AbstractType) {
      if (type instanceof Y.Map && roots.has(type)) return false;
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
  manager.lastUndoPreservedObjects = 0;
  manager.lastUndoPreservedDurations = 0;
  while (manager.canUndo()) {
    const protectedCreations = sharedCreations(manager);
    const durations = requiredDurations(manager, protectedCreations, manager.undoStack.at(-1)!);
    const result = protectedStep(manager, 'undo', protectedCreations.roots, durations);
    if (protectedCreations.roots.size || durations.size) {
      for (const track of protectedCreations.dependentTracks) manager.retainedCreationTracks.add(track);
      manager.lastUndoPreservedObjects = protectedCreations.objects;
      manager.lastUndoPreservedDurations = durations.size;
      manager.stopCapturing(); return protectedCreations.tracks;
    }
    if (result) return 0;
    // Preserve Yjs's usual handling of other no-op Undo items.
  }
  return 0;
}

/** Redo normally unless a shorter duration would truncate a peer's animation. */
export function redoPreservingPeerDurations(manager: EditorUndoManager): number {
  const creations = { roots: new Set<Y.Map<unknown>>(), dependentTracks: new Set<Y.Map<unknown>>(), objects: 0, tracks: 0 };
  while (manager.canRedo()) {
    const action = manager.redoStack.at(-1)!;
    const durations = requiredDurations(manager, creations, action);
    assertRestoredTracksFit(manager, action, durations);
    const result = protectedStep(manager, 'redo', creations.roots, durations);
    if (durations.size) { manager.stopCapturing(); return durations.size; }
    if (result) return 0;
  }
  return 0;
}
