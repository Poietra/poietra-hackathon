import * as Y from 'yjs';
import { getShared, LOCAL_ORIGIN } from '../../shared/document';

export class EditorUndoManager extends Y.UndoManager {
  readonly peerEditedTracks = new WeakSet<Y.Map<unknown>>();
  private readonly root: Y.Map<unknown>;
  private readonly rememberPeerEdits = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (transaction.local) return;
    for (const event of events) {
      const path = event.path;
      if (path.length < 6 || path[0] !== 'scenes' || path[2] !== 'transitions' || path[4] !== 'tracks') continue;
      const track = getShared(this.doc, path.slice(0, 6).map(String));
      if (track instanceof Y.Map) this.peerEditedTracks.add(track);
    }
  };
  constructor(doc: Y.Doc) {
    const root = doc.getMap('project');
    super(root, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 });
    this.root = root;
    // Observe from the beginning, including offline updates delivered at reconnect.
    // A later local field Undo recreates a peer's value with a local Item ID, so
    // current Item authorship alone cannot tell whether a track was shared.
    root.observeDeep(this.rememberPeerEdits);
  }
  override destroy() {
    this.root.unobserveDeep(this.rememberPeerEdits);
    super.destroy();
  }
}

function sharedCreatedTracks(manager: EditorUndoManager) {
  const action = manager.undoStack.at(-1);
  const protectedTracks = new Set<Y.Map<unknown>>();
  const scenes = manager.doc.getMap('project').get('scenes');
  if (action && scenes instanceof Y.Map) for (const scene of scenes.values()) {
    const transitions = scene instanceof Y.Map ? scene.get('transitions') : null;
    if (!(transitions instanceof Y.Map)) continue;
    for (const transition of transitions.values()) {
      const tracks = transition instanceof Y.Map ? transition.get('tracks') : null;
      // Yjs's integrated _item identifies each map in the Undo insertion clocks.
      // Keep this Item-metadata dependency local to track creation detection.
      // Limit this rule to tracks added to an existing transition. In particular,
      // keep Scene/Composition creation and their Undo semantics unchanged.
      if (!(tracks instanceof Y.Map) || !tracks._item || Y.isDeleted(action.insertions, tracks._item.id)) continue;
      for (const track of tracks.values()) {
        if (track instanceof Y.Map && track._item && Y.isDeleted(action.insertions, track._item.id) && manager.peerEditedTracks.has(track)) protectedTracks.add(track);
      }
    }
  }
  return protectedTracks;
}

/** Undo one local action; return how many shared new tracks were retained. */
export function undoPreservingPeerTracks(manager: EditorUndoManager): number {
  while (manager.canUndo()) {
    const protectedTracks = sharedCreatedTracks(manager);
    const priorFilter = manager.deleteFilter;
    manager.deleteFilter = item => {
      // Yjs visits children before their parent. Preserve the complete track,
      // including nested Bézier fields, so retained tracks remain valid data.
      let type = item.content instanceof Y.ContentType ? item.content.type : item.parent;
      while (type instanceof Y.AbstractType) {
        if (type instanceof Y.Map && protectedTracks.has(type)) return false;
        type = type._item?.parent ?? null;
      }
      return priorFilter(item);
    };
    // Yjs skips no-op actions. Inspect each action separately so that an edit
    // superseded by a peer cannot skip into an unprotected track creation, and
    // preserving a whole track never also undoes the user's previous edit.
    const earlier = manager.undoStack.splice(0, manager.undoStack.length - 1);
    let result;
    try { result = manager.undo(); }
    finally {
      manager.undoStack.unshift(...earlier);
      manager.deleteFilter = priorFilter;
    }
    if (protectedTracks.size) { manager.stopCapturing(); return protectedTracks.size; }
    if (result) return 0;
    // Preserve Yjs's usual handling of other no-op Undo items.
  }
  return 0;
}
